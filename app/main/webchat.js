// Браузер сайтов нейросетей: пишет в ChatGPT/Claude/DeepSeek... через твой аккаунт на сайте, без API-ключа.
// У каждого сайта свой постоянный профиль (persist:web-<сайт>) — куки и вход сохраняются между запусками.
// Окно сайта скрыто; его можно показать, чтобы войти или посмотреть, почему ответ завис.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const SITES = require('./sites');

const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const wins = new Map(); // сайт → BrowserWindow
const fresh = new Set(); // сайты, где страница открыта заново (на ней пустой чат)
const locks = new Map();
let quitting = false;
app.on('before-quit', () => { quitting = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function site(name) {
  const cfg = SITES[name];
  if (!cfg) throw new Error(`Неизвестный сайт: ${name}`);
  return cfg;
}

// Открытый чат каждого сайта сохраняется (адрес чата на сайте), чтобы после перезапуска
// продолжить его, а не начинать новый. Домашняя страница сайта чатом не считается.
const chatStateFile = () => path.join(app.getPath('userData'), 'webchats.json');
let chatState = (() => {
  try { return JSON.parse(fs.readFileSync(chatStateFile(), 'utf8')); } catch { return {}; }
})();
function persistChatState() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(chatStateFile(), JSON.stringify(chatState, null, 1), 'utf8');
  } catch { /* не сохранилось — после перезапуска начнётся новый чат */ }
}
function savedChatUrl(name) {
  return chatState[name] && chatState[name].url ? chatState[name].url : null;
}
function hasChat(name) {
  return !!(savedChatUrl(name) && chatState[name].persona);
}
function clearChat(name) {
  if (chatState[name]) {
    delete chatState[name];
    persistChatState();
  }
}
function saveChat(name, url) {
  if (!url || url === site(name).url) clearChat(name);
  else {
    chatState[name] = { url, persona: true };
    persistChatState();
  }
}

// User-Agent браузера, в котором был вход (Chrome) — чтобы сайт не видел смены браузера.
const uaFile = () => path.join(app.getPath('userData'), 'web-ua.json');
function readUas() {
  try { return JSON.parse(fs.readFileSync(uaFile(), 'utf8')); } catch { return {}; }
}

function sessionFor(name) {
  const ses = session.fromPartition(`persist:web-${name}`);
  ses.setUserAgent(readUas()[name] || UA);
  return ses;
}

function getWindow(name) {
  let w = wins.get(name);
  if (w && !w.isDestroyed()) return w;
  const cfg = site(name);
  w = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
    title: `Amadeus — ${cfg.name}`,
    autoHideMenuBar: true,
    webPreferences: { session: sessionFor(name), backgroundThrottling: false, contextIsolation: true },
  });
  // Закрытие окна только прячет его: страница и вход остаются.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
    saveCookies(name).catch(() => {});
  });
  w.on('page-title-updated', (e) => {
    e.preventDefault();
    w.setTitle(`Amadeus — ${cfg.name}${w.loginMode ? ' (войди в аккаунт и закрой окно)' : ''}`);
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'allow' })); // всплывающие окна входа (Google и т.п.)
  w.loadURL(cfg.url);
  wins.set(name, w);
  fresh.add(name);
  return w;
}

const debug = process.env.AMADEUS_DEBUG ? (...a) => console.log('[web]', ...a) : () => {};

// Выполняет функцию в странице сайта. Функция сериализуется — она не видит переменные снаружи.
// Таймаут нужен: во время перехода страницы executeJavaScript может не ответить никогда.
function run(w, fn, ...args) {
  return Promise.race([
    w.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true),
    sleep(10000).then(() => { throw new Error(`страница не ответила (${fn.name})`); }),
  ]);
}

// ── Код, который выполняется внутри страницы ────────────────────────────
function pageFind(sels) {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  for (const s of sels) {
    try {
      const el = [...document.querySelectorAll(s)].find(vis);
      if (el) return s;
    } catch { /* неподдерживаемый селектор */ }
  }
  return null;
}

