"""Локальный TTS-воркер Amadeus: Silero TTS (v5, русский) — лёгкий базовый синтезатор.

Генерирует русскую речь из текста (модель Silero v5, speaker вида v5_xx_ru).

Протокол: по строке JSON на stdin / stdout.

  -> {"cmd":"speak","text":"...","out":"...wav","language":"ru","speaker":"v5_6_ru","sampleRate":24000}
  <- {"ok":true,"out":"...wav","ms":640,"sampleRate":24000,"audioSec":2.2}
  <- {"ok":false,"error":"..."}

  -> {"cmd":"ping"}   <- {"ok":true,"pong":true}
  -> {"cmd":"quit"}

Запуск:
  python silero_worker.py <папка_с_моделью_silero> <язык> <speaker>

Модель Silero v5 качается из models.silero.ai в <папка_с_моделью> при первом запуске,
после этого работает офлайн (torch.package). CPU достаточно — видеокарта не нужна.
"""

import json
import os
import sys
import time
import traceback
import wave

# Оффлайн: модель уже лежит локально, в сеть не ходим (кроме первой загрузки модели).
real_stdout = sys.stdout
sys.stdout = sys.stderr  # библиотеки печатают в stdout — уводим в stderr


def emit(obj):
    real_stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    real_stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def save_wav(audio, sample_rate, path):
    import numpy as np

    if hasattr(audio, "detach"):
        audio = audio.detach().to("cpu").float().numpy()
    arr = np.asarray(audio, dtype=np.float32).squeeze()
    while arr.ndim > 1:
        arr = arr.mean(axis=int(np.argmin(arr.shape)))
    arr = np.clip(arr, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes((arr * 32767.0).astype("<i2").tobytes())
    return len(arr) / float(sample_rate)


def load_model(model_path, language, speaker):
    import torch

    device = torch.device("cpu")
    torch.set_num_threads(4)
    if not os.path.isfile(model_path):
        url = f"https://models.silero.ai/models/tts/{language}/{speaker}.pt"
        log(f"[silero] качаю модель: {url}")
        torch.hub.download_url_to_file(url, model_path)
    log(f"[silero] грузим модель: {model_path} ({language}, speaker={speaker})")
    model = torch.package.PackageImporter(model_path).load_pickle("tts_models", "model")
    model.to(device)
    return model


def pick_speaker(model, requested):
    """v5: speaker — это голос (baya, kseniya, ...), а не ID модели (v5_6_ru)."""
    speakers = list(getattr(model, "speakers", []) or [])
    if not speakers:
        return requested
    if requested in speakers:
        return requested
    for name in ("baya", "kseniya", "xenia"):
        if name in speakers:
            return name
    return speakers[0]


def main():
    model_path = sys.argv[1] if len(sys.argv) > 1 else ""
    default_lang = sys.argv[2] if len(sys.argv) > 2 else "ru"
    default_speaker = sys.argv[3] if len(sys.argv) > 3 else "baya"

    if not model_path or not os.path.isfile(model_path):
        emit({"ok": False, "error": f"нет модели Silero: {model_path}"})
        return 1

    t0 = time.time()
    try:
        model = load_model(model_path, default_lang, default_speaker)
    except Exception:
        emit({"ok": False, "error": "не удалось загрузить Silero: " + traceback.format_exc(limit=4)})
        return 1
    picked = pick_speaker(model, default_speaker)
    if picked != default_speaker:
        log(f"[silero] голос {default_speaker!r} не входит в модель, использую {picked!r}")
    default_speaker = picked
    sample_rate = int(sys.argv[4]) if len(sys.argv) > 4 else 24000
    log(f"[silero] модель загружена за {time.time() - t0:.1f}с (sampleRate={sample_rate} Гц)")

    emit({"ok": True, "ready": True, "sampleRate": sample_rate, "loadMs": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"ok": False, "error": "плохой JSON"})
            continue

        cmd = req.get("cmd", "speak")
        if cmd == "quit":
            break
        if cmd == "ping":
            emit({"ok": True, "pong": True})
            continue
        if cmd != "speak":
            emit({"ok": False, "error": f"неизвестная команда: {cmd}"})
            continue

        text = (req.get("text") or "").strip()
        out = req.get("out") or ""
        if not text:
            emit({"ok": False, "error": "пустой текст"})
            continue
        if not out:
            emit({"ok": False, "error": "не указан выходной файл"})
            continue

        speaker = (req.get("speaker") or default_speaker).strip()
        speaker = pick_speaker(model, speaker)
        sr = int(req.get("sampleRate") or sample_rate)
        kwargs = {
            "text": text,
            "speaker": speaker,
            "sample_rate": sr,
            "put_accent": bool(req.get("put_accent", True)),
            "put_yo": bool(req.get("put_yo", True)),
            "put_stress_homo": bool(req.get("put_stress_homo", True)),
            "put_yo_homo": bool(req.get("put_yo_homo", True)),
        }
        t = time.time()
        try:
            import torch

            if req.get("seed"):
                torch.manual_seed(int(req["seed"]))
            audio = model.apply_tts(**kwargs)
            dur = save_wav(audio, sr, out)
            took = time.time() - t
            log(f"[silero] {dur:.2f}с речи за {took:.2f}с")
            emit({"ok": True, "out": out, "ms": int(took * 1000), "sampleRate": sr, "audioSec": round(dur, 3)})
        except Exception:
            emit({"ok": False, "error": traceback.format_exc(limit=5)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
