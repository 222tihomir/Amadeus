// Вход на сайт нейросети через настоящий браузер (Chrome/Edge/...): во встроенном окне Electron
// Google блокирует вход. Браузер запускается с отдельным профилем и отладочным портом; когда
// ты нажимаешь «Перенести вход», забираем куки, localStorage и User-Agent по DevTools-протоколу (CDP),
// переносим их в профиль Amadeus и закрываем браузер. Сами по себе куки не переносятся.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { app } = require('electron');
const SITES = require('./sites');
const { isWindows, isMac, isLinux, isExecutable, findOnPath } = require('./platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = process.env.LOCALAPPDATA || '';
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

// Пути к браузерам на Chromium. Ключ — то, что хранится в настройках (`loginBrowser`).
const BROWSER_PATHS = {
  chrome: isWindows
    ? [`${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${PF86}\\Google\\Chrome\\Application\\chrome.exe`, `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`]
    : isMac
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  chromium: isWindows
    ? [`${LOCAL}\\Chromium\\Application\\chrome.exe`]
    : isMac
      ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  edge: isWindows
    ? [`${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`]
    : isMac
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
  brave: isWindows
    ? [`${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${LOCAL}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`]
    : isMac
      ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
      : ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/opt/brave.com/brave/brave'],
  yandex: isWindows
    ? [`${LOCAL}\\Yandex\\YandexBrowser\\Application\\browser.exe`]
    : isMac
      ? ['/Applications/Yandex.app/Contents/MacOS/Yandex']
      : ['/usr/bin/yandex-browser', '/usr/bin/yandex-browser-stable', '/opt/yandex/browser/yandex-browser'],
};
const BROWSER_LABELS = { chrome: 'Chrome', chromium: 'Chromium', edge: 'Edge', brave: 'Brave', yandex: 'Яндекс.Браузер' };
const BROWSER_BINS = { chrome: ['google-chrome', 'google-chrome-stable'], chromium: ['chromium', 'chromium-browser'], edge: ['microsoft-edge', 'microsoft-edge-stable'], brave: ['brave-browser', 'brave'], yandex: ['yandex-browser', 'yandex-browser-stable'] };
const PROG_IDS = { ChromeHTML: 'chrome', ChromiumHTML: 'chromium', MSEdgeHTM: 'edge', BraveHTML: 'brave', YandexHTML: 'yandex' };

function defaultBrowserWindows() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true });
    const id = (out.match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1] || '';
    return Object.entries(PROG_IDS).find(([prefix]) => id.startsWith(prefix))?.[1] || null;
  } catch {
    return null;
  }
}

// Браузер по умолчанию в Linux: xdg-settings → xdg-mime. Firefox не подходит для CDP-входа.
function defaultBrowserLinux() {
  const ids = [];
  for (const [cmd, args] of [
    ['xdg-settings', ['get', 'default-web-browser']],
    ['xdg-mime', ['query', 'default', 'x-scheme-handler/https']],
  ]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }).trim();
      if (out) ids.push(out.toLowerCase());
    } catch { /* программы нет — пробуем следующий способ */ }
  }
  const known = [
    [/^(google-chrome|google-chrome-stable)/, 'chrome'],
    [/^chromium/, 'chromium'],
    [/^(microsoft-edge|msedge)/, 'edge'],
    [/^brave/, 'brave'],
    [/^yandex/, 'yandex'],
  ];
  for (const id of ids) {
    const hit = known.find(([re]) => re.test(id));
    if (hit) return hit[1];
  }
  return null;
}

function defaultBrowser() {
  if (isWindows) return defaultBrowserWindows();
  if (isLinux) return defaultBrowserLinux();
  return null; // macOS: берём первый найденный Chromium-браузер
}

// На Linux программы могут стоять в /usr/local/bin, ~/.local/bin, /snap/bin и т.п.,
// поэтому кроме типовых путей проверяем PATH.
function browserCandidates(name) {
  const list = BROWSER_PATHS[name] || [];
  const fromPath = (BROWSER_BINS[name] || []).map(findOnPath).filter(Boolean);
  return [...new Set([...list, ...fromPath])];
}

// Браузер для входа: выбранный в настройках, иначе браузер по умолчанию (если он на Chromium),
// иначе Chrome/Chromium/Edge/Brave/Яндекс.
function findBrowser(preferred) {
  const order = [preferred !== 'auto' && preferred, defaultBrowser(), 'chrome', 'chromium', 'edge', 'brave', 'yandex'].filter(Boolean);
  for (const name of order) {
    const exe = browserCandidates(name).find(isExecutable);
    if (exe) return { name, label: BROWSER_LABELS[name] || name, exe };
  }
  throw new Error('Не нашла Chrome, Chromium, Edge, Brave или Яндекс.Браузер — вход через внешний браузер невозможен');
}

// ── Минимальный клиент DevTools-протокола ───────────────────────────────
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP: не удалось подключиться'));
  });
  return {
    async send(method, params = {}) {
      await ready;
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        setTimeout(() => pending.has(msgId) && (pending.delete(msgId), reject(new Error(`CDP: таймаут ${method}`))), 15000);
      });
    },
    close: () => { try { ws.close(); } catch { /* уже закрыт */ } },
  };
}

