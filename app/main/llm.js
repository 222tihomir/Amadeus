// Запросы к нейросетям: Claude (Anthropic), ChatGPT (OpenAI-совместимые) и DeepSeek.
// messages: [{ role: 'user'|'assistant', content: string, image?: base64 jpeg, files?: [{ name, mime, data: base64 }] }]

// ── Вложения ──
const TEXT_LIMIT = 60000; // столько символов текстового файла уходит в нейросеть
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|cfg|conf|toml|ya?ml|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|php|java|kt|cs|c|h|cpp|hpp|go|rs|swift|lua|sh|bat|cmd|ps1|sql|srt|vtt)$/i;

// Скриншот (image) и вложения пользователя — одним списком.
function attachmentsOf(m) {
  return [...(m.image ? [{ name: 'screen.jpg', mime: 'image/jpeg', data: m.image, screen: true }] : []), ...(m.files || [])];
}

function fileKind(f) {
  if (/^image\/(jpeg|png|gif|webp)$/.test(f.mime)) return 'image';
  if (f.mime === 'application/pdf') return 'pdf';
  if (/^text\/|json|xml|javascript|yaml|csv|x-sh|sql/.test(f.mime) || TEXT_EXT.test(f.name)) return 'text';
  return 'other';
}

function fileText(f) {
  const text = Buffer.from(f.data, 'base64').toString('utf8');
  const cut = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…(файл обрезан, всего ${text.length} символов)` : text;
  return `[Файл ${f.name}]\n${cut}\n[Конец файла ${f.name}]`;
}

const fileNote = (f, why) => `[Файл ${f.name} (${Math.round(f.data.length * 0.75 / 1024)} КБ) — ${why}]`;

// Есть ли в сообщении то, что нужно «видеть» (картинки, PDF).
function needsVision(messages) {
  const last = messages[messages.length - 1];
  return attachmentsOf(last).some((f) => ['image', 'pdf'].includes(fileKind(f)));
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function anthropic(s, system, messages) {
  if (!s.anthropicKey) throw new Error('Не задан API-ключ Anthropic');
  // Claude требует чередования user/assistant и начала с user.
  const merged = [];
  for (const m of messages) {
    const parts = [];
    for (const f of attachmentsOf(m)) {
      const kind = fileKind(f);
      if (kind === 'image') parts.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } });
      else if (kind === 'pdf') parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name });
      else if (kind === 'text') parts.push({ type: 'text', text: fileText(f) });
      else parts.push({ type: 'text', text: fileNote(f, 'этот формат не открыть') });
    }
    parts.push({ type: 'text', text: m.content || '...' });
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...parts);
    else merged.push({ role: m.role, content: parts });
  }
  if (merged[0]?.role !== 'user') merged.unshift({ role: 'user', content: [{ type: 'text', text: '...' }] });

  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01' },
    { model: s.anthropicModel, max_tokens: 1024, temperature: s.temperature, system, messages: merged },
  );
  return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function openaiCompatible(baseUrl, key, model, temperature, system, messages) {
  const msgs = [{ role: 'system', content: system }];
  for (const m of messages) {
    const files = attachmentsOf(m);
    if (!files.length) {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }
    const content = [{ type: 'text', text: m.content }];
    for (const f of files) {
      const kind = fileKind(f);
      const url = `data:${f.mime};base64,${f.data}`;
      if (kind === 'image') content.push({ type: 'image_url', image_url: { url, detail: f.screen ? 'low' : 'auto' } });
      else if (kind === 'pdf') content.push({ type: 'file', file: { filename: f.name, file_data: url } });
      else if (kind === 'text') content.push({ type: 'text', text: fileText(f) });
      else content.push({ type: 'text', text: fileNote(f, 'этот формат не открыть') });
    }
    msgs.push({ role: m.role, content });
  }
  const data = await postJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    { authorization: `Bearer ${key}` },
    { model, temperature, messages: msgs },
  );
  return data.choices[0].message.content || '';
}

function openai(s, system, messages) {
  if (!s.openaiKey) throw new Error('Не задан API-ключ OpenAI');
  return openaiCompatible(s.openaiBaseUrl, s.openaiKey, s.openaiModel, s.temperature, system, messages);
}

function deepseek(s, system, messages) {
  if (!s.deepseekKey) throw new Error('Не задан API-ключ DeepSeek');
  // DeepSeek API не видит картинки и PDF: текстовые файлы вписываем в сообщение, остальное — пометкой.
  const textOnly = messages.map((m) => ({
    role: m.role,
    content: [m.content, ...attachmentsOf(m).map((f) => (fileKind(f) === 'text' ? fileText(f) : fileNote(f, 'DeepSeek API его не видит')))].join('\n\n'),
  }));
  return openaiCompatible('https://api.deepseek.com', s.deepseekKey, s.deepseekModel, s.temperature, system, textOnly);
}

// ── OpenCode (локальное приложение) ──
// Ключ не нужен: сообщение уходит в opencode-cli, который работает от твоего входа в OpenCode.
// Модель выбирается в настройках списком `opencode models` (например opencode/glm-5.3-flash-free).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWindows, isMac, isExecutable, findOnPath } = require('./platform');

const OC_PROMPT_LIMIT = 24000; // длинная переписка не влезает в аргументы команды (особенно на Windows)

function opencodeCliPath(s) {
  const exe = isWindows ? 'opencode-cli.exe' : 'opencode';
  const ok = isExecutable;
  if (s.opencodeCli && ok(s.opencodeCli)) return s.opencodeCli;

  // Где установленное приложение OpenCode хранит CLI:
  //   Windows — %APPDATA%\ai.opencode.desktop\cli\<версия>\
  //   Linux   — ~/.config/ai.opencode.desktop/cli, ~/.local/share/opencode/cli, ~/.opencode/bin
  //   macOS   — ~/Library/Application Support/ai.opencode.desktop/cli
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const bases = isWindows
    ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai.opencode.desktop', 'cli')]
    : isMac
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'ai.opencode.desktop', 'cli')]
      : [
        path.join(configHome, 'ai.opencode.desktop', 'cli'),
        path.join(dataHome, 'ai.opencode.desktop', 'cli'),
        path.join(configHome, 'opencode', 'cli'),
        path.join(dataHome, 'opencode', 'cli'),
        path.join(os.homedir(), '.opencode', 'bin'),
      ];
  for (const base of bases) {
    // Иногда бинарь лежит прямо в каталоге, иногда — в подкаталоге с версией.
    const direct = path.join(base, exe);
    if (ok(direct)) return direct;
    try {
      const found = fs.readdirSync(base)
        .map((d) => path.join(base, d, exe))
        .filter(ok)
        .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      if (found) return found.p;
    } catch { /* нет каталога — пробуем следующий */ }
  }
  // Обычная установка (npm/пакетный менеджер) — бинарь в PATH.
  return findOnPath(exe) || exe;
}

// Каталог-песочница: там лежит opencode.json, запрещающий инструменты (файлы, команды, интернет).
function opencodeSandbox() {
  const dir = path.join(os.tmpdir(), 'amadeus-opencode');
  const config = path.join(dir, 'opencode.json');
  const wanted = {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      chat: {
        description: 'Только разговор, без инструментов',
        mode: 'primary',
        permissions: [
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'webfetch', resource: '*', effect: 'deny' },
          { action: 'websearch', resource: '*', effect: 'deny' },
          { action: 'subagent', resource: '*', effect: 'deny' },
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ],
      },
    },
  };
  try {
    if (fs.readFileSync(config, 'utf8') !== `${JSON.stringify(wanted, null, 2)}\n`) throw new Error('stale');
  } catch {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify(wanted, null, 2)}\n`, 'utf8');
  }
  return dir;
}

