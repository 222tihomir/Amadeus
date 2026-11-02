"""Локальный TTS-воркер Amadeus: OmniVoice напрямую, без приложения VoiceStudio.

Держит модель в памяти и синтезирует реплики по одной.
Протокол: по строке JSON на stdin / stdout.

  -> {"cmd":"speak","text":"...","out":"...wav","language":"ru","steps":16,"speed":1.0}
  <- {"ok":true,"out":"...wav","ms":640,"sampleRate":24000,"audioSec":2.2}
  <- {"ok":false,"error":"..."}

  -> {"cmd":"ping"}   <- {"ok":true,"pong":true}
  -> {"cmd":"quit"}

Запуск:
  python tts_worker.py <папка модели> <референс.wav|ogg> <референс.txt> [язык]

Первый запуск: импорт torch/omnivoice ~4 с, загрузка модели ~2 с, сборка
голосового промпта из референса ~12 с. Дальше каждая фраза — доли секунды.
"""

import hashlib
import json
import os
import sys
import time
import traceback
import wave

# Оффлайн: модель уже лежит локально, в сеть не ходим.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

real_stdout = sys.stdout
sys.stdout = sys.stderr  # библиотеки печатают в stdout — уводим в stderr


def emit(obj):
    real_stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    real_stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def save_wav(audio, sample_rate, path):
    import numpy as np

    arr = audio.detach().to("cpu").float().numpy().squeeze()
    arr = np.asarray(arr, dtype=np.float32)
    while arr.ndim > 1:
        arr = arr.mean(axis=int(np.argmin(arr.shape)))
    arr = np.clip(arr, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes((arr * 32767.0).astype("<i2").tobytes())
    return len(arr) / float(sample_rate)


def prompt_cache_path(model_dir, ref_audio, ref_text):
    """Кэш голосового промпта: меняется референс/модель — меняется имя файла."""
    parts = [os.path.abspath(model_dir), ref_text]
    for path in (ref_audio, os.path.join(model_dir, "model.safetensors"), os.path.join(model_dir, "config.json")):
        try:
            st = os.stat(path)
        except OSError:
            continue
        parts += [os.path.abspath(path), str(st.st_size), str(int(st.st_mtime))]
    key = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]
    root = os.path.dirname(os.path.dirname(os.path.abspath(ref_audio)))
    return os.path.join(root, "cache", f"prompt-{key}.pt")


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else ""
    ref_audio = sys.argv[2] if len(sys.argv) > 2 else ""
    ref_text_path = sys.argv[3] if len(sys.argv) > 3 else ""
    default_lang = sys.argv[4] if len(sys.argv) > 4 else "ru"

    for path, what in ((model_dir, "папка модели"), (ref_audio, "референс"), (ref_text_path, "текст референса")):
        if not path or not os.path.exists(path):
            emit({"ok": False, "error": f"нет файла: {what} — {path}"})
            return 1

    with open(ref_text_path, "r", encoding="utf-8") as f:
        ref_text = f.read().strip()
    if not ref_text:
        emit({"ok": False, "error": "пустой текст референса"})
        return 1

    t0 = time.time()
    try:
        import torch
        from omnivoice import OmniVoice

        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = OmniVoice.from_pretrained(model_dir, device_map=device, dtype=dtype, load_asr=False)
    except Exception:
        emit({"ok": False, "error": "не удалось загрузить OmniVoice: " + traceback.format_exc(limit=4)})
        return 1
    sample_rate = int(getattr(model, "sampling_rate", 24000))
    log(f"[tts] модель загружена за {time.time() - t0:.1f}с ({device}, {sample_rate} Гц)")

    t1 = time.time()
    cache = prompt_cache_path(model_dir, ref_audio, ref_text)
    prompt = None
    if os.path.exists(cache):
        try:
            from omnivoice.models.omnivoice import VoiceClonePrompt

            prompt = VoiceClonePrompt.load(cache)
            log(f"[tts] промпт из кэша за {time.time() - t1:.1f}с")
        except Exception:
            log("[tts] кэш промпта не подошёл: " + traceback.format_exc(limit=2))
    if prompt is None:
        try:
            prompt = model.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text, preprocess_prompt=True)
        except Exception:
            emit({"ok": False, "error": "не удалось собрать голосовой промпт: " + traceback.format_exc(limit=4)})
            return 1
        log(f"[tts] промпт из референса за {time.time() - t1:.1f}с")
        try:
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            prompt.save(cache)
        except Exception:
            log("[tts] не удалось сохранить кэш промпта: " + traceback.format_exc(limit=2))

    # Первая генерация подгружает ядра CUDA — делаем её заранее на короткой фразе.
    t2 = time.time()
    try:
        model.generate(text="Проверка.", language=default_lang, voice_clone_prompt=prompt, num_step=16)
        log(f"[tts] прогрев генерации за {time.time() - t2:.1f}с")
    except Exception:
        log("[tts] прогрев не удался: " + traceback.format_exc(limit=2))

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

        kwargs = {
            "text": text,
            "language": req.get("language") or default_lang,
            "voice_clone_prompt": prompt,
            "num_step": int(req.get("steps") or 16),
        }
        if req.get("speed"):
            kwargs["speed"] = float(req["speed"])
        if req.get("instruct"):
            kwargs["instruct"] = req["instruct"]

        t = time.time()
        try:
            if req.get("seed"):
                torch.manual_seed(int(req["seed"]))
            audios = model.generate(**kwargs)
            audio = audios[0] if isinstance(audios, (list, tuple)) else audios
            dur = save_wav(audio, sample_rate, out)
            took = time.time() - t
            log(f"[tts] {dur:.2f}с речи за {took:.2f}с")
            emit({"ok": True, "out": out, "ms": int(took * 1000), "sampleRate": sample_rate, "audioSec": round(dur, 3)})
        except Exception:
            emit({"ok": False, "error": traceback.format_exc(limit=5)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