function pageSnapshot(cfg) {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const BLOCK = new Set(['DIV','P','UL','OL','LI','TABLE','TR','THEAD','TBODY','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','SECTION','ARTICLE','FIGURE','DL','DD','HR']);
  // Похож на innerText, но <pre>/<code> читает через textContent (с пробелами, как в DOM).
  function walkText(root) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) { out.push(ch.nodeValue); continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === 'PRE' || (tag === 'CODE' && !ch.querySelector('pre'))) {
          out.push('\n', ch.textContent || '', '\n');
          continue;
        }
        if (tag === 'BR') { out.push('\n'); continue; }
        walk(ch);
        if (BLOCK.has(tag)) out.push('\n');
        else if (tag === 'TD' || tag === 'TH') out.push(' ');
      }
    };
    walk(root);
    return out.join('').replace(/\n{3,}/g, '\n\n');
  }
  // Сайты рисуют вокруг кода служебные элементы (заголовок «Python», кнопки Copy/Download).
  // Прячем их на время чтения и сразу возвращаем: innerText тогда сохраняет абзацы и код,
  // а мусор не попадает в текст ответа и в файлы. Клонировать нельзя — у отвязанного узла
  // innerText не считает вёрстку и склеивает соседние блоки.
  const NOISE = [
    'button', '[role="button"]', 'svg',
    '[class*="code-block-banner"]', '[class*="code-block-header"]', '[class*="code-block-toolbar"]',
    '[class*="code-toolbar"]', '[class*="code-header"]', '[class*="icon-button"]',
    '[class*="message-action"]', '[class*="action-bar"]', '[class*="toolbar"]',
    '[aria-label*="copy" i]', '[aria-label*="download" i]',
    '[aria-label*="копир" i]', '[aria-label*="скачат" i]',
  ].join(',');
  const readText = (el) => {
    const hidden = [];
    try {
      el.querySelectorAll(NOISE).forEach((n) => {
        hidden.push([n, n.style.display]);
        n.style.display = 'none';
      });
      // innerText у части сайтов (DeepSeek) теряет ведущие пробелы в блоках кода —
      // из-за этого в записанных файлах съезжают отступы. Код читаем из DOM напрямую,
      // остальной текст — как отрисован (innerText даёт абзацы и переводы строк).
      return walkText(el);
    } catch {
      return el.innerText || el.textContent || '';
    } finally {
      for (const [n, prev] of hidden) n.style.display = prev;
    }
  };
  const replies = {};
  for (const s of cfg.replies) {
    try {
      const all = document.querySelectorAll(s);
      replies[s] = { n: all.length, last: all.length ? readText(all[all.length - 1]) : '' };
    } catch { replies[s] = { n: 0, last: '' }; }
  }
  const stop = cfg.stops.some((s) => { try { return [...document.querySelectorAll(s)].some(vis); } catch { return false; } });
  return { replies, stop, url: location.href };
}

function pagePrepareInput(sels) {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  // cookie-баннеры: сначала «только необходимые», иначе «принять»
  const rx = /^(necessary cookies only|reject( all| non-essential)?( cookies)?|decline|только необходимые|отклонить( все)?|accept all( cookies)?|принять все)$/i;
  for (const b of document.querySelectorAll('button')) if (vis(b) && rx.test(b.innerText.trim())) b.click();
  for (const s of sels) {
    const el = [...document.querySelectorAll(s)].find(vis);
    if (!el) continue;
    el.focus();
    if (el.tagName === 'TEXTAREA') el.select();
    else document.execCommand('selectAll');
    document.execCommand('delete');
    return true;
  }
  return false;
}

function pageInputText(sels) {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  for (const s of sels) {
    const el = [...document.querySelectorAll(s)].find(vis);
    if (el) return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  }
  return '';
}

function pageExecInsert(text) {
  return document.execCommand('insertText', false, text);
}

function pageClickSend(sels) {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  for (const s of sels) {
    try {
      const b = [...document.querySelectorAll(s)].find(vis);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return true; }
    } catch { /* нет такого */ }
  }
  return false;
}

// Прикрепляет файлы ([{ name, mime, data: base64 }]): через input[type=file], иначе как вставку из буфера.
function pageAttachFiles(files, inputs) {
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mime }));
  }
  const all = [...document.querySelectorAll('input[type=file]')];
  const onlyImages = files.every((f) => f.mime.startsWith('image/'));
  const fileInput = onlyImages
    ? all.find((i) => !i.accept || /image|\*|jpg|jpeg/i.test(i.accept))
    : all.find((i) => !i.accept || /\*|pdf|text|\.txt/i.test(i.accept)) || all.find((i) => i.multiple) || all[0];
  if (fileInput) {
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return 'file-input';
  }
  for (const s of inputs) {
    const el = document.querySelector(s);
    if (!el) continue;
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'paste';
  }
  return null;
}

function pageStorageHas(key) {
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) if (store.key(i).startsWith(key) && store.getItem(store.key(i))) return true;
  }
  return false;
}