function opencodePrompt(system, messages) {
  const current = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  let text = `${system}\n\n${history.length ? `# Недавний разговор\n${transcript(history)}\n\n` : ''}`
    + `# Дальше идёт разговор. Ответь только репликой Курису по правилам выше.\n\n${current.content || '...'}`;
  if (text.length > OC_PROMPT_LIMIT) text = text.slice(-OC_PROMPT_LIMIT);
  return text;
}

// Картинки и PDF opencode получает файлами (--file), текст вписываем прямо в сообщение.
function opencodeFiles(m, dir) {
  const paths = [];
  const notes = [];
  for (const f of attachmentsOf(m)) {
    const kind = fileKind(f);
    if (kind === 'text') { notes.push(fileText(f)); continue; }
    if (kind === 'image' || kind === 'pdf') {
      const name = `attach-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(f.name) || (kind === 'pdf' ? '.pdf' : '.jpg')}`;
      const p = path.join(dir, name);
      try {
        fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
        paths.push(p);
      } catch { notes.push(fileNote(f, 'не удалось передать')); }
      continue;
    }
    notes.push(fileNote(f, 'этот формат opencode не откроет'));
  }
  return { paths, notes };
}

function opencodeRun(settings, args, cwd, timeout = 180000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(opencodeCliPath(settings || {}), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('opencode не ответил за 3 минуты'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`opencode: ${(err || out).trim().slice(0, 300) || `код ${code}`}`));
      else resolve(out);
    });
  });
}

