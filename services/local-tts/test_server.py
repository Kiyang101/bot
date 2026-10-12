import io
import json
import threading
import unittest
import urllib.error
import urllib.request
import wave

from server import create_server, encode_wav


class FakeModel:
    voices = ["f_young_clear", "m_young_clear"]
    sample_rate = 24000

    def __init__(self):
        self.samples = [0, 0.5, -0.5, 2, -2]
        self.calls = []

    def __call__(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return self.samples


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel()
        self.server = create_server(self.model, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def test_health_and_wav_contract(self):
        status, data, _ = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["device"], "cpu")
        for text in ("สวัสดี", "Hello", "วันนี้ใช้ Discord"):
            status, data, headers = self.request("/synthesize", {"text": text})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "audio/wav")
            with wave.open(io.BytesIO(data)) as wav:
                self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
                self.assertEqual(wav.getnframes(), 5)
        self.assertEqual(self.model.calls[-1][1], {"voice": "f_young_clear", "speed": 1.0})

    def test_validation_and_voice_override(self):
        for body in ({"text": " "}, {"text": "x" * 2001}, {"text": 3},
                     {"text": "hello", "voice": "missing"}, []):
            self.assertEqual(self.request("/synthesize", body)[0], 400)
        self.assertEqual(self.request("/synthesize", {"text": "Hi", "voice": "m_young_clear"})[0], 200)
        self.assertEqual(self.model.calls[-1][1]["voice"], "m_young_clear")
        self.assertEqual(self.request("/missing")[0], 404)

    def test_empty_audio_and_inference_failure(self):
        self.model.samples = []
        self.assertEqual(self.request("/synthesize", {"text": "hello"})[0], 500)
        self.model.samples = [float("nan")]
        self.assertEqual(self.request("/synthesize", {"text": "hello"})[0], 500)

    def test_health_stays_available_during_serial_inference(self):
        entered = threading.Event()
        release = threading.Event()
        original = FakeModel.__call__

        def blocked(model, *args, **kwargs):
            entered.set()
            release.wait(3)
            return original(model, *args, **kwargs)

        from unittest.mock import patch
        with patch.object(FakeModel, "__call__", blocked):
            worker = threading.Thread(target=lambda: self.request("/synthesize", {"text": "Hi"}))
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertTrue(json.loads(self.request("/health")[1])["busy"])
                self.assertEqual(self.request("/synthesize", {"text": "Again"})[0], 503)
            finally:
                release.set()
                worker.join()


if __name__ == "__main__":
    unittest.main()
