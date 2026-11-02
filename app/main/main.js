const path = require('path');
const {
  app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, screen, session, shell,
} = require('electron');
const store = require('./store');
const llm = require('./llm');
const voice = require('./voice');
const webchat = require('./webchat');
const browserlogin = require('./browserlogin');
const tools = require('./tools');
const { buildSystemPrompt, DEFAULT_PERSONA } = require('./persona');
const { BY_ID } = require('../shared/emotions');

let win = null;
// Пропорции корпуса телефона (assets/ui/phone.webp 400×784).
const PHONE_RATIO = 400 / 784;
const BASE_SIZE = { width: 360, height: Math.round(360 / PHONE_RATIO) };

// «Во весь экран» сделан вручную (setBounds на весь экран), а не через win.setFullScreen:
// на прозрачном окне без рамки нативный fullscreen на Windows работает ненадёжно —
// второе нажатие могло «ничего не делать», а полноэкранные bounds попадали в window.json.
let fullscreenOn = false; // сейчас окно развёрнуто на весь экран
let normalBounds = null; // положение/размер до входа в полноэкранный режим

// Похоже ли сохранённое положение на нормальное окно телефона.
// Отсекает следы полноэкранного режима (2560×1440) и окна, уехавшие за пределы экрана.
function isSaneBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
  if (b.width < 120 || b.height < 200) return false;
  const area = screen.getDisplayMatching(b).workArea;
  if (b.width >= area.width - 40 || b.height >= area.height - 40) return false;
  if (b.x + b.width < area.x + 40 || b.x > area.x + area.width - 40) return false;
  if (b.y + b.height < area.y + 40 || b.y > area.y + area.height - 40) return false;
  return true;
}

// Держит окно в пределах рабочей области (не даёт уехать за край при смене монитора).
function fitBounds(b) {
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
  };
}

function createWindow() {
  const s = store.getSettings();
  const area = screen.getPrimaryDisplay().workArea;
  const k = (s.windowScale || 100) / 100;
  // Окно тянется как обычное: корпус режется на куски и дорисовывается (renderer/app.js → drawFrame).
  // Сохранённые bounds принимаем, только если это нормальное окно телефона.
  const savedRaw = store.getWindowBounds();
  const saved = isSaneBounds(savedRaw) ? fitBounds(savedRaw) : null;
  const width = saved?.width || Math.round(BASE_SIZE.width * k);
  const height = saved?.height || Math.round(width / PHONE_RATIO);
  // По умолчанию — правый нижний угол экрана, как в прежней версии.
  const bounds = {
    width,
    height,
    x: saved?.x ?? area.x + area.width - width - 40,
    y: saved?.y ?? area.y + area.height - height - 20,
  };

  win = new BrowserWindow({
    ...bounds,
    minWidth: 160,
    minHeight: 260,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: s.alwaysOnTop,
    backgroundColor: '#00000000',
    title: 'Amadeus',
    icon: path.join(__dirname, '..', 'assets', 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Если сохранённое положение было битым — сразу заменяем его нормальным,
  // иначе следующий запуск снова прочитает мусор.
  if (!saved) store.setWindowBounds(fitBounds(bounds));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(k));

  let saveTimer = null;
  const saveBounds = () => {
    if (!win || fullscreenOn) return; // в полноэкранном режиме bounds не запоминаем
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || fullscreenOn) return;
      const b = win.getBounds();
      if (!isSaneBounds(b)) return;
      store.setWindowBounds(b);
    }, 500);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);
  win.on('closed', () => {
    win = null;
    app.quit(); // скрытые окна сайтов не должны держать приложение
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Масштаб окна: размер и зум содержимого меняются вместе, нижний правый угол остаётся на месте.
function applyWindowScale(scale, prevScale) {
  if (!win) return;
  const k = scale / 100;
  // Если сейчас полноэкранный режим — масштабируем запомненное «нормальное» окно,
  // а экран оставляем на весь экран.
  const b = fullscreenOn && normalBounds ? normalBounds : win.getBounds();
  const ratio = scale / (prevScale || 100);
  const width = Math.round(b.width * ratio);
  const height = Math.round(b.height * ratio);
  const next = { x: b.x + b.width - width, y: b.y + b.height - height, width, height };
  if (fullscreenOn) normalBounds = next;
  else win.setBounds(next);
  win.webContents.setZoomFactor(k);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = store.getSettings().micHotkey;
  if (!key) return;
  try {
    globalShortcut.register(key, () => win?.webContents.send('mic:toggle'));
  } catch (err) {
    console.warn('hotkey', key, err.message);
  }
}

// Снимок основного экрана без окна Amadeus (content protection на время съёмки).
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1280 / display.size.width);
  win?.setContentProtection(true);
  try {
    await new Promise((r) => setTimeout(r, 120));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const src = sources.find((x) => x.display_id === String(display.id)) || sources[0];
    if (!src) throw new Error('Не удалось получить изображение экрана');
    return src.thumbnail.toJPEG(70).toString('base64');
  } finally {
    win?.setContentProtection(false);
  }
}

