"""RVC-воркер для Amadeus.

Держит модель Курису загруженной и конвертирует WAV-файлы по одному.
Протокол: по строке JSON на stdin / stdout.

  -> {"cmd":"convert","in":"...wav","out":"...wav","pitch":0,"indexRate":0.75,"protect":0.33}
  <- {"ok":true,"out":"...wav","ms":1234}
  <- {"ok":false,"error":"..."}

  -> {"cmd":"ping"}   <- {"ok":true,"pong":true}
  -> {"cmd":"quit"}

Первый запуск: python rvc_worker.py <model.pth> <model.index> <папка Applio>
Все посторонние print/tqdm от RVC уходят в stderr, чтобы не ломать протокол.
"""
import json
import os
import sys
import time
import traceback

real_stdout = sys.stdout
sys.stdout = sys.stderr  # RVC печатает в stdout — уводим в stderr


def emit(obj):
    real_stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    real_stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ── Кэш FAISS-индекса ──
# Штатный pipeline читает .index и делает reconstruct_n() при каждом вызове.
# Индекс Курису ~450 МБ, поэтому кэшируем и сам индекс, и матрицу векторов:
# первая конверсия ~13 с, следующие — доли секунды.
class _CachedIndex:
    def __init__(self, index):
        self._index = index
        self._npy = None

    def reconstruct_n(self, a, b):
        if self._npy is None:
            self._npy = self._index.reconstruct_n(a, b)
        return self._npy

    def __getattr__(self, name):
        return getattr(self._index, name)


def _install_index_cache():
    import faiss

    original = faiss.read_index
    cache = {}

    def read_index_cached(path, *args, **kwargs):
        try:
            key = (os.path.abspath(path), os.path.getmtime(path), os.path.getsize(path))
        except OSError:
            return original(path, *args, **kwargs)
        if key not in cache:
            cache[key] = _CachedIndex(original(path, *args, **kwargs))
            log("[rvc] индекс загружен: %s" % path)
        return cache[key]

    faiss.read_index = read_index_cached


def main():
    pth = sys.argv[1] if len(sys.argv) > 1 else ""
    index = sys.argv[2] if len(sys.argv) > 2 else ""
    root = sys.argv[3] if len(sys.argv) > 3 else os.path.dirname(os.path.abspath(__file__))

    if not pth or not os.path.exists(pth):
        emit({"ok": False, "error": "нет модели: %s" % pth})
        return 1
    if root and os.path.isdir(root):
        sys.path.insert(0, root)
        os.chdir(root)

    warm_file = sys.argv[4] if len(sys.argv) > 4 else ""

    t0 = time.time()
    try:
        _install_index_cache()
        from rvc.infer.infer import VoiceConverter

        vc = VoiceConverter()
    except Exception:
        emit({"ok": False, "error": "не удалось загрузить RVC: " + traceback.format_exc(limit=3)})
        return 1
    log("[rvc] готов за %.1fс" % (time.time() - t0))
    emit({"ok": True, "ready": True})

    # Прогрев: первая конверсия подгружает HuBERT, rmvpe и индекс (~13 с).
    # Делаем её на коротком образце сразу, чтобы первая фраза не ждала.
    if warm_file and os.path.exists(warm_file):
        warm_out = os.path.join(os.path.dirname(os.path.abspath(warm_file)), "_rvc_warmup.wav")
        t_w = time.time()
        try:
            vc.convert_audio(
                audio_input_path=warm_file,
                audio_output_path=warm_out,
                model_path=pth,
                index_path=index,
                pitch=0,
                f0_method="rmvpe",
                index_rate=0.75,
                protect=0.33,
                export_format="WAV",
            )
            log("[rvc] прогрев за %.1fс" % (time.time() - t_w))
        except Exception:
            log("[rvc] прогрев не удался: " + traceback.format_exc(limit=2))
        finally:
            try:
                os.remove(warm_out)
            except OSError:
                pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"ok": False, "error": "плохой JSON"})
            continue

        cmd = req.get("cmd", "convert")
        if cmd == "quit":
            break
        if cmd == "ping":
            emit({"ok": True, "pong": True})
            continue
        if cmd != "convert":
            emit({"ok": False, "error": "неизвестная команда: %s" % cmd})
            continue

        src = req.get("in", "")
        dst = req.get("out", "")
        if not src or not os.path.exists(src):
            emit({"ok": False, "error": "нет входного файла: %s" % src})
            continue
        if not dst:
            emit({"ok": False, "error": "не указан выходной файл"})
            continue

        t1 = time.time()
        try:
            vc.convert_audio(
                audio_input_path=src,
                audio_output_path=dst,
                model_path=pth,
                index_path=req.get("index", index),
                pitch=int(req.get("pitch", 0)),
                f0_method=req.get("f0", "rmvpe"),
                index_rate=float(req.get("indexRate", 0.75)),
                protect=float(req.get("protect", 0.33)),
                export_format="WAV",
            )
            log("[rvc] %s -> %s за %.1fс" % (os.path.basename(src), os.path.basename(dst), time.time() - t1))
            emit({"ok": True, "out": dst, "ms": int((time.time() - t1) * 1000)})
        except Exception:
            emit({"ok": False, "error": traceback.format_exc(limit=4)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