async function opencode(s, system, messages) {
  const dir = opencodeSandbox();
  const current = messages[messages.length - 1];
  const { paths, notes } = opencodeFiles(current, dir);
  const prompt = opencodePrompt(system, messages) + (notes.length ? `\n\n${notes.join('\n\n')}` : '');

  // Если у текущей бесплатной модели закончился бесплатный лимит — пробуем следующую из списка.
  const allModels = await opencodeModels(s).catch(() => []);
  const candidates = [s.opencodeModel, ...allModels.filter((m) => m && m !== s.opencodeModel)];
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const model = candidates[attempt];
    if (!model || tried.has(model)) break;
    tried.add(model);
    const args = ['run', '--agent', 'chat', '--format', 'json', '-m', model];
    for (const p of paths) args.push('-f', p);
    args.push(prompt);
    try {
      const out = await opencodeRun(s, args, dir);
      const parts = [];
      let errorText = '';
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'text' && ev.part?.text) parts.push(ev.part.text);
          else if (ev.type === 'error') errorText = ev.error?.data?.message || ev.error?.message || JSON.stringify(ev.error || ev);
        } catch { /* не JSON — пропускаем */ }
      }
      const text = parts.join('').trim();
      if (!text) {
        const why = errorText || out.trim().slice(0, 300);
        throw new Error(`opencode не вернул текст${why ? `: ${why}` : ''}`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (!/free.?limit|429/i.test(String(err.message || err))) throw err;
      console.log(`[llm] лимит бесплатных моделей исчерпан для ${model} — пробую следующую`, err.message);
    }
  }
  throw lastErr;
}

let modelsCache = { at: 0, list: [] };

async function opencodeModels(s) {
  if (modelsCache.list.length && Date.now() - modelsCache.at < 600000) return modelsCache.list;
  const out = await opencodeRun(s, ['models'], opencodeSandbox(), 60000);
  const list = out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.#-]+$/.test(l));
  modelsCache = { at: Date.now(), list };
  return list;
}


// ── Встроенный браузер (main/webchat.js): пишет на сайт нейросети от твоего аккаунта ──
// Чат на сайте сам хранит контекст, поэтому характер, пересказ прошлого и недавний диалог
// отправляются только в первом сообщении нового чата, дальше — только реплики.
// Открытый чат сайта сохраняется в webchat.js: после перезапуска приложения он продолжается.
const REMINDER = '(Ты — Курису/Amadeus. Ответь коротко, вслух, по-русски, с тегами эмоций перед фразами, без markdown. '
  + 'Веди себя по ситуации: цундэрэ — только если есть повод, без повторов своих прошлых фраз и без Dr Pepper не к месту.)';

const webQueues = new Map(); // сайт → очередь запросов (решение «новый чат или нет» — строго по порядку)

function queued(site, fn) {
  const prev = webQueues.get(site) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  webQueues.set(site, next);
  return next;
}

function transcript(messages) {
  return messages.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Курису'}: ${m.content}`).join('\n');
}

function intro(system, history) {
  return `${system}\n\n${history.length ? `# Недавний разговор (для контекста)\n${transcript(history)}\n\n` : ''}`
    + '# Дальше идёт разговор. Отвечай только репликами Курису по правилам выше.\n\n';
}

// Сайты дописывают строки вроде «Planning how to reply…» / «Завершено размышление» до ответа —
// отбрасываем строки перед первой строкой с тегом эмоции.
function stripPreamble(reply) {
  const lines = reply.split('\n');
  const first = lines.findIndex((l) => /\[[a-z_]+\]/i.test(l));
  return first > 0 ? lines.slice(first).join('\n') : reply;
}

