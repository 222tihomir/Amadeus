# Amadeus — приложение

Основная документация: [../README.md](../README.md).

Здесь лежит исходный код Electron-приложения.

## Запуск

```bat
npm install
npm start
```

`npm start` запускает Electron с `main/main.js`. Ярлык в корне репозитория (`Amadeus.bat`)
делает то же самое через локальный `node_modules`.

## Скрипты

- `npm start` — запуск приложения.
- `npm run sprites` — пересобрать спрайты из PNG в WebP (`tools/prepare_sprites.py`).
- `npm run phone` — собрать корпус телефона (`tools/make_phone.py`).
- `npm run ui` — собрать элементы интерфейса (`tools/make_ui.py`).

Для скриптов ассетов нужен Python с Pillow; исходники изображений в репозиторий не входят.

## Данные пользователя

Настройки, история, память, куки и резервные копии файлов хранятся в `%APPDATA%\Amadeus\`.
Они не коммитятся: см. `.gitignore` в корне.
