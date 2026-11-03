#!/usr/bin/env bash
# Запуск Amadeus на Linux/macOS. На Windows используйте Amadeus.bat.
set -euo pipefail

cd "$(dirname "$0")"

# Запускает Electron; если портативная сборка не смогла стартовать из-за sandbox
# (chrome-sandbox без setuid после распаковки), повторяет запуск с --no-sandbox.
run_app() {
  local electron="$1"
  shift
  local extra=()
  if [ "${AMADEUS_NO_SANDBOX:-0}" = "1" ]; then
    extra=(--no-sandbox)
  fi
  set +e
  "$electron" "${extra[@]}" "$@"
  local status=$?
  set -e
  if [ "$status" -ne 0 ] && [ "${#extra[@]}" -eq 0 ]; then
    echo "Electron завершился с кодом $status — пробую запуск с --no-sandbox." >&2
    exec "$electron" --no-sandbox "$@"
  fi
  exit "$status"
}

# Готовая Linux-сборка из Releases: рядом лежат electron и resources/app.
if [ -x "./electron" ] && [ -d "./resources/app" ]; then
  run_app ./electron resources/app "$@"
fi

# Запуск из исходников: Electron ставится в app/node_modules.
ELECTRON="app/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  ELECTRON="app/node_modules/.bin/electron"
fi

if [ ! -x "$ELECTRON" ]; then
  echo "Electron не найден." >&2
  echo "Установите зависимости: cd app && npm install" >&2
  exit 1
fi

run_app "$ELECTRON" app "$@"