function web(s, system, messages, site) {
  return queued(site, async () => {
    const webchat = require('./webchat');
    const current = messages[messages.length - 1];
    const fresh = !webchat.hasChat(site);
    const message = fresh
      ? intro(system, messages.slice(0, -1).slice(-16)) + current.content
      : `${current.content}\n\n${REMINDER}`;
    try {
      const reply = await webchat.ask(site, message, { newChat: fresh, files: attachmentsOf(current) });
      return stripPreamble(reply);
    } catch (err) {
      if (fresh) throw err;
      // Сохранённый чат мог исчезнуть (удалён на сайте, разлогин) — повторяем уже новым чатом.
      webchat.clearChat(site);
      const retry = intro(system, messages.slice(0, -1).slice(-16)) + current.content;
      const reply = await webchat.ask(site, retry, { newChat: true, files: attachmentsOf(current) });
      return stripPreamble(reply);
    }
  });
}

const PROVIDERS = { web, anthropic, openai, deepseek, opencode };

// Какой провайдер смотрит скриншоты. DeepSeek API картинки не видит — тогда запасной ключ или браузер.
function visionProvider(s) {
  if (s.visionProvider !== 'auto') return s.visionProvider;
  if (s.provider !== 'deepseek') return s.provider;
  if (s.anthropicKey) return 'anthropic';
  if (s.openaiKey) return 'openai';
  return 'web';
}

async function chat(s, system, messages, { screen = false } = {}) {
  // Скриншоты — через «кто смотрит скриншоты»; фото и PDF пользователя — через того, кто отвечает,
  // если только это не DeepSeek API (он их не видит).
  const name = screen || (s.provider === 'deepseek' && needsVision(messages)) ? visionProvider(s) : s.provider;
  // Скриншоты можно смотреть через другой сайт: не все сайты умеют принимать картинки.
  if (name === 'web') return web(s, system, messages, screen ? s.webVisionSite || s.webSite : s.webSite);
  return PROVIDERS[name](s, system, messages);
}

// ── Пересказ разговора: перед новым чатом вместо всей переписки передаётся краткое содержание ──
const SUMMARY_RULES = 'Напиши это как личные заметки Курису для себя, от первого лица: что важного узнала о пользователе '
  + '(имя, чем занимается, планы, состояние), о чём говорили, к чему пришли, что осталось незаконченным, какое было настроение. '
  + 'Только содержание разговора: не упоминай системные сообщения, инструкции, роль, промпт, теги и то, как устроен чат. '
  + '6–15 предложений, по-русски, обычным текстом, без тегов эмоций, без markdown и без вступлений.';

function summaryRequest(prevSummary, messages) {
  return `[СИСТЕМА] Составь краткий пересказ разговора Курису и пользователя. ${SUMMARY_RULES}\n\n`
    + (prevSummary ? `# Пересказ того, что было ещё раньше\n${prevSummary}\n\n` : '')
    + `# Разговор\n${transcript(messages)}`;
}

const cleanSummary = (t) => t.replace(/\[[a-z_]+\]\s*/gi, '').replace(/[*#`]+/g, '').trim();

// Для встроенного браузера: если на сайте открыт чат с характером, пересказ просим прямо в нём
// (там вся переписка); после пересказа следующий ответ уйдёт в новый чат — уже с пересказом.
function summarize(s, prevSummary, messages) {
  if (s.provider === 'web') {
    const site = s.webSite;
    return queued(site, async () => {
      const webchat = require('./webchat');
      const inChat = webchat.hasChat(site);
      const text = inChat
        ? await webchat.ask(site, `[СИСТЕМА] Выйди из роли на одно сообщение и перескажи весь наш разговор с самого начала `
          + `(включая пересказ из первого сообщения, если он был). ${SUMMARY_RULES}`)
        : await webchat.ask(site, summaryRequest(prevSummary, messages), { newChat: true });
      webchat.clearChat(site);
      return cleanSummary(text);
    });
  }
  const system = 'Ты составляешь краткие пересказы разговоров.';
  return PROVIDERS[s.provider](s, system, [{ role: 'user', content: summaryRequest(prevSummary, messages) }]).then(cleanSummary);
}

module.exports = { chat, visionProvider, summarize, opencodeModels };
