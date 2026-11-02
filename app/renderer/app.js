/* global amadeus, AmadeusEmotions */
'use strict';

const $ = (id) => document.getElementById(id);
const SPRITES = '../assets/sprites/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings = {};
let fullscreenOn = false; // окно сейчас в fullscreen (кнопка «на весь экран»)
const state = {
  busy: false, // ждём ответ нейросети
  speaking: false,
  recording: false,
  lastActivity: Date.now(),
  requestId: 0,
};

// ── Статус и уведомления ──────────────────────────────────────────────
function setStatus(text) { $('status').textContent = text || ''; }

let toastTimer = null;
function toast(text, ms = 6000) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ── Корпус телефона: нарезка и дорисовка ─────────────────────────────
// phone.webp (400×784) режется по колонкам 140 и 234 (по бокам от динамика и кнопки «домой»)
// и по строке 418 (ровный участок боковин). Куски рисуются без искажений, а разрывы
// при растягивании окна заполняются полосой из крайнего столбца/строки куска.
const FRAME = {
  w: 400, h: 784, cols: [140, 234], row: 418,
  screen: { l: 16.5, t: 78.8, r: 42.8, b: 108 }, // границы экрана (assets/ui/phone.json)
  home: [188, 697], // центр кнопки «домой»
};
const frameImg = new Image();
frameImg.src = '../assets/ui/phone.webp';

// Куски по одной оси: [начало в картинке, ширина в картинке, ширина на экране]; 1-px куски — растягиваемые полосы.
function frameSlices(cuts, total, k, gap) {
  const out = [];
  const part = gap / cuts.length; // разрыв делится поровну между надрезами
  let from = 0;
  for (const c of cuts) {
    out.push([from, c - from, (c - from) * k], [c, 1, part]);
    from = c;
  }
  out.push([from, total - from, (total - from) * k]);
  return out;
}

function drawFrame() {
  if (!frameImg.naturalWidth) return;
  const canvas = $('frame');
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr);
  const H = Math.round(innerHeight * dpr);
  const k = Math.min(W / FRAME.w, H / FRAME.h); // device px на 1 px картинки
  const src = frameImg.naturalWidth / FRAME.w; // если картинку пересоберут в другом размере
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const xs = frameSlices(FRAME.cols, FRAME.w, k, W - FRAME.w * k);
  const ys = frameSlices([FRAME.row], FRAME.h, k, H - FRAME.h * k);
  let y0 = 0;
  for (const [sy, sh, dh] of ys) {
    const y1 = Math.round(y0 + dh);
    let x0 = 0;
    for (const [sx, sw, dw] of xs) {
      const x1 = Math.round(x0 + dw);
      if (x1 > Math.round(x0) && y1 > Math.round(y0)) {
        ctx.drawImage(frameImg, sx * src, sy * src, sw * src, sh * src, Math.round(x0), Math.round(y0), x1 - Math.round(x0), y1 - Math.round(y0));
      }
      x0 += dw;
    }
    y0 += dh;
  }

  // Экран, области перетаскивания и кнопка «домой» — в CSS-пикселях.
  const css = k / dpr;
  const phone = document.querySelector('.phone').style;
  const { l, t, r, b } = FRAME.screen;
  phone.setProperty('--k', css);
  phone.setProperty('--sl', `${l * css}px`);
  phone.setProperty('--st', `${t * css}px`);
  phone.setProperty('--sr', `${r * css}px`);
  phone.setProperty('--sb', `${b * css}px`);
  const leftGap = xs.find((x) => x[1] === 1)?.[2] || 0;
  phone.setProperty('--home-x', `${(FRAME.home[0] * k + leftGap) / dpr}px`);
  phone.setProperty('--home-y', `${innerHeight - (FRAME.h - FRAME.home[1]) * css}px`);
}
frameImg.decode().then(drawFrame).catch(() => {});
window.addEventListener('resize', drawFrame);

// ── Персонаж: спрайты, смена эмоций, кадры рта ────────────────────────
const char = { layers: [$('charA'), $('charB')], active: 0, frames: null, emotion: 'neutral', mouth: 0 };
const imageCache = new Map();

function preload(name) {
  if (!imageCache.has(name)) {
    const img = new Image();
    img.src = SPRITES + name;
    imageCache.set(name, img.decode().catch(() => {}).then(() => img));
  }
  return imageCache.get(name);
}

async function setEmotion(id, { force = false } = {}) {
  const frames = AmadeusEmotions.spriteFrames(id, settings.outfit, settings.framing);
  char.emotion = id;
  if (!force && char.frames && char.frames[0] === frames[0]) return;
  await Promise.all(frames.map(preload));
  if (char.emotion !== id) return; // пока грузили, эмоция уже сменилась

  const cur = char.layers[char.active];
  const next = char.layers[1 - char.active];
  next.src = SPRITES + frames[char.mouth];
  cur.style.zIndex = 1;
  next.style.zIndex = 2;
  next.classList.remove('hidden');
  char.active = 1 - char.active;
  char.frames = frames;
  setTimeout(() => {
    if (char.layers[char.active] === cur) return;
    cur.style.transition = 'none';
    cur.classList.add('hidden');
    void cur.offsetWidth;
    cur.style.transition = '';
  }, 240);
}

function setMouth(n) {
  if (n === char.mouth || !char.frames) return;
  char.mouth = n;
  char.layers[char.active].src = SPRITES + char.frames[n];
}

let idleTimer = null;
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!state.busy && !state.speaking) {
      setEmotion('neutral');
      $('subtitle').classList.add('hidden');
    }
  }, 25000);
}

// ── Субтитры ──────────────────────────────────────────────────────────
function showSubtitle(text, who = 'Amadeus') {
  const box = $('subtitle');
  box.classList.remove('hidden');
  box.classList.toggle('user', who !== 'Amadeus');
  box.querySelector('.name').textContent = who;
  $('subtitle-text').textContent = text;
  box.scrollTop = box.scrollHeight;
}

// ── Воспроизведение голоса с lip-sync ─────────────────────────────────
let audioCtx = null;
let speechToken = 0;
let currentSource = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function interrupt() {
  speechToken++;
  if (currentSource) {
    try { currentSource.stop(); } catch { /* уже остановлен */ }
    currentSource = null;
  }
  state.speaking = false;
  setMouth(0);
}