async function getJson(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

// Есть ли вход: кука авторизации среди всех куки браузера или ключ в localStorage вкладки сайта.
async function readLogin(port, cfg) {
  const host = hostOf(cfg.url);
  const browser = cdp((await getJson(port, '/json/version')).webSocketDebuggerUrl);
  try {
    const { cookies } = await browser.send('Storage.getCookies');
    const version = await browser.send('Browser.getVersion');
    let storage = [];
    let storageOk = false;
    const page = (await getJson(port, '/json/list')).find((t) => t.type === 'page' && t.url.startsWith('http') && hostOf(t.url).endsWith(host));
    if (page && cfg.auth.storage) {
      const tab = cdp(page.webSocketDebuggerUrl);
      try {
        const r = await tab.send('Runtime.evaluate', {
          expression: 'JSON.stringify(Object.entries(localStorage))',
          returnByValue: true,
        });
        storage = JSON.parse(r.result.value || '[]');
        storageOk = storage.some(([k, v]) => k.startsWith(cfg.auth.storage) && v);
      } finally {
        tab.close();
      }
    }
    const cookieOk = !!cfg.auth.cookie && cookies.some((c) => c.name.startsWith(cfg.auth.cookie) && c.value);
    return { ok: cookieOk || storageOk, cookies, storage, userAgent: version.userAgent, browser };
  } catch (err) {
    browser.close();
    throw err;
  }
}

// Открытый для входа браузер (одновременно — только один).
let active = null; // { site, port, proc, exited, browserKey, browserLabel }

// Шаг 1: открывает сайт во внешнем браузере. Куки НЕ переносятся — только сообщает,
// выполнен ли вход (onStatus), пока ты не нажмёшь «Перенести вход» (transfer) или не закроешь браузер.
async function open(siteName, preferred = 'auto', onStatus = () => {}) {
  const cfg = SITES[siteName];
  if (!cfg) throw new Error(`Неизвестный сайт: ${siteName}`);
  if (active && !active.exited) {
    if (active.site === siteName) return { browser: active.browserLabel };
    throw new Error(`Уже открыт браузер для входа в ${SITES[active.site].name} — перенеси вход или закрой его`);
  }
  const { name: browserKey, label: browserLabel, exe } = findBrowser(preferred);
  const port = 9300 + Math.floor(Math.random() * 500);
  // Отдельный профиль на каждый сайт: вход в нём сохраняется, повторный вход обычно в один клик.
  const profile = path.join(app.getPath('userData'), 'browser-login', siteName);
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];
  // На Linux под root Chromium не запускается с песочницей. Отдельный профиль и так изолирован.
  if (isLinux && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push(cfg.url);

  const proc = spawn(exe, args, { detached: true, stdio: 'ignore' });
  proc.unref();
  const session = { site: siteName, port, proc, exited: false, browserKey, browserLabel };
  proc.on('exit', () => { session.exited = true; });
  active = session;
  onStatus(`Открыт ${browserLabel}: войди в аккаунт ${cfg.name}, затем нажми «Перенести вход»`);

  // Следим только за статусом: вход есть / нет / браузер закрыт.
  (async () => {
    let connected = false;
    let failures = 0;
    let lastOk = null;
    const started = Date.now();
    while (active === session) {
      await sleep(2000);
      let state;
      try {
        state = await readLogin(port, cfg);
        state.browser.close();
        connected = true;
        failures = 0;
      } catch {
        if (session.exited || (connected && ++failures >= 3) || (!connected && Date.now() - started > 60000)) {
          if (active === session) active = null;
          onStatus(connected || session.exited ? 'Браузер закрыт — вход не перенесён' : 'Браузер не запустился с отладочным портом');
          return;
        }
        continue;
      }
      if (process.env.AMADEUS_DEBUG) console.log('[login]', siteName, 'cookies', state.cookies.length, 'logged', state.ok);
      if (state.ok !== lastOk) {
        lastOk = state.ok;
        onStatus(state.ok
          ? `Вход в ${cfg.name} обнаружен — нажми «Перенести вход»`
          : `Открыт ${browserLabel}: войди в аккаунт ${cfg.name}, затем нажми «Перенести вход»`);
      }
    }
  })();
  return { browser: browserLabel };
}

function isOpen(siteName) {
  return !!(active && !active.exited && active.site === siteName);
}

// Шаг 2 (только по кнопке): забирает куки, localStorage и User-Agent и закрывает браузер.
async function transfer(siteName) {
  if (!isOpen(siteName)) throw new Error('Браузер для входа не открыт — сначала нажми «Войти через браузер»');
  const cfg = SITES[siteName];
  const session = active;
  const state = await readLogin(session.port, cfg);
  if (!state.ok) {
    state.browser.close();
    throw new Error(`Вход в ${cfg.name} ещё не выполнен — войди в открытом браузере`);
  }
  active = null;
  try { await state.browser.send('Browser.close'); } catch { /* уже закрывается */ }
  state.browser.close();
  return { cookies: state.cookies, storage: state.storage, userAgent: state.userAgent };
}

module.exports = { open, transfer, isOpen, findBrowser };