// ── Вспомогательное ─────────────────────────────────────────────────────
function waitLoad(w) {
  if (!w.webContents.isLoading()) return Promise.resolve();
  return Promise.race([new Promise((r) => w.webContents.once('did-stop-loading', r)), sleep(30000)]);
}

async function waitFor(w, sels, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await run(w, pageFind, sels)) return true;
    } catch { /* страница перезагружается */ }
    await sleep(400);
  }
  return false;
}

async function withLock(name, fn) {
  const prev = locks.get(name) || Promise.resolve();
  let release;
  const cur = new Promise((r) => { release = r; });
  locks.set(name, prev.then(() => cur));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function newReply(before, now, cfg) {
  for (const s of cfg.replies) {
    const b = before.replies[s];
    const n = now.replies[s];
    if (!n || !n.n) continue;
    if (n.n > b.n) return s;
    if (cfg.virtual && b.n && n.last !== b.last) return s;
  }
  return null;
}

// ── Публичное API ───────────────────────────────────────────────────────
async function isLoggedIn(name) {
  const cfg = site(name);
  if (cfg.auth.cookie) {
    const cookies = await sessionFor(name).cookies.get({});
    if (cookies.some((c) => c.name.startsWith(cfg.auth.cookie) && c.value)) return true;
  }
  if (cfg.auth.storage) {
    const w = getWindow(name);
    await waitLoad(w);
    try { return await run(w, pageStorageHas, cfg.auth.storage); } catch { return false; }
  }
  return false;
}

function show(name, { login = false } = {}) {
  const w = getWindow(name);
  w.loginMode = login;
  w.setTitle(`Amadeus — ${site(name).name}${login ? ' (войди в аккаунт и закрой окно)' : ''}`);
  w.show();
  w.focus();
}

function hide(name) {
  const w = wins.get(name);
  if (w && !w.isDestroyed()) w.hide();
}

function isVisible(name) {
  const w = wins.get(name);
  return !!(w && !w.isDestroyed() && w.isVisible());
}

// Куки в формате CDP/Playwright: [{name, value, domain, path, expires, httpOnly, secure, sameSite}]
const cookieDir = () => path.join(app.getPath('userData'), 'cookie-backup'); // не «cookies»: в Windows совпадёт с файлом Cookies самого Chromium
const SAME_SITE = { Lax: 'lax', Strict: 'strict', None: 'no_restriction' };
const SAME_SITE_BACK = { lax: 'Lax', strict: 'Strict', no_restriction: 'None' };

// Переносит вход из внешнего браузера: куки, localStorage сайта и его User-Agent.
async function importLogin(name, { cookies, storage, userAgent }) {
  if (userAgent) {
    const uas = readUas();
    uas[name] = userAgent;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(uaFile(), JSON.stringify(uas, null, 1), 'utf8');
    sessionFor(name);
  }
  const ses = sessionFor(name);
  let ok = 0;
  for (const c of cookies) {
    const host = String(c.domain || '').replace(/^\./, '');
    const details = {
      url: `https://${host}${c.path || '/'}`,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    if (!c.name.startsWith('__Host-')) details.domain = c.domain;
    if (c.expires && c.expires > 0) details.expirationDate = c.expires;
    if (SAME_SITE[c.sameSite]) details.sameSite = SAME_SITE[c.sameSite];
    try {
      await ses.cookies.set(details);
      ok++;
    } catch { /* кука отвергнута браузером */ }
  }
  await ses.cookies.flushStore();

  const w = getWindow(name);
  await waitLoad(w);
  if (storage && storage.length) {
    // localStorage пишется со страницы самого сайта (нужен для DeepSeek/Qwen: там вход хранится в нём)
    try { await run(w, pageSetStorage, storage); } catch { /* страница ещё грузится */ }
  }
  w.loadURL(site(name).url);
  fresh.add(name);
  await saveCookies(name).catch(() => {});
  return ok;
}

function pageSetStorage(entries) {
  for (const [k, v] of entries) localStorage.setItem(k, v);
  return entries.length;
}

async function saveCookies(name) {
  const cookies = await sessionFor(name).cookies.get({});
  if (!cookies.length) return;
  fs.mkdirSync(cookieDir(), { recursive: true });
  const out = cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expirationDate || -1, httpOnly: c.httpOnly, secure: c.secure,
    sameSite: SAME_SITE_BACK[c.sameSite] || 'Lax',
  }));
  fs.writeFileSync(path.join(cookieDir(), `${name}.json`), JSON.stringify(out, null, 1), 'utf8');
}