// Рот открывается по громкости: уровень относительно недавнего пика → кадр 0/1/2.
async function playAudio(bytes, token, onProgress) {
  const ctx = getAudioCtx();
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (token !== speechToken) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const gain = ctx.createGain();
  gain.gain.value = settings.volume ?? 0.9;
  src.connect(analyser).connect(gain).connect(ctx.destination);
  currentSource = src;

  const data = new Float32Array(analyser.fftSize);
  let peak = 0.05;
  let lastChange = 0;
  const start = ctx.currentTime;

  await new Promise((resolve) => {
    src.onended = resolve;
    src.start();
    const tick = () => {
      if (token !== speechToken || currentSource !== src) return resolve();
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      peak = Math.max(rms, peak * 0.995);
      const level = rms / peak;
      const target = rms < 0.012 || level < 0.18 ? 0 : level < 0.5 ? 1 : 2;
      const now = performance.now();
      if (target !== char.mouth && now - lastChange > 65) {
        setMouth(target);
        lastChange = now;
      }
      onProgress(Math.min(1, (ctx.currentTime - start) / buf.duration));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  if (currentSource === src) currentSource = null;
  onProgress(1);
  setMouth(0);
}

// Без озвучки: текст печатается, рот «болтает», на знаках препинания пауза.
async function fakeTalk(text, token, onProgress) {
  const perChar = 45;
  for (let i = 1; i <= text.length; i++) {
    if (token !== speechToken) return;
    onProgress(i / text.length);
    const ch = text[i - 1];
    if (/[.,!?…;:—]/.test(ch)) {
      setMouth(0);
      await sleep(perChar * 4);
    } else {
      if (i % 2 === 0) setMouth(/\s/.test(ch) ? 0 : 1 + Math.round(Math.random()));
      await sleep(perChar);
    }
  }
  setMouth(0);
}

// Режет ответ на куски для озвучки: первый — одно короткое предложение (чтобы голос начался
// быстрее), дальше — предложения, собранные в куски до ~160 символов. Эмоция у куска своя.
const FIRST_CHUNK = 90;
const CHUNK = 160;

function splitSentences(text) {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["»)]*|$)\s*/g) || [text];
  const out = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (p.length <= CHUNK) { out.push(p); continue; }
    // слишком длинное предложение — делим по запятым/тире
    let cur = '';
    for (const piece of p.split(/(?<=[,;:—])\s+/)) {
      if (cur && (cur + ' ' + piece).length > CHUNK) { out.push(cur); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function toChunks(segments) {
  const chunks = [];
  for (const seg of segments) {
    let cur = '';
    for (const s of splitSentences(seg.text)) {
      const limit = chunks.length === 0 ? FIRST_CHUNK : CHUNK;
      if (cur && ((cur + ' ' + s).length > limit || (chunks.length === 0 && cur.length >= 20))) {
        chunks.push({ emotion: seg.emotion, text: cur });
        cur = s;
      } else {
        cur = cur ? `${cur} ${s}` : s;
      }
    }
    if (cur) chunks.push({ emotion: seg.emotion, text: cur });
  }
  return chunks;
}

let ttsWarned = 0;
async function performReply(replySegments) {
  interrupt();
  const token = speechToken;
  state.speaking = true;
  clearTimeout(idleTimer);
  const segments = toChunks(replySegments);
  // Один seed на весь ответ — генерация воспроизводимая: одинаковые фразы звучат одинаково.
  const replyText = replySegments.map((s) => s.text || '').join(' ').slice(0, 4000);
  const replySeed = [...replyText].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

  // Синтез идёт по очереди заранее: пока играет кусок N, готовится N+1.
  // ВАЖНО: не используем speakReply-батч здесь — он проще не ломать (fallback уже есть).
  let audio = [];
  if (settings.ttsEnabled) {
    let chain = Promise.resolve();
    audio = segments.map((seg) => {
      const p = chain.then(() => amadeus.speak(seg.text, seg.emotion, replySeed));
      chain = p.catch(() => {});
      return p;
    });
    audio.forEach((p) => p.catch(() => {}));
  }

  let shown = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (token !== speechToken) return;
    setEmotion(seg.emotion);

    let bytes = null;
    if (audio[i]) {
      setStatus('синтез голоса…');
      try {
        bytes = await audio[i];
      } catch (err) {
        if (Date.now() - ttsWarned > 60000) {
          toast(`Озвучка недоступна (запущен ли VoiceStudio?): ${err.message.replace(/^Error invoking remote method '[^']+': /, '')}`);
          ttsWarned = Date.now();
        }
      }
      setStatus('');
    }
    if (token !== speechToken) return;

    const prefix = shown;
    const progress = (p) => showSubtitle(prefix + seg.text.slice(0, Math.ceil(p * seg.text.length)));
    if (bytes) {
      try {
        await playAudio(bytes, token, progress);
      } catch {
        await fakeTalk(seg.text, token, progress);
      }
    } else {
      await fakeTalk(seg.text, token, progress);
    }
    shown += seg.text + ' ';
    // между кусками одной эмоции — короткая пауза, при смене эмоции — чуть длиннее
    if (i < segments.length - 1) await sleep(segments[i + 1].emotion === seg.emotion ? 60 : 180);
  }
  if (token === speechToken) {
    state.speaking = false;
    state.lastActivity = Date.now();
    scheduleIdle();
  }
}

// ── Вложения: файлы и фото ────────────────────────────────────────────
// Кнопка 📎, перетаскивание на экран или Ctrl+V. Большие фото ужимаются до 1600 px.
const MAX_FILE_MB = 20;
const IMAGE_MAX_SIDE = 1600;
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|cfg|conf|toml|ya?ml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|php|java|kt|cs|c|h|cpp|hpp|go|rs|swift|lua|sh|bat|cmd|ps1|sql|srt|vtt)$/i;
const attachments = []; // { name, mime, size, data (base64), url? (превью) }

function guessMime(file) {
  if (TEXT_EXT.test(file.name)) return 'text/plain'; // .ts — не видео, .md — не «octet-stream»
  if (file.type) return file.type;
  if (/\.pdf$/i.test(file.name)) return 'application/pdf';
  return 'application/octet-stream';
}

function fmtSize(n) {
  return n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Нейросети принимают jpeg/png/gif/webp до ~5 МБ: остальное и слишком большое перекодируем.
async function prepareImage(file, mime) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const ok = /^image\/(jpeg|png|gif|webp)$/.test(mime);
  if (ok && scale === 1 && file.size < 4 * 1048576) return { blob: file, mime };
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return { blob, mime: 'image/jpeg' };
}

async function addFiles(files) {
  for (const file of files) {
    try {
      if (file.size > MAX_FILE_MB * 1048576) throw new Error(`больше ${MAX_FILE_MB} МБ`);
      let mime = guessMime(file);
      let blob = file;
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') ({ blob, mime } = await prepareImage(file, mime));
      let name = file.name || `image.${mime.split('/')[1] || 'png'}`;
      if (blob !== file) name = name.replace(/\.\w+$/, '') + '.jpg';
      attachments.push({
        name, mime, size: blob.size,
        data: await blobToBase64(blob),
        url: mime.startsWith('image/') ? URL.createObjectURL(blob) : null,
      });
    } catch (err) {
      toast(`${file.name || 'Файл'}: ${err.message || err}`, 5000);
    }
  }
  renderAttachments();
  $('input').focus();
}

function removeAttachment(i) {
  const [a] = attachments.splice(i, 1);
  if (a?.url) URL.revokeObjectURL(a.url);
  renderAttachments();
}

function renderAttachments() {
  const box = $('attachments');
  box.textContent = '';
  attachments.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'att';
    el.title = a.name;
    if (a.url) {
      const img = document.createElement('img');
      img.src = a.url;
      el.appendChild(img);
    } else {
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = a.mime === 'application/pdf' ? '📕' : a.mime.startsWith('text/') ? '📄' : '📦';
      el.appendChild(ico);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = a.name;
    const sz = document.createElement('span');
    sz.textContent = fmtSize(a.size);
    meta.append(b, sz);
    const x = document.createElement('button');
    x.type = 'button';
    x.title = 'Убрать';
    x.textContent = '✕';
    x.addEventListener('click', () => removeAttachment(i));
    el.append(meta, x);
    box.appendChild(el);
  });
  box.classList.toggle('hidden', !attachments.length);
  document.querySelector('.screen').classList.toggle('has-att', attachments.length > 0);
}

function takeAttachments() {
  const files = attachments.map(({ name, mime, data }) => ({ name, mime, data }));
  attachments.splice(0).forEach((a) => a.url && URL.revokeObjectURL(a.url));
  renderAttachments();
  return files;
}

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});

// Перетаскивание из проводника. На корпус (область перетаскивания окна) Windows бросать не даёт — только на экран.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('drop-hint').classList.remove('hidden');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-hint').classList.add('hidden');
  }
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').classList.add('hidden');
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// ── Разговор ──────────────────────────────────────────────────────────
function cleanError(err) {
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ── Действия с компьютером: карточка разрешения, выполнение, результат обратно Курису ──
let pendingConfirm = null; // { resolve } — ждём «Разрешить/Отклонить» (кнопкой или голосом)
let toolDepth = 0; // сколько раз подряд Курису отвечала на результаты действий (защита от зацикливания)
const YES = /^(да|ага|давай|разрешаю|можно|ок(ей)?|окей|хорошо|конечно|делай|выполняй|yes|ok)\b/i;
const NO = /^(нет|не надо|не нужно|отмена|отмени|стоп|запрещаю|no)\b/i;

function askPermission(a) {
  const card = $('action-card');
  card.textContent = '';
  const title = document.createElement('div');
  title.className = 'action-title';
  title.textContent = `Курису хочет: ${a.title}`;
  const target = document.createElement('div');
  target.className = 'action-target';
  target.textContent = a.target;
  card.append(title, target);
  if (a.content !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'action-content';
    pre.textContent = a.content;
    card.appendChild(pre);
  }
  const row = document.createElement('div');
  row.className = 'action-buttons';
  const ok = document.createElement('button');
  ok.className = 'allow';
  ok.textContent = 'Разрешить';
  const no = document.createElement('button');
  no.textContent = 'Отклонить';
  const hint = document.createElement('div');
  hint.className = 'action-hint';
  hint.textContent = 'Можно ответить голосом: «да» или «нет»';
  row.append(ok, no);
  card.append(row, hint);
  card.classList.remove('hidden');
  card.classList.toggle('danger', !a.safe);

  return new Promise((resolve) => {
    const done = (v) => {
      pendingConfirm = null;
      card.classList.add('hidden');
      resolve(v);
    };
    pendingConfirm = { resolve: done };
    ok.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
  });
}

async function handleActions(actions, origin) {
  if (!actions || !actions.length) return;
  const results = [];
  let needReply = false;
  for (const a of actions) {
    const allowed = !a.confirm || await askPermission(a);
    if (!allowed) {
      amadeus.denyAction(a.id);
      results.push(`${a.title} (${a.target}): пользователь отклонил`);
      needReply = true;
      continue;
    }
    setStatus(`${a.title.toLowerCase()}…`);
    const r = await amadeus.runAction(a.id).catch((err) => ({ ok: false, text: cleanError(err) }));
    setStatus('');
    if (!r.ok) toast(`${a.title}: ${r.text}`, 6000);
    results.push(`${a.title} (${a.target}): ${r.text}`);
    if (!r.ok || ['read', 'list', 'run'].includes(a.type)) needReply = true;
  }
  // Прочитанное, вывод команды и ошибки возвращаем Курису, чтобы она ответила по ним.
  if (needReply && toolDepth < 4) {
    toolDepth++;
    await send(`[РЕЗУЛЬТАТ]\n${results.join('\n\n')}`, 'tool', [], origin);
  }
}

async function send(text, kind = 'user', files = [], origin = kind) {
  // Ответ «да/нет» голосом или текстом, пока висит карточка разрешения.
  if (kind === 'user' && pendingConfirm && !files.length) {
    if (YES.test(text)) return pendingConfirm.resolve(true);
    if (NO.test(text)) return pendingConfirm.resolve(false);
    pendingConfirm.resolve(false); // заговорили о другом — действие отменяется
  }
  if (kind === 'user') toolDepth = 0;
  const id = ++state.requestId;
  if (kind === 'user') {
    interrupt();
    const names = files.map((f) => `📎 ${f.name}`).join('\n');
    showSubtitle([text, names].filter(Boolean).join('\n'), settings.userName || 'Ты');
  }
  state.busy = true;
  state.lastActivity = Date.now();
  setStatus(kind === 'screen' ? 'смотрит на экран…' : files.length ? 'смотрит вложения…' : 'думает…');
  $('btn-mic').classList.add('busy');
  const thinking = kind === 'user' ? setTimeout(() => id === state.requestId && setEmotion('thinking'), 700) : null;

  try {
    const reply = await amadeus.chat({ text, kind, files, origin });
    clearTimeout(thinking);
    if (id !== state.requestId) return; // пришёл более новый запрос
    if (reply.silent) {
      if (kind !== 'screen') setEmotion('neutral');
      return;
    }
    state.busy = false;
    setStatus('');
    if (reply.segments.length) await performReply(reply.segments);
    $('btn-mic').classList.remove('busy');
    await handleActions(reply.actions, origin);
  } catch (err) {
    clearTimeout(thinking);
    if (id !== state.requestId) return;
    toast(cleanError(err), 9000);
    setEmotion('troubled');
    scheduleIdle();
  } finally {
    if (id === state.requestId) {
      state.busy = false;
      state.lastActivity = Date.now();
      setStatus('');
      $('btn-mic').classList.remove('busy');
    }
  }
}

$('input-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text && !attachments.length) return;
  $('input').value = '';
  send(text, 'user', takeAttachments());
});

// ── Голосовой ввод: клик — начать, тишина 1.4 с или повторный клик — отправить ──
let recorder = null;

async function startRecording() {
  interrupt();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    toast(`Нет доступа к микрофону: ${err.message}`);
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const mr = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  const ctx = getAudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const mic = ctx.createMediaStreamSource(stream);
  mic.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const started = performance.now();
  let heard = false;
  let lastLoud = started;
  let cancelled = false;

  recorder = {
    stop(cancel = false) {
      cancelled = cancel;
      if (mr.state !== 'inactive') mr.stop();
    },
  };
  state.recording = true;
  $('btn-mic').classList.add('recording');
  setStatus('слушаю…');
  setEmotion('neutral');

  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    mic.disconnect();
    recorder = null;
    state.recording = false;
    $('btn-mic').classList.remove('recording');
    setStatus('');
    if (cancelled || !heard) return;
    setStatus('распознаю речь…');
    try {
      const blob = new Blob(chunks, { type: mime });
      const text = (await amadeus.transcribe(await blob.arrayBuffer(), mime)).trim();
      setStatus('');
      if (text) send(text);
      else toast('Не расслышала, повтори.', 3000);
    } catch (err) {
      setStatus('');
      toast(`Распознавание речи: ${cleanError(err)}`, 9000);
    }
  };
  mr.start(250);

  const watch = () => {
    if (mr.state === 'inactive') return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (rms > 0.025) { heard = true; lastLoud = now; }
    if (heard && now - lastLoud > 1400) return recorder?.stop();
    if (!heard && now - started > 8000) return recorder?.stop(true);
    if (now - started > 60000) return recorder?.stop();
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

function toggleMic() {
  if (recorder) recorder.stop();
  else startRecording();
}
$('btn-mic').addEventListener('click', toggleMic);
amadeus.onMicToggle(toggleMic);

// ── Скриншоты по таймеру ──────────────────────────────────────────────
let visionOk = false;
setInterval(() => {
  const minutes = Number(settings.screenshotMinutes) || 0;
  if (!minutes || !visionOk) return;
  if (state.busy || state.speaking || state.recording || pendingConfirm) return;
  if (document.activeElement === $('input') && $('input').value) return;
  if (!$('settings').classList.contains('hidden')) return;
  if (Date.now() - state.lastActivity < minutes * 60000) return;
  state.lastActivity = Date.now();
  send(null, 'screen');
}, 10000);

// ── История ───────────────────────────────────────────────────────────
async function openLog() {
  const list = $('log-list');
  list.textContent = '';
  const history = await amadeus.getHistory();
  for (const m of history.slice(-200)) {
    if (m.kind) continue; // системные события и скриншоты
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    const b = document.createElement('b');
    b.textContent = m.role === 'user' ? (settings.userName || 'Ты') : 'Amadeus';
    const t = document.createElement('time');
    t.textContent = m.ts ? new Date(m.ts).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    b.appendChild(t);
    div.append(b, document.createTextNode(m.content.replace(/\[[a-z_]+\]\s*/g, '')));
    list.appendChild(div);
  }
  if (!history.length) list.textContent = 'Пока пусто.';
  $('log').classList.remove('hidden');
  list.scrollTop = list.scrollHeight;
}
$('btn-log').addEventListener('click', openLog);

// ── Настройки ─────────────────────────────────────────────────────────
const WEB_SITES = [['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['deepseek', 'DeepSeek'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['qwen', 'Qwen']];
const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', yandex: 'Яндекс.Браузер' };

// h — раздел (сворачивается), only — поле видно, только когда выбран этот провайдер
// (основной, для скриншотов или для распознавания речи).
const SCHEMA = [
  { h: 'Нейросеть', open: true },
  { k: 'provider', l: 'Кто отвечает', opts: [['web', 'Без ключа — сайт нейросети'], ['anthropic', 'Claude API'], ['openai', 'ChatGPT API'], ['deepseek', 'DeepSeek API'], ['opencode', 'OpenCode (локально, без ключа)']] },
  { k: 'webSite', only: 'web', l: 'Сайт', opts: WEB_SITES, hint: 'Модель выбирается на самом сайте: «Показать браузер» → меню моделей (например Haiku у Claude). Сайт запоминает выбор' },
  { webButtons: true, only: 'web' },
  { k: 'loginBrowser', only: 'web', l: 'Браузер для входа', opts: [['auto', 'Браузер по умолчанию'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['yandex', 'Яндекс.Браузер']] },
  { k: 'anthropicKey', only: 'anthropic', l: 'API-ключ Anthropic', type: 'password' },
  { k: 'anthropicModel', only: 'anthropic', l: 'Модель', hint: 'claude-haiku-5-5 — быстрая и дешёвая' },
  { k: 'openaiKey', only: 'openai', l: 'API-ключ OpenAI', type: 'password' },
  { k: 'openaiModel', only: 'openai', l: 'Модель' },
  { k: 'openaiBaseUrl', only: 'openai', l: 'Адрес API', hint: 'Можно указать OpenRouter или другой OpenAI-совместимый сервер' },
  { k: 'deepseekKey', only: 'deepseek', l: 'API-ключ DeepSeek', type: 'password' },
  { k: 'deepseekModel', only: 'deepseek', l: 'Модель' },
  { k: 'opencodeModel', only: 'opencode', l: 'Модель OpenCode', list: 'oc-models', hint: 'Ключ не нужен — ответы идут через установленное приложение OpenCode. Кнопка ниже подтягивает список: например opencode/glm-5.3-flash-free, у моделей с «vl» в названии есть зрение' },
  { opencodeButtons: true, only: 'opencode' },
  { k: 'opencodeCli', only: 'opencode', l: 'Путь к opencode-cli.exe', hint: 'Пусто — Amadeus найдёт сам' },
  { k: 'temperature', l: 'Живость ответов (температура)', type: 'range', step: 0.05, min: 0, max: 1.5 },

  { h: 'Характер и память' },
  { k: 'userName', l: 'Как Курису тебя называет' },
  { k: 'personaPrompt', l: 'Характер Курису (начальный промпт)', type: 'textarea', hint: '{{имя}} заменяется на твоё имя. Правила эмоций, памяти и скриншотов добавляются автоматически — их писать не нужно' },
  { personaButtons: true },
  { k: 'summarizeEvery', l: 'Пересказывать разговор каждые N ответов', type: 'number', min: 5, max: 200, hint: 'Курису пересказывает разговор, и дальше нейросеть получает пересказ и последние реплики вместо всей переписки. На сайте при этом начинается новый чат' },
  { memoryButtons: true },

  { h: 'Доступ к компьютеру' },
  { k: 'toolsEnabled', l: 'Разрешить Курису открывать сайты, файлы и программы, читать и менять файлы, выполнять команды', type: 'checkbox' },
  { k: 'toolsAutoSafe', l: 'Открыть / прочитать / посмотреть папку по моей просьбе — без подтверждения', type: 'checkbox' },
  { k: 'toolsAutoChanges', l: 'Изменить файл / выполнить команду по моей просьбе — без подтверждения', type: 'checkbox', hint: 'Выключено — на каждое изменение и команду появляется карточка «Разрешить / Отклонить». Если Курису сама что-то предлагает, она всегда сначала спрашивает. Старые версии изменённых файлов сохраняются в %APPDATA%\\Amadeus\\file-backups' },

  { h: 'Взгляд на экран' },
  { k: 'screenshotMinutes', l: 'Смотреть на экран каждые N минут тишины (0 — выкл.)', type: 'number', step: 0.5, min: 0 },
  { k: 'visionProvider', l: 'Кто смотрит скриншоты', opts: [['auto', 'Тот же, кто отвечает'], ['web', 'Сайт нейросети'], ['anthropic', 'Claude API'], ['openai', 'ChatGPT API'], ['opencode', 'OpenCode']], hint: 'DeepSeek API картинки не видит. Для OpenCode нужна модель со зрением (в названии «vl»)' },
  { k: 'webVisionSite', only: 'web', l: 'Сайт для скриншотов', opts: WEB_SITES, hint: 'Нужен вход и на этом сайте. Claude картинки принимает надёжно' },

  { h: 'Озвучка (ответы Курису)' },
  { k: 'ttsEnabled', l: 'Озвучивать ответы', type: 'checkbox' },
  { k: 'ttsBackend', l: 'Движок озвучки', opts: [['local', 'Локальный (OmniVoice, без VoiceStudio)'], ['voicestudio', 'VoiceStudio (HTTP-сервер)'], ['silero', 'Silero (лёгкий синтез)']] },
  { h: 'Локальный движок (OmniVoice)' },
  { k: 'ttsPython', l: 'Python (env с OmniVoice)', only: 'local', hint: 'python.exe из venv, где установлен OmniVoice: …\\venv\\Scripts\\python.exe' },
  { k: 'ttsModelDir', l: 'Папка модели OmniVoice', only: 'local', hint: 'Папка с model.safetensors и tokenizer.json' },
  { k: 'ttsRefAudio', l: 'Референс Курису (файл)', only: 'local', hint: 'Аудио с голосом для клонирования (wav/ogg/mp3)' },
  { k: 'ttsRefTextFile', l: 'Референс: текст оригинала (файл)', only: 'local', hint: 'Текст, который произнесён в референсной записи' },
  { k: 'ttsSteps', l: 'Шагов генерации', type: 'number', min: 4, max: 64, step: 1, unit: '', only: 'local', hint: 'Меньше — быстрее и чуть «проще», до 16 уже хорошо. 32 — чуть длиннее тихий этап' },
  { h: 'Silero (лёгкий базовый синтез)' },
  { k: 'sileroPython', l: 'Python (env с Silero)', only: 'silero', hint: 'python.exe из venv с Silero: …\\venv\\Scripts\\python.exe' },
  { k: 'sileroModel', l: 'Модель Silero (файл)', only: 'silero', hint: 'Файл модели v5 ru: silero_tts_ru_v5.pt' },
  { k: 'sileroSpeaker', l: 'Голос Silero (v5_…_ru)', only: 'silero', hint: 'aidar, baya, kseniya, xenia, eugene — голос Silero, который будет базовым' },
  { k: 'sileroLanguage', l: 'Язык Silero', only: 'silero', hint: 'ru — русский' },
  { h: 'VoiceStudio (если выбран движок выше)' },
  { k: 'voiceStudioUrl', l: 'Адрес VoiceStudio', only: 'voicestudio' },
  { k: 'voice', l: 'Голос (имя или id профиля)', list: 'voices', only: 'voicestudio', hint: 'Нужен только при движке «VoiceStudio»' },
  { voiceButtons: true },
  { k: 'ttsEngine', l: 'Движок TTS', only: 'voicestudio', hint: 'Пусто — как выбрано в VoiceStudio. Эмоции в голосе лучше всего у cosyvoice, voxcpm2, indextts2' },
  { k: 'ttsEmotion', l: 'Передавать эмоции в голос (тон и темп)', type: 'checkbox', only: 'voicestudio' },
  { k: 'volume', l: 'Громкость', type: 'range', step: 0.05, min: 0, max: 1, unit: '×' },
  { voiceTest: true },
  { k: 'sttProvider', l: 'Распознавание речи', opts: [['voicestudio', 'VoiceStudio (локально)'], ['openai', 'OpenAI Whisper (нужен ключ OpenAI)']] },
  { k: 'micHotkey', l: 'Горячая клавиша микрофона', hint: 'Например Control+Alt+A. Пусто — выключено' },

  { h: 'Внешний вид' },
  { k: 'outfit', l: 'Наряд', opts: [['coat', 'В халате'], ['jacket', 'Без халата'], ['amadeus', 'Amadeus (как в приложении)']] },
  { k: 'framing', l: 'Кадр', opts: [['bust', 'Крупно (по грудь)'], ['waist', 'По пояс'], ['full', 'В полный рост']], hint: 'Для версии Amadeus есть только крупный план' },
  { k: 'phoneFrame', l: 'Рамка телефона (корпус)', type: 'checkbox', hint: 'Без рамки — Курису занимает всё окно, без корпуса телефона' },
  { k: 'windowScale', l: 'Размер окна на экране', type: 'range', min: 40, max: 250, step: 5, unit: '%', hint: 'Всё окно целиком, пропорционально. Применяется при сохранении' },
  { k: 'charScale', l: 'Размер Курису внутри экрана', type: 'range', min: 40, max: 250, step: 5, unit: '%', live: true, hint: 'Быстро: Ctrl + колесо мыши над Курису' },
  { k: 'charOffsetY', l: 'Сдвиг Курису вверх/вниз', type: 'range', min: -60, max: 60, step: 1, unit: '%', live: true, hint: 'Быстро: Shift + колесо мыши над Курису' },
  { k: 'alwaysOnTop', l: 'Поверх всех окон', type: 'checkbox' },
  { k: 'bootAnimation', l: 'Заставка при запуске', type: 'checkbox' },
];

let defaultPersona = '';

function buttonRow(items) {
  const row = document.createElement('div');
  row.className = 'row';
  for (const [text, fn, cls] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', async () => {
      try { await fn(b); } catch (err) { toast(cleanError(err)); }
    });
    row.appendChild(b);
  }
  return row;
}

// Вход на сайт нейросети: статус + кнопки.
function buildWebBox() {
  const box = document.createElement('div');
  box.className = 'web-box';
  const status = document.createElement('div');
  status.className = 'hint status-line';
  const form = $('settings-form');
  const site = () => form.elements.webSite.value;
  let toggleBtn;
  const refresh = async () => {
    status.textContent = 'Проверяю вход…';
    try {
      const st = await amadeus.webStatus(site());
      status.textContent = st.loggedIn ? '✓ Вход выполнен' : '✗ Вход не выполнен';
      status.classList.toggle('ok', st.loggedIn);
      toggleBtn.textContent = st.visible ? 'Скрыть браузер' : 'Показать браузер';
    } catch (err) {
      status.textContent = cleanError(err);
    }
  };
  const browserName = BROWSER_NAMES[defaultBrowser] || 'браузер';
  // Одна кнопка в два шага: «Войти через Chrome» открывает браузер, «Перенести вход» забирает куки.
  // Куки переносятся только по второму нажатию.
  let loginBtn;
  const updateLoginBtn = async () => {
    const open = await amadeus.webLoginOpen(site());
    loginBtn.textContent = open ? 'Перенести вход' : `Войти через ${browserName}`;
    loginBtn.dataset.step = open ? 'transfer' : 'open';
  };
  const row = buttonRow([
    [`Войти через ${browserName}`, async (b) => {
      b.disabled = true;
      try {
        if (b.dataset.step === 'transfer') {
          status.textContent = 'Переношу вход…';
          const n = await amadeus.webTransferLogin(site());
          toast(`Вход перенесён в Amadeus (куки: ${n})`, 3000);
          refresh();
        } else {
          status.textContent = 'Открываю браузер…';
          await amadeus.webLoginBrowser(site(), form.elements.loginBrowser.value);
        }
      } finally {
        b.disabled = false;
        updateLoginBtn();
      }
    }, 'primary'],
    ['Войти здесь', async () => { await amadeus.webLoginHere(site()); refresh(); }],
    ['Показать браузер', async () => { await amadeus.webToggle(site()); refresh(); }],
  ]);
  [loginBtn, , toggleBtn] = row.children;
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = `Через ${browserName}: откроется браузер, войди как обычно (Google там не блокирует), потом нажми «Перенести вход» — только тогда куки попадут в Amadeus. «Войти здесь» — для входа по почте. «Показать браузер» — посмотреть, почему завис ответ`;
  box.append(status, row, hint);
  box.refresh = async () => { await refresh(); await updateLoginBtn(); };
  webLoginStatusEl = status;
  return box;
}

// Статус входа через внешний браузер приходит из main; показываем его в открытой форме настроек.
let webLoginStatusEl = null;
amadeus.onWebLoginStatus((msg) => {
  if (webLoginStatusEl && webLoginStatusEl.isConnected) {
    webLoginStatusEl.textContent = msg;
    webLoginStatusEl.classList.toggle('ok', /обнаружен/.test(msg));
  }
  if (/закрыт|не запустился/.test(msg)) $('settings-form').querySelector('.web-box')?.refresh();
});

// Поля с only видны, только когда этот провайдер где-то выбран.
function updateOnlyRows() {
  const els = $('settings-form').elements;
  const active = new Set([els.provider.value, els.visionProvider.value, els.ttsBackend.value]);
  if (els.visionProvider.value === 'auto') active.add(els.provider.value);
  if (els.sttProvider.value === 'openai') active.add('openai');
  for (const el of $('settings-form').querySelectorAll('[data-only]')) {
    el.classList.toggle('hidden', !active.has(el.dataset.only));
  }
}

function buildField(f) {
  const label = document.createElement('label');
  if (f.only) label.dataset.only = f.only;
  let input;
  if (f.opts) {
    input = document.createElement('select');
    for (const [v, t] of f.opts) input.add(new Option(t, v));
    input.value = settings[f.k];
  } else if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 12;
    input.value = settings[f.k] || defaultPersona;
  } else {
    input = document.createElement('input');
    input.type = f.type || 'text';
    for (const a of ['step', 'min', 'max']) if (f[a] !== undefined) input[a] = f[a];
    if (f.list) input.setAttribute('list', f.list);
    if (input.type === 'checkbox') input.checked = !!settings[f.k];
    else input.value = settings[f.k] ?? '';
  }
  input.name = f.k;
  if (input.type === 'checkbox') {
    label.className = 'check';
    label.append(input, document.createTextNode(f.l));
  } else if (input.type === 'range') {
    const value = document.createElement('span');
    value.className = 'range-value';
    const show = () => { value.textContent = ` ${input.value}${f.unit || ''}`; };
    input.addEventListener('input', () => {
      show();
      if (f.live) applyCharTransform({ ...settings, [f.k]: Number(input.value) });
    });
    show();
    label.append(document.createTextNode(f.l), value, input);
  } else {
    label.append(document.createTextNode(f.l), input);
  }
  if (f.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = f.hint;
    label.appendChild(hint);
  }
  return label;
}

let defaultBrowser = null;

async function buildSettingsForm() {
  if (!defaultPersona) defaultPersona = await amadeus.defaultPersona();
  if (defaultBrowser === null) defaultBrowser = (await amadeus.webDefaultBrowser()) || '';
  const form = $('settings-form');
  form.textContent = '';
  let section = form;
  let webBox = null;
  for (const f of SCHEMA) {
    if (f.h) {
      section = document.createElement('details');
      section.open = !!f.open;
      const sum = document.createElement('summary');
      sum.textContent = f.h;
      section.appendChild(sum);
      form.appendChild(section);
    } else if (f.webButtons) {
      webBox = buildWebBox();
      webBox.dataset.only = f.only;
      section.appendChild(webBox);
    } else if (f.personaButtons) {
      section.appendChild(buttonRow([
        ['Вернуть стандартный характер', () => { form.elements.personaPrompt.value = defaultPersona; }],
      ]));
    } else if (f.memoryButtons) {
      section.appendChild(buttonRow([
        ['Показать пересказ', async () => {
          const s = await amadeus.getSummary();
          alert(s.text ? `Пересказ прошлого разговора:\n\n${s.text}` : 'Пересказа пока нет — он появится после первых ответов.');
        }],
        ['Очистить диалог', async () => {
          if (confirm('Удалить историю разговора и пересказ? Долговременная память останется.')) {
            await amadeus.clearHistory();
            toast('История очищена', 2500);
          }
        }],
        ['Стереть память', async () => {
          const mem = await amadeus.getMemory();
          if (confirm(`Курису помнит о тебе ${mem.length} фактов:\n\n${mem.map((m) => '• ' + m.text).join('\n')}\n\nСтереть?`)) {
            await amadeus.clearMemory();
            toast('Память стёрта', 2500);
          }
        }],
      ]));
    } else if (f.voiceButtons) {
      section.appendChild(buttonRow([['Голоса из VoiceStudio', loadVoices]]));
    } else if (f.opencodeButtons) {
      const row = buttonRow([['Модели из OpenCode', () => loadOpencodeModels()]]);
      if (f.only) row.dataset.only = f.only;
      section.appendChild(row);
    } else if (f.voiceTest) {
      section.appendChild(buttonRow([['Проверить голос', testVoice]]));
    } else {
      section.appendChild(buildField(f));
    }
  }
  const datalist = document.createElement('datalist');
  datalist.id = 'voices';
  form.appendChild(datalist);
  const ocList = document.createElement('datalist');
  ocList.id = 'oc-models';
  form.appendChild(ocList);

  const footer = buttonRow([['Сохранить', saveSettings, 'primary'], ['Отмена', closeOverlays]]);
  footer.classList.add('footer');
  form.appendChild(footer);

  for (const k of ['provider', 'visionProvider', 'sttProvider', 'ttsBackend']) form.elements[k].addEventListener('change', updateOnlyRows);
  form.elements.webSite.addEventListener('change', () => webBox?.refresh());
  updateOnlyRows();
  webBox?.refresh();
  if (form.elements.provider.value === 'opencode') loadOpencodeModels(true);
}

async function loadVoices() {
  try {
    const voices = await amadeus.listVoices();
    const dl = $('voices');
    dl.textContent = '';
    for (const v of voices) dl.appendChild(new Option(v.name, v.name));
    toast(voices.length ? `Голоса: ${voices.map((v) => v.name).join(', ')}` : 'В VoiceStudio нет сохранённых голосов', 5000);
  } catch (err) {
    toast(`VoiceStudio не отвечает: ${cleanError(err)}`);
  }
}

// Список моделей из установленного OpenCode (opencode models).
async function loadOpencodeModels(silent = false) {
  const dl = $('oc-models');
  try {
    const models = await amadeus.opencodeModels();
    dl.textContent = '';
    for (const m of models) dl.appendChild(new Option(m, m));
    if (!silent) {
      toast(models.length ? `Модели OpenCode (${models.length}): ${models.slice(0, 6).join(', ')}…` : 'OpenCode не вернул моделей — проверь вход в приложение', 6000);
    }
  } catch (err) {
    if (!silent) toast(`OpenCode не отвечает: ${cleanError(err)}`);
  }
}

async function saveSettings(close = true) {
  if (typeof close !== 'boolean') close = true; // клик по кнопке передаёт событие
  const patch = {};
  for (const f of SCHEMA) {
    if (!f.k) continue;
    const el = $('settings-form').elements[f.k];
    if (el.type === 'checkbox') patch[f.k] = el.checked;
    else if (['number', 'range'].includes(el.type)) patch[f.k] = Number(el.value);
    else patch[f.k] = el.value.trim();
  }
  // Стандартный характер не сохраняем текстом — тогда будущие улучшения стандартного применятся сами.
  if (patch.personaPrompt === defaultPersona.trim()) patch.personaPrompt = '';

  // Пользователь настроил OpenCode (путь/модель) — значит, им и хотим отвечать.
  // Иначе легко забыть переключить «Кто отвечает» и получить ошибку от сайта.
  const touchedOpenCode = (patch.opencodeModel && patch.opencodeModel !== settings.opencodeModel)
    || (patch.opencodeCli && patch.opencodeCli !== settings.opencodeCli);
  let switched = false;
  if (touchedOpenCode && patch.provider === 'web') {
    patch.provider = 'opencode';
    switched = true;
  }

  await applySettings(await amadeus.setSettings(patch));
  if (close) $('settings').classList.add('hidden');
  toast(switched ? 'Сохранено. Отвечать будет OpenCode' : 'Сохранено', switched ? 3000 : 1500);
}

// Проба голоса прямо из настроек: синтез + воспроизведение.
async function testVoice() {
  try {
    await saveSettings(false); // берём то, что сейчас в форме
    toast('Синтезирую пробу голоса… (первый раз ~15 с)', 6000);
    interrupt();
    const token = speechToken;
    const bytes = await amadeus.speak('Привет. Это проверка голоса Курису.', 'smile', 7);
    if (token !== speechToken) return;
    toast('Проба готова', 2000);
    await playAudio(bytes, token, () => {});
  } catch (err) {
    toast(`Проба голоса не получилась: ${cleanError(err)}`, 6000);
  }
}

function applyCharTransform(s) {
  const stage = $('stage');
  stage.style.setProperty('--char-scale', (Number(s.charScale) || 100) / 100);
  stage.style.setProperty('--char-y', `${Number(s.charOffsetY) || 0}%`);
}

async function applySettings(s) {
  const lookChanged = s.outfit !== settings.outfit || s.framing !== settings.framing;
  settings = s;
  document.body.className = `outfit-${s.outfit} framing-${s.outfit === 'amadeus' ? 'bust' : s.framing}`;
  document.body.classList.toggle('no-frame', s.phoneFrame === false);
  document.body.classList.toggle('fullscreen', fullscreenOn);
  applyCharTransform(s);
  if (lookChanged) {
    imageCache.clear();
    await setEmotion(char.emotion, { force: true });
  }
  visionOk = await amadeus.visionAvailable();
}

$('btn-settings').addEventListener('click', async () => {
  await buildSettingsForm();
  $('settings').classList.remove('hidden');
});
function closeOverlays() {
  document.querySelectorAll('.overlay').forEach((o) => o.classList.add('hidden'));
  applyCharTransform(settings); // отменить несохранённый предпросмотр масштаба
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlays));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlays();
});

