"""Real local-model smoke test; rejects non-loopback Python network connections."""
import ctypes
import json
import socket
import subprocess
import time
from pathlib import Path
from unittest.mock import patch

from server import DEFAULT_VOICE, MODEL_DIR, encode_wav, load_model


def memory_mb():
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                "PagefileUsage", "PeakPagefileUsage")]

    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.windll.kernel32
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    query = ctypes.windll.psapi.GetProcessMemoryInfo
    query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    if not query(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return {"ram_mb": round(counters.WorkingSetSize / 1024**2, 1),
            "peak_ram_mb": round(counters.PeakWorkingSetSize / 1024**2, 1)}


def main():
    connect = socket.socket.connect
    getaddrinfo = socket.getaddrinfo

    def local_connect(sock, address):
        if address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise RuntimeError(f"Unexpected outbound network connection: {address[0]}")
        return connect(sock, address)

    def local_dns(host, *args, **kwargs):
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise RuntimeError(f"Unexpected outbound DNS lookup: {host}")
        return getaddrinfo(host, *args, **kwargs)

    output = MODEL_DIR.parent / "smoke"
    output.mkdir(parents=True, exist_ok=True)
    results = []
    with patch.object(socket.socket, "connect", local_connect), patch.object(socket, "getaddrinfo", local_dns):
        started = time.perf_counter()
        model = load_model(MODEL_DIR)
        results.append({"stage": "model_load", "seconds": round(time.perf_counter() - started, 2)})
        examples = ["สวัสดีครับ วันนี้อากาศดีมาก", "Hello, how are you today?", "วันนี้ใช้ Discord คุยกับเพื่อน"]
        started = time.perf_counter()
        # Exercise the actual bot client, including Qwen's no-think compatibility path.
        code = """
const {completeChat} = require('./src/features/chat/ollama.ts');
completeChat([{role: 'user', content: 'สวัสดี ตอบสั้น ๆ หนึ่งประโยค'}])
  .then(answer => process.stdout.write(JSON.stringify(answer)))
  .catch(error => { console.error(error); process.exitCode = 1; });
"""
        run = subprocess.run(["node", "--import", "tsx", "-e", code],
                             cwd=MODEL_DIR.parents[1], capture_output=True,
                             text=True, encoding="utf-8", timeout=130, check=True)
        reply = json.loads(run.stdout)
        if not reply or "think>" in reply:
            raise RuntimeError("Ollama returned no final-only answer")
        results.append({"stage": "ollama", "seconds": round(time.perf_counter() - started, 2), "reply": reply})
        examples.append(reply[:1000])
        for index, text in enumerate(examples):
            started = time.perf_counter()
            wav = encode_wav(model(text, voice=DEFAULT_VOICE, speed=1.0), model.sample_rate)
            (output / f"speech-{index + 1}.wav").write_bytes(wav)
            result = {"stage": f"speech-{index + 1}", "text": text,
                      "seconds": round(time.perf_counter() - started, 2),
                      "audio_seconds": round((len(wav) - 44) / 48000, 2)}
            if hasattr(ctypes, "windll"):
                result.update(memory_mb())
            results.append(result)
    (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