// Разбирает ответ: [emotion] текст ... → сегменты, [remember: ...] → память.
function parseReply(raw) {
  const remembered = [];
  let text = raw.replace(/\[remember:\s*([^\]]+)\]/gi, (_, fact) => {
    remembered.push(fact.trim());
    return '';
  });
  text = text.replace(/[*_#`]+/g, '').replace(/<\/?[a-z][\w-]*>/gi, '').replace(/\([^)]*\)/g, (m) => (m.length > 40 ? m : ''));

  const segments = [];
  let emotion = 'neutral';
  for (const part of text.split(/(\[[a-z_ ]+\])/i)) {
    const tag = part.match(/^\[([a-z_ ]+)\]$/i);
    if (tag) {
      const id = tag[1].trim().toLowerCase();
      if (BY_ID[id]) emotion = id;
      continue;
    }
    const t = part.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const last = segments[segments.length - 1];
    if (last && last.emotion === emotion) last.text += ' ' + t;
    else segments.push({ emotion, text: t });
  }
  return { segments, remembered };
}

let lastUserTs = null;
let summarizing = null;
const KEEP_VERBATIM = 6; // столько последних сообщений остаётся дословно после пересказа

// Когда с прошлого пересказа набралось summarizeEvery ответов — нейросеть пересказывает разговор.
// Дальше она получает пересказ + последние реплики, а не всю переписку (на сайте — новый чат).
function maybeSummarize(s) {
  if (summarizing || !s.summarizeEvery) return;
  const summary = store.getSummary();
  const history = store.getHistory();
  // считаем ответы с момента прошлого пересказа (оставленные дословно реплики не в счёт)
  const newReplies = history.filter((m) => m.role === 'assistant' && (m.ts || 0) > (summary.ts || 0)).length;
  if (newReplies < s.summarizeEvery) return;
  const pending = history.filter((m) => (m.ts || 0) > summary.upto);
  const upto = pending[Math.max(0, pending.length - KEEP_VERBATIM - 1)].ts;
  const messages = pending.map(({ role, content }) => ({ role, content }));
  summarizing = llm.summarize(s, summary.text, messages)
    .then((text) => {
      if (text) store.setSummary({ text, upto, ts: Date.now() });
    })
    .catch((err) => console.warn('summary failed:', err.message))
    .finally(() => { summarizing = null; });
}

// Действия, ждущие разрешения пользователя: id → действие (выполняется только то, что здесь лежит).
const pendingActions = new Map();
let actionSeq = 0;

function describeActions(actions, kind, s) {
  return actions.map((a) => {
    const id = `a${++actionSeq}`;
    pendingActions.set(id, a);
    return {
      id,
      type: a.type,
      target: a.target,
      content: a.content ? a.content.slice(0, 4000) : undefined,
      ...tools.describe(a),
      confirm: tools.needsConfirm(a, kind, s),
    };
  });
}

async function handleChat({ text, kind, files = [], origin }) {
  if (summarizing) await summarizing;
  const s = store.getSettings();
  const history = store.getHistory();
  const memory = store.getMemory();
  const summary = store.getSummary();
  if (!lastUserTs) lastUserTs = [...history].reverse().find((m) => m.role === 'user' && !m.kind)?.ts || null;
  const system = buildSystemPrompt({ settings: s, memory, lastUserTs, summary: summary.text });
  const recent = history
    .filter((m) => (m.ts || 0) > summary.upto)
    .slice(-(s.summarizeEvery * 2 + KEEP_VERBATIM + 2))
    .map(({ role, content }) => ({ role, content }));

  let userMsg;
  if (kind === 'screen') {
    const image = await captureScreen();
    userMsg = {
      role: 'user',
      content: '[ЭКРАН] Автоматический скриншот экрана пользователя. Реши, сказать что-нибудь или ответить [silent].',
      image,
    };
  } else {
    userMsg = { role: 'user', content: text };
    if (files.length) {
      userMsg.content = `${text || '(без подписи)'}\n[Пользователь прислал вложения: ${files.map((f) => f.name).join(', ')}]`;
      userMsg.files = files;
    }
    if (kind === 'user') lastUserTs = Date.now();
  }

  const raw = await llm.chat(s, system, [...recent, userMsg], { screen: kind === 'screen' });
  const silent = /^\s*\[silent\]\s*$/i.test(raw) || (kind === 'screen' && /\[silent\]/i.test(raw) && raw.length < 40);
  if (silent) return { silent: true, segments: [] };

  // Действия с компьютером вынимаются до разбора текста (там чистится markdown).
  const extracted = tools.extract(raw);
  const actionList = s.toolsEnabled ? extracted.actions : [];
  const { segments, remembered } = parseReply(extracted.text);
  if (!segments.length && !actionList.length) return { silent: true, segments: [] };

  const now = Date.now();
  // В истории действие остаётся пометкой, чтобы нейросеть помнила, что просила.
  const actionNote = actionList.map((a) => ` (действие: ${tools.describe(a).title} — ${a.target})`).join('');
  history.push(
    kind === 'screen'
      ? { role: 'user', content: '[ЭКРАН] (ты посмотрела на экран пользователя)', ts: now, kind }
      : { role: 'user', content: userMsg.content, ts: now, ...(kind !== 'user' && { kind }) },
    { role: 'assistant', content: segments.map((x) => `[${x.emotion}] ${x.text}`).join(' ') + actionNote, ts: now },
  );
  store.setHistory(history.slice(-500));
  if (remembered.length) {
    store.setMemory([...memory, ...remembered.map((t) => ({ text: t, ts: now }))].slice(-100));
  }
  maybeSummarize(s);
  // Ответ на результат действия продолжает просьбу пользователя — разрешения считаются от неё.
  const actions = describeActions(actionList, kind === 'tool' ? origin : kind, s);
  return { silent: false, segments, actions };
}

function setupIpc() {
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_, patch) => {
    const prevScale = store.getSettings().windowScale;
    const s = store.setSettings(patch);
    win?.setAlwaysOnTop(!!s.alwaysOnTop);
    if (win && s.windowScale !== prevScale) applyWindowScale(s.windowScale, prevScale);
    registerHotkey();
    return s;
  });
  ipcMain.handle('chat:send', async (_, req) => {
    try {
      return await handleChat(req);
    } catch (err) {
      const s = store.getSettings();
      // Понятная подсказка: чаще всего «ответа нет» просто потому, что выбран не тот провайдер.
      if (s.provider === 'web') {
        err.message = `${err.message} — сейчас отвечает «сайт нейросети» (${s.webSite}). Если нужен OpenCode: Настройки → «Кто отвечает» → OpenCode (локально, без ключа).`;
      }
      throw err;
    }
  });
  ipcMain.handle('tts:speak', (_, { text, emotion, seed }) => voice.synthesize(store.getSettings(), text, emotion, seed));
  ipcMain.handle('tts:speak-reply', async (_, { segments }) => {
    const s = store.getSettings();
    const segs = (Array.isArray(segments) ? segments : [])
      .map((x) => ({ text: String(x?.text || ''), emotion: x?.emotion, seed: x?.seed }));
    const audio = await voice.synthesizeReply(s, segs);
    return audio;
  });
  ipcMain.handle('stt:transcribe', (_, { audio, mime }) => voice.transcribe(store.getSettings(), Buffer.from(audio), mime));
  ipcMain.handle('voices:list', () => voice.listVoices(store.getSettings()));
  ipcMain.handle('opencode:models', () => llm.opencodeModels(store.getSettings()));
  ipcMain.handle('history:get', () => store.getHistory());
  ipcMain.handle('history:clear', () => {
    store.setHistory([]);
    store.setSummary({ text: '', upto: 0 });
  });
  ipcMain.handle('summary:get', () => store.getSummary());
  ipcMain.handle('memory:get', () => store.getMemory());
  ipcMain.handle('memory:clear', () => store.setMemory([]));
  ipcMain.handle('vision:available', () => !!llm.visionProvider(store.getSettings()));

  // Нейросеть без ключа: сайт в скрытом окне + вход через внешний браузер
  ipcMain.handle('web:status', async (_, site) => ({
    loggedIn: await webchat.isLoggedIn(site),
    visible: webchat.isVisible(site),
  }));
  ipcMain.handle('web:loginHere', (_, site) => webchat.show(site, { login: true }));
  // Вход через внешний браузер в два шага: открыть — и перенести куки только по кнопке.
  ipcMain.handle('web:loginBrowser', (e, { site, browser }) =>
    browserlogin.open(site, browser, (msg) => !e.sender.isDestroyed() && e.sender.send('web:loginStatus', msg)));
  ipcMain.handle('web:transferLogin', async (_, site) => webchat.importLogin(site, await browserlogin.transfer(site)));
  ipcMain.handle('web:loginOpen', (_, site) => browserlogin.isOpen(site));
  ipcMain.handle('web:browsers', () => {
    try { return browserlogin.findBrowser('auto').name; } catch { return null; }
  });
  ipcMain.handle('web:toggle', (_, site) => {
    if (webchat.isVisible(site)) webchat.hide(site);
    else webchat.show(site);
    return webchat.isVisible(site);
  });
  ipcMain.handle('persona:default', () => DEFAULT_PERSONA);

  // Действия с компьютером: выполняются только по id из pendingActions (после разрешения).
  ipcMain.handle('tools:run', async (_, id) => {
    const action = pendingActions.get(id);
    if (!action) throw new Error('Действие уже выполнено или отменено');
    pendingActions.delete(id);
    return tools.execute(action);
  });
  ipcMain.handle('tools:deny', (_, id) => { pendingActions.delete(id); });
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:close', () => win?.close());
  ipcMain.handle('win:toggle-fullscreen', () => {
    if (!win) return false;
    if (!fullscreenOn) {
      // Запоминаем, где стоял телефон, и разворачиваем окно на весь экран.
      normalBounds = win.getBounds();
      const display = screen.getDisplayMatching(normalBounds);
      const b = display.bounds; // весь экран целиком, включая панель задач
      fullscreenOn = true;
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    } else {
      fullscreenOn = false;
      if (normalBounds) win.setBounds(normalBounds);
      normalBounds = null;
      win.setAlwaysOnTop(store.getSettings().alwaysOnTop);
    }
    return fullscreenOn;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, permission, cb) => cb(permission === 'media'));
  setupIpc();
  createWindow();
  registerHotkey();
  // Голос Курису (RVC) грузим заранее — иначе первый ответ ждёт модель ~15 секунд.
  voice.warmup(store.getSettings()).catch(() => {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  voice.dispose();
});
app.on('window-all-closed', () => app.quit());