// Ctrl + колесо — размер Курису, Shift + колесо — сдвиг вверх/вниз. Сохраняется через секунду.
let wheelSave = null;
$('stage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.shiftKey) return;
  e.preventDefault();
  const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
  if (e.ctrlKey) settings.charScale = Math.max(40, Math.min(250, (Number(settings.charScale) || 100) + dir * 5));
  else settings.charOffsetY = Math.max(-60, Math.min(60, (Number(settings.charOffsetY) || 0) + dir * 2));
  applyCharTransform(settings);
  setStatus(`Курису: ${settings.charScale}% · сдвиг ${settings.charOffsetY}%`);
  clearTimeout(wheelSave);
  wheelSave = setTimeout(() => {
    amadeus.setSettings({ charScale: settings.charScale, charOffsetY: settings.charOffsetY });
    setStatus('');
  }, 1000);
}, { passive: false });
$('btn-max').addEventListener('click', async () => {
  const on = await amadeus.fullscreen();
  fullscreenOn = !!on;
  document.body.classList.toggle('fullscreen', !!on);
});
$('btn-min').addEventListener('click', () => amadeus.minimize());
$('btn-close').addEventListener('click', () => amadeus.close());

// ── Фон с бинарным кодом ──────────────────────────────────────────────
function fillBinary() {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    const bits = (n) => Array.from({ length: n }, () => (Math.random() < 0.5 ? '0' : '1')).join('');
    const row = [0, 1, 2, 3, 4].map((j) => `/${bits(10 + ((i + j * 3) * 7) % 14)}`.padEnd(34)).join('');
    lines.push(i % 9 === 4 ? '-'.repeat(30).padEnd(68) + '-'.repeat(30) : row);
  }
  $('binary').textContent = lines.join('\n');
}

