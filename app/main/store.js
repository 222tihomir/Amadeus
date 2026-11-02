// Настройки, история диалога и долговременная память — JSON-файлы в userData.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  userName: 'Окабэ',
  language: 'ru',

  provider: 'web', // web (без ключа, сайт нейросети) | anthropic | openai | deepseek | opencode
  // Без ключа: вход на сайт нейросети один раз (через Chrome), куки сохраняются в профиле Amadeus.
  webSite: 'claude', // claude | chatgpt | deepseek | gemini | grok | qwen
  webVisionSite: 'claude', // через какой сайт смотреть скриншоты
  loginBrowser: 'auto', // auto (браузер по умолчанию, если он на Chromium) | chrome | edge | brave | yandex
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  openaiKey: '',
  openaiModel: 'gpt-4.1-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  deepseekKey: '',
  deepseekModel: 'deepseek-chat',
  // OpenCode (локальное приложение): ключ не нужен, модели — из `opencode models`.
  opencodeModel: 'opencode/glm-5.3-flash-free',
  opencodeCli: '', // пусто — найти opencode-cli.exe автоматически
  temperature: 0.9,
  // Каждые N ответов разговор пересказывается, и дальше нейросеть получает пересказ + последние
  // реплики, а не всю переписку (на сайте при этом начинается новый чат).
  summarizeEvery: 25,
  personaPrompt: '', // характер Курису; пусто — стандартный (main/persona.js)

  // Доступ к компьютеру (main/tools.js): только по твоей просьбе или с твоего разрешения.
  toolsEnabled: true,
  toolsAutoSafe: true, // открыть/прочитать/посмотреть папку по твоей просьбе — без карточки подтверждения
  toolsAutoChanges: false, // изменить файл/выполнить команду по твоей просьбе — без карточки (выкл: всегда спрашивать)

  // Скриншоты: каждые N минут Amadeus смотрит на экран и решает, говорить ли.
  screenshotMinutes: 2, // 0 = выключено
  visionProvider: 'auto', // auto | web | anthropic | openai (DeepSeek API картинки не видит)

  // Озвучка: локально через OmniVoice (по умолчанию) или через VoiceStudio.
  // silero — «лёгкий» backend: Silero (русский TTS) → RVC (Курису), если RVC настроен.
  ttsEnabled: true,
  ttsBackend: 'local', // local (OmniVoice напрямую) | voicestudio (HTTP-API приложения) | silero (Silero → RVC)
  // Пути к моделям и окружению задаются в настройках: в репозитории их нет.
  ttsPython: '', // python.exe из venv, где установлен OmniVoice
  ttsModelDir: '', // папка с моделью OmniVoice
  ttsRefAudio: '', // аудио с голосом для клонирования
  ttsRefTextFile: '', // текст, который произнесён в референсе
  ttsSteps: 16, // шагов генерации: меньше — быстрее, больше — чуть точнее
  voiceStudioUrl: 'http://127.0.0.1:3900',
  voice: 'Курису2', // имя или id профиля голоса в VoiceStudio
  ttsEngine: '', // пусто = движок, выбранный в VoiceStudio
  ttsEmotion: true, // передавать эмоцию в TTS (instruct + скорость)
  volume: 0.9,

  // Silero v5 (русский TTS): базовый синтез, дальше RVC (см. блок «Голос Курису»).
  sileroPython: '', // python.exe из venv с Silero
  sileroModel: '', // файл silero_tts_ru_v5.pt
  sileroSpeaker: 'baya',
  sileroLanguage: 'ru',

  // Обученная модель голоса (RVC из Applio): звук VoiceStudio прогоняется через неё.
  // По умолчанию выключено; требует отдельного окружения Applio (в репозиторий не входит).
  rvcEnabled: false,
  rvcPython: '',
  rvcRoot: '',
  rvcPth: '',
  rvcIndex: '',
  rvcPitch: 0, // полутона: 0 — как есть, +12 — на октаву выше
  rvcIndexRate: 0.75, // насколько сильно подмешивать тембр из индекса
  rvcProtect: 0.33, // защита согласных от искажений

  // Распознавание речи
  sttProvider: 'voicestudio', // voicestudio | openai
  micHotkey: 'Control+Alt+A',

  // Внешний вид
  outfit: 'coat', // coat (белый халат) | jacket (без халата) | amadeus
  framing: 'bust', // bust | waist | full
  phoneFrame: true, // true — корпус телефона (рамка); false — без рамки, Курису на весь экран
  windowScale: 100, // размер всего окна, % (всё масштабируется пропорционально)
  charScale: 100, // размер Курису внутри экрана, % (Ctrl + колесо мыши над ней)
  charOffsetY: 0, // сдвиг Курису вверх/вниз, % высоты экрана
  alwaysOnTop: true,
  bootAnimation: true,
};

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file(name));
}

let settings = null;

module.exports = {
  DEFAULT_SETTINGS,
  getSettings() {
    if (!settings) {
      // Только известные ключи: устаревшие (например, от Aihub) отбрасываются.
      const saved = readJson('settings.json', {});
      settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in saved) settings[k] = saved[k];
      if (!['web', 'anthropic', 'openai', 'deepseek', 'opencode'].includes(settings.provider)) settings.provider = 'web';
      if (!['auto', 'web', 'anthropic', 'openai', 'opencode'].includes(settings.visionProvider)) settings.visionProvider = 'auto';
      if (Object.keys(saved).some((k) => !(k in DEFAULT_SETTINGS))) writeJson('settings.json', settings);
    }
    return settings;
  },
  setSettings(patch) {
    settings = { ...module.exports.getSettings(), ...patch };
    writeJson('settings.json', settings);
    return settings;
  },
  getHistory: () => readJson('history.json', []),
  setHistory: (h) => writeJson('history.json', h),
  // Пересказ старой части разговора: text — пересказ, upto — ts последнего пересказанного сообщения.
  getSummary: () => readJson('summary.json', { text: '', upto: 0 }),
  setSummary: (s) => writeJson('summary.json', s),
  getMemory: () => readJson('memory.json', []),
  setMemory: (m) => writeJson('memory.json', m),
  getWindowBounds: () => readJson('window.json', null),
  setWindowBounds: (b) => writeJson('window.json', b),
};
