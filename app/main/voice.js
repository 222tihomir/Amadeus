// Озвучка: по умолчанию OmniVoice напрямую (tts_worker.py, без приложения VoiceStudio),
// по желанию — через HTTP-API VoiceStudio. Распознавание речи — VoiceStudio или OpenAI.
// После синтеза звук может проходить через обученную RVC-модель (голос Курису) — см. rvc_worker.py.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BY_ID } = require('../shared/emotions');

const base = (s) => s.voiceStudioUrl.replace(/\/$/, '');

// ── Локальная озвучка: OmniVoice напрямую ───────────────────────────────
// Тот же движок, что использует VoiceStudio, но без самого приложения:
// пути к модели и референсу голоса задаются в настройках.
const TTS_WORKER = path.join(__dirname, 'tts_worker.py');
const TTS_TEMP = path.join(os.tmpdir(), 'amadeus-tts');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function ttsConfig(s) {
  if (!s || s.ttsBackend !== 'local') return null;
  const python = (s.ttsPython || '').trim();
  const model = (s.ttsModelDir || '').trim();
  const ref = (s.ttsRefAudio || '').trim();
  const refText = (s.ttsRefTextFile || '').trim();
  if (!python || !isFile(python)) return null;
  if (!model || !isDir(model)) return null;
  if (!ref || !isFile(ref) || !refText || !isFile(refText)) return null;
  return {
    key: [python, model, ref, refText].join('|'),
    python,
    model,
    ref,
    refText,
    language: s.language || 'ru',
    steps: Math.max(4, Math.min(64, Number(s.ttsSteps) || 16)),
  };
}

let tts = null; // { key, proc, buf, waiting, ready, stderr, readyWaiter, readyPromise }

function stopTts() {
  const cur = tts;
  tts = null;
  if (!cur) return;
  try { cur.proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* уже закрыт */ }
  const proc = cur.proc;
  setTimeout(() => { try { proc.kill(); } catch { /* уже завершён */ } }, 1500).unref?.();
  if (cur.waiting) {
    cur.waiting.reject(new Error('TTS-воркер остановлен'));
    cur.waiting = null;
  }
}

// Запускает воркер (один раз) и ждёт, пока модель и голосовой промпт будут готовы.
function startTts(cfg) {
  if (tts && tts.key === cfg.key) return tts.readyPromise;
  stopTts();

  const proc = spawn(cfg.python, ['-X', 'utf8', TTS_WORKER, cfg.model, cfg.ref, cfg.refText, cfg.language], {
    cwd: path.dirname(TTS_WORKER),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = { key: cfg.key, proc, buf: '', waiting: null, ready: false, stderr: '', readyWaiter: null, readyPromise: null };
  tts = state;

  const settleReady = (err) => {
    const w = state.readyWaiter;
    state.readyWaiter = null;
    if (!w) return;
    if (err) w.reject(err); else w.resolve(state);
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    state.buf += d;
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { state.ready = true; settleReady(null); continue; }
      if (!state.ready && msg.ok === false) { settleReady(new Error(msg.error || 'TTS не запустился')); continue; }
      const w = state.waiting;
      if (w) {
        state.waiting = null;
        if (msg.ok) w.resolve(msg); else w.reject(new Error(msg.error || 'TTS: ошибка'));
      }
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    state.stderr = (state.stderr + d).slice(-4000);
  });

  proc.on('error', (err) => {
    if (tts === state) tts = null;
    settleReady(err);
    if (state.waiting) {
      state.waiting.reject(err);
      state.waiting = null;
    }
  });

  proc.on('close', (code) => {
    if (tts === state) tts = null;
    const err = new Error(`TTS-воркер завершился (код ${code})${state.stderr ? `: ${state.stderr.slice(-300)}` : ''}`);
    settleReady(err);
    if (state.waiting) {
      state.waiting.reject(err);
      state.waiting = null;
    }
  });

  state.readyPromise = new Promise((resolve, reject) => {
    state.readyWaiter = { resolve: () => resolve(state), reject };
    setTimeout(() => {
      if (!state.ready) {
        settleReady(new Error('TTS не загрузился за 5 минут'));
        try { proc.kill(); } catch { /* уже закрыт */ }
      }
    }, 300000).unref?.();
  });
  return state.readyPromise;
}

function ttsSpeak(cfg, text, opts = {}) {
  return (async () => {
    const st = await startTts(cfg);
    const out = path.join(TTS_TEMP, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.mkdirSync(TTS_TEMP, { recursive: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        st.waiting = null;
        stopTts();
        reject(new Error('TTS не ответил за 3 минуты'));
      }, 180000);
      st.waiting = {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      st.proc.stdin.write(`${JSON.stringify({
        cmd: 'speak',
        text,
        out,
        language: opts.language || cfg.language,
        steps: opts.steps || cfg.steps,
        speed: opts.speed || 1,
        instruct: opts.instruct || '',
        seed: opts.seed || 0,
      })}\n`);
    });
    try {
      return fs.readFileSync(out);
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* нет файла */ }
    }
  })();
}