// ── Запуск ────────────────────────────────────────────────────────────
async function boot() {
  const boot = $('boot');
  if (!settings.bootAnimation) {
    boot.classList.add('done');
    return;
  }
  const log = $('boot-log');
  const steps = [
    'Amadeus.system v2.11 — login: Salieri',
    'connecting to Viktor Chondria Univ. server...',
    'loading memory data [Makise Kurisu]...',
    'neural network synchronized.',
  ];
  requestAnimationFrame(() => { boot.querySelector('.boot-bar i').style.width = '100%'; });

  // Сборка логотипа: кадры из игры (assets/ui/logo_anim), ~24 к/с.
  const LOGO_FRAMES = 37;
  const frames = Array.from({ length: LOGO_FRAMES }, (_, i) => `../assets/ui/logo_anim/${String(i).padStart(2, '0')}.webp`);
  await Promise.all(frames.map((src) => { const im = new Image(); im.src = src; return im.decode().catch(() => {}); }));
  const logo = $('boot-logo');
  const anim = (async () => {
    for (const src of frames) {
      logo.src = src;
      await sleep(42);
    }
  })();
  for (const s of steps) {
    log.textContent += s + '\n';
    await sleep(380);
  }
  await anim;
  await sleep(500);
  boot.classList.add('done');
  await sleep(400);
}

(async function init() {
  fillBinary();
  await applySettings(await amadeus.getSettings());
  await setEmotion('neutral', { force: true });
  await boot();

  const keyField = { anthropic: 'anthropicKey', openai: 'openaiKey', deepseek: 'deepseekKey' }[settings.provider];
  if (keyField && !settings[keyField]) {
    setEmotion('doubt');
    showSubtitle('Нет ключа API для нейросети. Открой настройки ⚙ и укажи его — иначе мне нечем думать.');
    return;
  }
  send('[СИСТЕМА] Пользователь только что запустил Amadeus. Поприветствуй его коротко, по-своему.', 'event');
})();