// Отправляет сообщение на сайт и ждёт ответ целиком. files — вложения [{ name, mime, data: base64 }].
function ask(name, message, { newChat = false, files = [], onProgress } = {}) {
  return withLock(name, async () => {
    const cfg = site(name);
    const w = getWindow(name);
    const wasFresh = fresh.has(name);
    fresh.delete(name);
    if (newChat) {
      clearChat(name);
      if (!wasFresh) w.loadURL(cfg.url);
    } else if (wasFresh && savedChatUrl(name)) {
      w.loadURL(savedChatUrl(name)); // после перезапуска продолжаем вчерашний чат
    }
    await waitLoad(w);
    debug(name, 'loaded', w.webContents.getURL());

    if (!(await waitFor(w, cfg.inputs, 30000))) {
      const logged = await isLoggedIn(name).catch(() => false);
      throw new Error(logged
        ? `${cfg.name}: не нашла поле ввода. Открой ⚙ → «Показать браузер», чтобы посмотреть, что на странице`
        : `${cfg.name}: вход не выполнен. Открой ⚙ → «Войти на сайт»`);
    }
    await run(w, pagePrepareInput, cfg.inputs);

    if (files.length) {
      const how = await run(w, pageAttachFiles, files, cfg.inputs);
      if (!how) throw new Error(`${cfg.name}: не получилось прикрепить файл`);
      await sleep(2500 + 1500 * (files.length - 1)); // даём сайту загрузить файлы
      await run(w, pagePrepareInput, cfg.inputs); // фокус обратно в поле (картинка остаётся)
    }

    const before = await run(w, pageSnapshot, cfg);
    debug(name, 'input ready, typing', message.length, 'chars');

    // Вводим текст: нативный ввод, если не вышло — через execCommand.
    const probe = message.replace(/\s+/g, ' ').trim().slice(0, 30);
    const norm = (t) => String(t).replace(/\s+/g, ' ');
    w.webContents.insertText(message);
    await sleep(300);
    if (!norm(await run(w, pageInputText, cfg.inputs)).includes(probe)) {
      await run(w, pagePrepareInput, cfg.inputs);
      await run(w, pageExecInsert, message);
      await sleep(300);
      if (!norm(await run(w, pageInputText, cfg.inputs)).includes(probe)) {
        throw new Error(`${cfg.name}: не удалось вписать текст в поле ввода`);
      }
    }

    // Отправляем кнопкой, иначе Enter; проверяем, что поле очистилось.
    const cleared = async () => {
      for (let i = 0; i < 8; i++) {
        await sleep(400);
        if (norm(await run(w, pageInputText, cfg.inputs)).trim().length < Math.max(1, probe.length / 2)) return true;
      }
      return false;
    };
    const pressEnter = () => {
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    };
    if (!(await run(w, pageClickSend, cfg.sends))) pressEnter();
    if (!(await cleared())) {
      pressEnter();
      if (!(await cleared())) throw new Error(`${cfg.name}: сообщение не отправилось. Открой ⚙ → «Показать браузер»`);
    }

    debug(name, 'sent');
    // Ждём ответ: появился новый блок → текст перестал меняться и кнопки «Стоп» нет.
    const start = Date.now();
    let chosen = null;
    let last = '';
    let stable = 0;
    while (Date.now() - start < 240000) {
      await sleep(400);
      let snap;
      try { snap = await run(w, pageSnapshot, cfg); } catch { continue; }
      if (!chosen) {
        chosen = newReply(before, snap, cfg);
        if (chosen) debug(name, 'reply block', chosen, ((Date.now() - start) / 1000).toFixed(1) + 's');
        if (!chosen) {
          if (Date.now() - start > 60000) break;
          continue;
        }
      }
      const text = snap.replies[chosen].last.trim();
      if (text && onProgress) onProgress(text);
      if (text && text === last && !snap.stop) {
        if (++stable >= 3) {
          debug(name, 'done', ((Date.now() - start) / 1000).toFixed(1) + 's');
          saveChat(name, w.webContents.getURL());
          return text;
        }
      } else {
        stable = 0;
        last = text;
      }
    }
    saveChat(name, w.webContents.getURL());
    if (last) return last;
    throw new Error(`${cfg.name}: сообщение отправлено, но ответ не появился. Открой ⚙ → «Показать браузер»`);
  });
}

module.exports = { SITES, ask, hasChat, clearChat, isLoggedIn, show, hide, isVisible, importLogin, saveCookies };