function synthesizeLocal(s, text, emotion, seed) {
  const cfg = ttsConfig(s);
  if (!cfg) throw new Error('локальная озвучка не настроена');
  const e = BY_ID[emotion] || BY_ID.neutral;
  return ttsSpeak(cfg, text, {
    language: s.language || 'ru',
    steps: cfg.steps,
    speed: s.ttsEmotion ? e.speed : 1,
    seed: seed || 0,
  });
}

// ── Локальная озвучка: Silero → RVC ───────────────────────────────────────
// Вес вместо OmniVoice (~9,7 ГБ): модель Silero + CPU, без torch-venv и GPU.
// Silero генерирует русскую речь из текста, затем applyRvc (RVC «Курису») её перекрашивает.
const SILERO_WORKER = path.join(__dirname, 'silero_worker.py');
let silero = null; // { key, proc, buf, waiting, ready, stderr }

function stopSilero() {
  const cur = silero;
  silero = null;
  if (!cur) return;
  try { cur.proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* уже закрыт */ }
  const proc = cur.proc;
  setTimeout(() => { try { proc.kill(); } catch { /* уже завершён */ } }, 1500).unref?.();
  if (cur.waiting) {
    cur.waiting.reject(new Error('Silero-воркер остановлен'));
    cur.waiting = null;
  }
}

// Silero нужен только при ttsBackend === 'silero'; остальные значения не трогаем.
function sileroConfig(s) {
  if (!s || (s.ttsBackend || 'local') !== 'silero') return null;
  const python = (s.sileroPython || '').trim();
  const model = (s.sileroModel || '').trim();
  if (!python || !isFile(python)) return null;
  if (!model || !isFile(model)) return null;
  const speaker = (s.sileroSpeaker || 'baya').trim();
  const language = (s.sileroLanguage || 'ru').trim();
  if (!speaker) return null;
  return { key: [python, model, speaker, language].join('|'), python, model, speaker, language };
}

function startSilero(cfg) {
  if (silero && silero.key === cfg.key) return silero.readyPromise;
  stopSilero();

  const proc = spawn(cfg.python, ['-X', 'utf8', SILERO_WORKER, cfg.model, cfg.language, cfg.speaker], {
    cwd: path.dirname(SILERO_WORKER),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = { key: cfg.key, proc, buf: '', waiting: null, ready: false, stderr: '', readyWaiter: null, readyPromise: null };
  silero = state;

  const settleReady = (err) => {
    const w = state.readyWaiter;
    state.readyWaiter = null;
    if (!w) return;
    if (err) w.reject(err); else w.resolve(state);
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    state.buf += d;
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { state.ready = true; settleReady(null); continue; }
      if (!state.ready && msg.ok === false) { settleReady(new Error(msg.error || 'Silero не запустился')); continue; }
      const w = state.waiting;
      if (w) { state.waiting = null; if (msg.ok) w.resolve(msg); else w.reject(new Error(msg.error || 'Silero: ошибка')); }
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-4000); });

  proc.on('error', (err) => { if (silero === state) silero = null; settleReady(err); if (state.waiting) { state.waiting.reject(err); state.waiting = null; } });
  proc.on('close', (code) => { if (silero === state) silero = null; const err = new Error(`Silero-воркер завершился (код ${code})${state.stderr ? `: ${state.stderr.slice(-300)}` : ''}`); settleReady(err); if (state.waiting) { state.waiting.reject(err); state.waiting = null; } });

  state.readyPromise = new Promise((resolve, reject) => {
    state.readyWaiter = { resolve: () => resolve(state), reject };
    setTimeout(() => { if (!state.ready) { settleReady(new Error('Silero не загрузился за 5 минут')); try { proc.kill(); } catch { /* */ } } }, 300000).unref?.();
  });
  return state.readyPromise;
}

