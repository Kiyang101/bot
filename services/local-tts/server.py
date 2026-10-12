"""Loopback-only Wayu service. Inference is serial; health checks stay responsive."""
from __future__ import annotations

import argparse
from array import array
import io
import json
import logging
import math
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_VOICE = "f_young_clear"
MODEL_REPO = "wayu-ai/wayu-paxa-tts-edge"
MODEL_DIR = Path(__file__).resolve().parents[2] / ".local-voice" / "model"
LOG = logging.getLogger("local-tts")


def encode_wav(samples, sample_rate: int) -> bytes:
    if sample_rate != 24000:
        raise ValueError("Expected 24 kHz model output")
    pcm = array("h")
    for sample in samples:
        value = float(sample)
        if not math.isfinite(value):
            raise ValueError("Model returned invalid audio")
        pcm.append(round(max(-1, min(1, value)) * 32767))
    if not pcm:
        raise ValueError("Model returned empty audio")
    if sys.byteorder != "little":
        pcm.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


def load_model(model_dir: Path):
    # All downloads belong to setup, never to a running inference server.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not (model_dir / "model.pth").is_file():
        raise RuntimeError("Model missing. Run scripts/local-voice.ps1 download first.")
    from wayu_tts import ThaiTTS
    return ThaiTTS.from_pretrained(str(model_dir), device="cpu")


def download(model_dir: Path):
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id=MODEL_REPO, local_dir=str(model_dir))
    # Misaki's English frontend can fetch assets lazily. Warm all supported routes online.
    from wayu_tts import ThaiTTS
    model = ThaiTTS.from_pretrained(str(model_dir), device="cpu")
    for text in ("สวัสดีครับ", "Hello, how are you?", "วันนี้ใช้ Discord คุยกัน"):
        audio = model(text, voice=DEFAULT_VOICE, speed=1.0)
        encode_wav(audio, model.sample_rate)
    LOG.info("Model and Thai/English frontend assets are ready")


def create_server(model, port: int = 8788, default_voice: str = DEFAULT_VOICE):
    if default_voice not in model.voices:
        raise ValueError(f"Unknown default voice: {default_voice}")
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def send(self, status: int, payload: bytes, content_type: str = "application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def error(self, status: int, message: str):
            self.send(status, json.dumps({"error": message}).encode())

        def do_GET(self):
            if self.path != "/health":
                self.error(404, "Not found")
                return
            self.send(200, json.dumps({
                "status": "ok", "device": "cpu", "sample_rate": model.sample_rate,
                "voice": default_voice, "voices": model.voices, "busy": lock.locked(),
            }).encode())

        def do_POST(self):
            if self.path != "/synthesize":
                self.error(404, "Not found")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 16384:
                    self.error(413, "Request body must be 1..16384 bytes")
                    return
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Expected a JSON object")
                text = body.get("text")
                voice = body.get("voice", default_voice)
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError("text must be 1..2000 characters")
                if not isinstance(voice, str) or voice not in model.voices:
                    raise ValueError("Unknown voice")
            except (ValueError, UnicodeDecodeError) as error:
                self.error(400, str(error))
                return
            if not lock.acquire(blocking=False):
                self.error(503, "Synthesis is busy; try again later")
                return
            started = time.perf_counter()
            try:
                audio = model(text.strip(), voice=voice, speed=1.0)
                wav = encode_wav(audio, model.sample_rate)
            except Exception:
                LOG.exception("Synthesis failed")
                self.error(500, "Synthesis failed or produced no audio")
                return
            finally:
                lock.release()
            LOG.info("Synthesized %d characters in %.2fs (%d WAV bytes)",
                     len(text), time.perf_counter() - started, len(wav))
            self.send(200, wav, "audio/wav")

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--model-dir", type=Path, default=MODEL_DIR)
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.download:
        download(args.model_dir)
        return
    model = load_model(args.model_dir)
    server = create_server(model, args.port, os.getenv("LOCAL_TTS_VOICE") or DEFAULT_VOICE)
    LOG.info("Ready on http://127.0.0.1:%d (CPU, offline model loading)", args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