// Генерация базовой речи через Silero. Эмоции в Silero не входят — тон задаёт RVC после.
function sileroSpeak(cfg, text, opts = {}) {
  return (async () => {
    const st = await startSilero(cfg);
    const out = path.join(TTS_TEMP, `silero-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.mkdirSync(TTS_TEMP, { recursive: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { st.waiting = null; stopSilero(); reject(new Error('Silero не ответил за 3 минуты')); }, 180000);
      st.waiting = { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject: (err) => { clearTimeout(timer); reject(err); } };
      st.proc.stdin.write(`${JSON.stringify({
        cmd: 'speak',
        text,
        out,
        language: cfg.language,
        speaker: cfg.speaker,
        sampleRate: 24000,
        put_accent: true,
        put_yo: true,
        put_stress_homo: true,
        put_yo_homo: true,
        seed: opts.seed || 0,
      })}\n`);
    });
    try {
      return fs.readFileSync(out);
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* нет файла */ }
    }
  })();
}

// Базовый звук (до RVC) для текущего выбранного backend'а.
async function synthesizeSegment(s, text, emotion, seed) {
  if ((s && s.ttsBackend) === 'silero') {
    const cfg = sileroConfig(s);
    if (!cfg) throw new Error('Silero не настроен');
    return sileroSpeak(cfg, text, { emotion, seed });
  }
  if (ttsConfig(s)) return synthesizeLocal(s, text, emotion, seed);
  return synthesizeBase(s, text, emotion);
}

// Старые варианты озвучки без изменений: local (OmniVoice) → fallback voicestudio.
async function synthesizeOld(s, text, emotion, seed) {
  let wav;
  if (ttsConfig(s)) {
    try {
      wav = await synthesizeLocal(s, text, emotion, seed);
    } catch (err) {
      console.warn('[voice] локальная озвучка не сработала, пробую VoiceStudio:', err.message);
      try {
        wav = await synthesizeBase(s, text, emotion);
      } catch (vsErr) {
        throw new Error(`Локальная озвучка: ${err.message}. VoiceStudio тоже не ответил: ${vsErr.message}`);
      }
    }
  } else {
    wav = await synthesizeBase(s, text, emotion);
  }
  return wav;
}

// ── Один RVC-проход на весь ответ: TTS по кускам → конкат → RVC → сплит ─────
function wavInfo(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let sr = 24000;
  let dataOff = 44;
  let dataSize = 0;
  if (b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF') {
    sr = b.readUInt32LE(24);
    let off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'data') { dataOff = off + 8; dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
  }
  const dur = dataSize > 0 ? dataSize / (2 * sr) : 0;
  return { sr, dataOff, dataSize, dur };
}

function concatWav(buffers) {
  const totalSamples = buffers.reduce((acc, b) => acc + Math.floor(wavInfo(b).dur * wavInfo(b).sr), 0);
  const out = Buffer.alloc(44 + Math.max(0, totalSamples) * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + Math.max(0, totalSamples) * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24000, 24);
  out.writeUInt32LE(48000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(Math.max(0, totalSamples) * 2, 40);
  let o = 44;
  for (const b of buffers) {
    const i = wavInfo(b);
    if (i.dataSize > 0) b.copy(out, o, i.dataOff, i.dataOff + i.dataSize);
    o += i.dataSize;
  }
  return out;
}

// Синтез реплики целиком: TTS по кускам → конкат → ОДИН RVC-проход → сплит по длительности.
async function synthesizeReply(s, segments) {
  const bufs = [];
  const durs = [];
  for (const seg of segments) {
    const wav = await synthesizeSegment(s, seg.text, seg.emotion, seg.seed);
    const info = wavInfo(wav);
    durs.push(info);
    bufs.push(wav);
  }
  const concat = concatWav(bufs);
  const rvcBuf = await applyRvc(s, concat);
  const rinfo = wavInfo(rvcBuf);
  const out = [];
  let off = 0;
  for (const d of durs) {
    const n = Math.max(1, Math.floor(d.dur * rinfo.sr));
    out.push(rvcBuf.subarray(rinfo.dataOff + off, rinfo.dataOff + off + n * 2));
    off += n * 2;
  }
  return out;
}

// ── RVC: обученный голос ────────────────────────────────────────────────
const RVC_WORKER = path.join(__dirname, 'rvc_worker.py');
const RVC_TEMP = path.join(os.tmpdir(), 'amadeus-voice');
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Пустая/неверная настройка — RVC просто выключен, озвучка идёт базовым голосом.
function rvcConfig(s) {
  if (!s || !s.rvcEnabled) return null;
  const pth = (s.rvcPth || '').trim();
  const python = (s.rvcPython || '').trim();
  if (!pth || !isFile(pth) || !python || !isFile(python)) return null;
  const root = (s.rvcRoot || '').trim() || path.dirname(path.dirname(pth));
  return {
    key: [python, pth, s.rvcIndex || '', root].join('|'),
    python,
    pth,
    index: (s.rvcIndex || '').trim(),
    root,
    pitch: Math.round(Number(s.rvcPitch) || 0),
    indexRate: s.rvcIndexRate === undefined ? 0.75 : Number(s.rvcIndexRate),
    protect: s.rvcProtect === undefined ? 0.33 : Number(s.rvcProtect),
  };
}

let rvc = null; // { key, proc, buf, waiting, ready, stderr }

function stopRvc() {
  const cur = rvc;
  rvc = null;
  if (!cur) return;
  try { cur.proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* уже закрыт */ }
  const proc = cur.proc;
  setTimeout(() => { try { proc.kill(); } catch { /* уже завершён */ } }, 1500).unref?.();
  if (cur.waiting) {
    cur.waiting.reject(new Error('RVC-воркер остановлен'));
    cur.waiting = null;
  }
}

// Запускает воркер (один раз) и ждёт, пока RVC загрузит модель.
// Повторный вызов с той же моделью переиспользует уже запускаемый процесс.
function startRvc(cfg) {
  if (rvc && rvc.key === cfg.key) return rvc.readyPromise;
  stopRvc();

  const warmFile = path.join(__dirname, '..', 'assets', 'voice', 'warmup.wav');
  const proc = spawn(cfg.python, ['-X', 'utf8', RVC_WORKER, cfg.pth, cfg.index, cfg.root, warmFile], {
    cwd: isFile(path.join(cfg.root, 'core.py')) ? cfg.root : undefined,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = { key: cfg.key, proc, buf: '', waiting: null, ready: false, stderr: '', readyWaiter: null, readyPromise: null };
  rvc = state;

  const settleReady = (err) => {
    const w = state.readyWaiter;
    state.readyWaiter = null;
    if (!w) return;
    if (err) w.reject(err); else w.resolve(state);
  };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    state.buf += d;
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { state.ready = true; settleReady(null); continue; }
      if (!state.ready && msg.ok === false) { settleReady(new Error(msg.error || 'RVC не запустился')); continue; }
      const w = state.waiting;
      if (w) {
        state.waiting = null;
        if (msg.ok) w.resolve(msg); else w.reject(new Error(msg.error || 'RVC: ошибка'));
      }
    }
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    state.stderr = (state.stderr + d).slice(-4000);
  });

  proc.on('error', (err) => {
    if (rvc === state) rvc = null;
    settleReady(err);
    if (state.waiting) {
      state.waiting.reject(err);
      state.waiting = null;
    }
  });

  proc.on('close', (code) => {
    if (rvc === state) rvc = null;
    const err = new Error(`RVC-воркер завершился (код ${code})${state.stderr ? `: ${state.stderr.slice(-300)}` : ''}`);
    settleReady(err);
    if (state.waiting) {
      state.waiting.reject(err);
      state.waiting = null;
    }
  });

  state.readyPromise = new Promise((resolve, reject) => {
    state.readyWaiter = { resolve: () => resolve(state), reject };
    setTimeout(() => {
      if (!state.ready) {
        settleReady(new Error('RVC не загрузился за 3 минуты'));
        try { proc.kill(); } catch { /* уже закрыт */ }
      }
    }, 180000).unref?.();
  });
  return state.readyPromise;
}

function rvcConvert(cfg, src, dst) {
  return (async () => {
    const st = await startRvc(cfg);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        st.waiting = null;
        stopRvc();
        reject(new Error('RVC не ответил за 3 минуты'));
      }, 180000);
      st.waiting = {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      st.proc.stdin.write(`${JSON.stringify({
        cmd: 'convert',
        in: src,
        out: dst,
        index: cfg.index,
        pitch: cfg.pitch,
        indexRate: cfg.indexRate,
        protect: cfg.protect,
      })}\n`);
    });
  })();
}

// Прогоняет готовый WAV через обученный голос. Ошибка не ломает озвучку — вернётся базовый звук.
async function applyRvc(s, wav) {
  const cfg = rvcConfig(s);
  if (!cfg) return wav;
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const src = path.join(RVC_TEMP, `in-${tag}.wav`);
  const dst = path.join(RVC_TEMP, `out-${tag}.wav`);
  try {
    fs.mkdirSync(RVC_TEMP, { recursive: true });
    fs.writeFileSync(src, wav);
    await rvcConvert(cfg, src, dst);
    return fs.readFileSync(dst);
  } catch (err) {
    console.warn('[voice] RVC недоступен, базовый голос:', err.message);
    return wav;
  } finally {
    try { fs.rmSync(src, { force: true }); } catch { /* нет файла */ }
    try { fs.rmSync(dst, { force: true }); } catch { /* нет файла */ }
  }
}

// Загрузить голосовые модели заранее, чтобы первый ответ не ждал загрузку.
function warmup(s) {
  const jobs = [];
  if ((s && s.ttsBackend) === 'silero') {
    const sileroCfg = sileroConfig(s);
    if (sileroCfg) jobs.push(startSilero(sileroCfg).then(() => true, (err) => {
      console.warn('[voice] прогрев Silero:', err.message);
      return false;
    }));
  }
  const localTts = ttsConfig(s);
  if (localTts) {
    jobs.push(startTts(localTts).then(() => true, (err) => {
      console.warn('[voice] прогрев озвучки:', err.message);
      return false;
    }));
  }
  const rvcCfg = rvcConfig(s);
  if (rvcCfg) {
    jobs.push(startRvc(rvcCfg).then(() => true, (err) => {
      console.warn('[voice] прогрев RVC:', err.message);
      return false;
    }));
  }
  if (!jobs.length) return Promise.resolve(false);
  return Promise.all(jobs).then((r) => r.some(Boolean));
}

function dispose() {
  stopTts();
  stopSilero();
  stopRvc();
}

// ── Синтез ──────────────────────────────────────────────────────────────
async function synthesizeBase(s, text, emotion) {
  const e = BY_ID[emotion] || BY_ID.neutral;
  const body = {
    input: text,
    voice: s.voice || 'default',
    response_format: 'wav',
    language: s.language,
    speed: s.ttsEmotion ? e.speed : 1.0,
  };
  if (s.ttsEngine) body.model = s.ttsEngine;
  if (s.ttsEmotion) body.instructions = `Speak ${e.voice}.`;

  const res = await fetch(`${base(s)}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`VoiceStudio TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function synthesize(s, text, emotion, seed) {
  const backend = (s && s.ttsBackend) || 'local';
  let wav;
  if (backend === 'silero') {
    // «Silero → RVC»: лёгкий базовый TTS (Silero) + обученный RVC (Курису).
    // При ошибке Silero — откат на старые варианты (local OmniVoice → VoiceStudio).
    try {
      wav = await synthesizeSegment(s, text, emotion, seed);
    } catch (err) {
      console.warn('[voice] Silero не сработал, пробую локальный OmniVoice / VoiceStudio:', err.message);
      wav = await synthesizeOld({ ...s, ttsBackend: 'local' }, text, emotion, seed);
    }
  } else {
    wav = await synthesizeOld(s, text, emotion, seed);
  }
  return applyRvc(s, wav);
}

async function transcribeVoiceStudio(s, audio, mime) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'speech.webm');
  form.append('language', s.language);
  const res = await fetch(`${base(s)}/v1/audio/transcriptions`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`VoiceStudio STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).text || '';
}

async function transcribeOpenAI(s, audio, mime) {
  if (!s.openaiKey) throw new Error('Для распознавания через OpenAI нужен ключ OpenAI');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'speech.webm');
  form.append('model', 'whisper-1');
  form.append('language', s.language);
  const res = await fetch(`${s.openaiBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.openaiKey}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).text || '';
}

function transcribe(s, audio, mime) {
  return s.sttProvider === 'openai' ? transcribeOpenAI(s, audio, mime) : transcribeVoiceStudio(s, audio, mime);
}

async function listVoices(s) {
  const res = await fetch(`${base(s)}/profiles`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`VoiceStudio ${res.status}`);
  const rows = await res.json();
  return rows.map((p) => ({ id: p.id, name: p.name }));
}

// true, если локальная озвучка настроена и файлы на месте (для индикатора в настройках).
function ttsReady(s) {
  const backend = (s && s.ttsBackend) || 'local';
  if (backend === 'silero') return !!sileroConfig(s);
  return !!ttsConfig(s);
}

// true, если RVC настроен и файлы на месте (для индикатора в настройках).
function rvcReady(s) {
  return !!rvcConfig(s);
}

module.exports = { synthesize, synthesizeReply, transcribe, listVoices, warmup, dispose, rvcReady, ttsReady };
