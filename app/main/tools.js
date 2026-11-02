// Доступ Курису к компьютеру: открыть сайт/файл/программу, прочитать файл или папку,
// записать файл, выполнить команду PowerShell. Нейросеть пишет в ответе блоки
//   [action:open] цель [/action]          [action:read] путь [/action]
//   [action:list] папка [/action]         [action:run] команда [/action]
//   [action:write путь] содержимое [/action]
// Выполняются они только с разрешения пользователя (см. needsConfirm и карточку в renderer).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const TYPES = {
  open: { title: 'Открыть', safe: true },
  read: { title: 'Прочитать файл', safe: true },
  list: { title: 'Посмотреть папку', safe: true },
  write: { title: 'Изменить файл', safe: false },
  run: { title: 'Выполнить команду', safe: false },
};
const MAX_READ = 20000;
const MAX_OUTPUT = 8000;

// Убирает обёртку ```lang ... ``` вокруг содержимого.
function unfence(body) {
  const m = body.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  // без обёртки (сайт уже отрисовал блок кода): срезаем пустые строки по краям
  return m ? m[1] : body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

// Сайты рисуют у блока кода подпись языка и кнопки «Copy»/«Download» — их текст
// иногда попадает в ответ. В файл такое писать нельзя.
const UI_NOISE = /^(copy( code)?|копировать( код)?|download|скачать( код)?)$/i;
const LANGS = /^(python|py|python3|javascript|js|typescript|ts|json|jsonc|bash|shell|sh|zsh|powershell|ps1|html|css|scss|sql|yaml|yml|xml|ini|toml|text|plaintext|markdown|md|c|c\+\+|cpp|c#|csharp|java|go|golang|rust|php|ruby|kotlin|swift|dart|lua|matlab|bat|cmd|diff|git|dockerfile|makefile|env|gradle)$/i;
const CODEY = /[(){}\[\]"'=:;#<>/\\]/;

function cleanContent(text) {
  let lines = String(text).split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // Первая строка-название языка (её рисует сайт над кодом) — только если ниже реально код.
  if (lines.length > 1 && LANGS.test(lines[0].trim()) && CODEY.test(lines[1])) lines.shift();
  lines = lines.filter((l) => !UI_NOISE.test(l.trim()));
  return lines.join('\n');
}

// Вынимает действия из ответа нейросети. Возвращает текст без них и список действий.
function extract(raw) {
  const actions = [];
  const text = raw.replace(/\[action:\s*(\w+)([^\]]*)\]([\s\S]*?)\[\/action\]/gi, (_, type, arg, body) => {
    type = type.toLowerCase();
    if (!TYPES[type]) return '';
    if (type === 'write') {
      const target = arg.trim().replace(/^["']|["']$/g, '');
      if (target) actions.push({ type, target, content: cleanContent(unfence(body)) });
    } else {
      const target = unfence(body).trim();
      if (target) actions.push({ type, target });
    }
    return '';
  });
  return { text, actions };
}

function expandPath(p) {
  let out = p.trim().replace(/^["']|["']$/g, '');
  out = out.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = path.join(os.homedir(), out.slice(1));
  return path.resolve(os.homedir(), out);
}

// Без подтверждения — только безопасные действия и только в ответ на собственное сообщение пользователя.
function needsConfirm(action, kind, settings) {
  if (kind !== 'user') return true; // сама решила что-то сделать (по скриншоту и т.п.) — только с разрешения
  if (TYPES[action.type].safe) return !settings.toolsAutoSafe;
  return !settings.toolsAutoChanges;
}

function describe(action) {
  return { title: TYPES[action.type].title, safe: TYPES[action.type].safe };
}

function runPowerShell(command) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`,
    ], { cwd: os.homedir(), windowsHide: true });
    let out = '';
    const add = (d) => { if (out.length < MAX_OUTPUT * 2) out += d.toString('utf8'); };
    ps.stdout.on('data', add);
    ps.stderr.on('data', add);
    const timer = setTimeout(() => { ps.kill(); out += '\n(остановлено: команда шла дольше 60 с)'; }, 60000);
    ps.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim().slice(0, MAX_OUTPUT) || '(нет вывода)';
      resolve(`код выхода ${code}\n${text}`);
    });
    ps.on('error', (err) => { clearTimeout(timer); resolve(`ошибка запуска: ${err.message}`); });
  });
}

function backupFile(file) {
  const dir = path.join(app.getPath('userData'), 'file-backups');
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.basename(file)}`);
  fs.copyFileSync(file, copy);
  return copy;
}

// Выполняет действие. Возвращает { ok, text } — text уходит обратно нейросети.
async function execute(action) {
  try {
    switch (action.type) {
      case 'open': {
        const t = action.target.trim();
        if (/^(https?:\/\/|mailto:)/i.test(t)) {
          await shell.openExternal(t);
          return { ok: true, text: `открыт адрес ${t}` };
        }
        if (/^www\./i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) {
          await shell.openExternal(`https://${t}`);
          return { ok: true, text: `открыт адрес https://${t}` };
        }
        const p = expandPath(t);
        if (fs.existsSync(p)) {
          const err = await shell.openPath(p);
          return err ? { ok: false, text: err } : { ok: true, text: `открыто: ${p}` };
        }
        // Имя программы (notepad, calc, chrome, steam…) — через «start», как в окне «Выполнить».
        // Спецсимволы cmd запрещены, иначе «открыть» превратилось бы в произвольную команду.
        if (/[&|<>^%"\r\n]/.test(t)) return { ok: false, text: `недопустимые символы в имени программы: ${t}` };
        spawn('cmd.exe', ['/d', '/c', `start "" "${t}"`], {
          detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true,
        }).unref();
        return { ok: true, text: `запущено: ${t}` };
      }
      case 'read': {
        const p = expandPath(action.target);
        const st = fs.statSync(p);
        if (st.isDirectory()) return execute({ type: 'list', target: p });
        const buf = fs.readFileSync(p);
        if (buf.subarray(0, 4000).includes(0)) return { ok: false, text: `${p} — двоичный файл (${st.size} байт), прочитать как текст нельзя` };
        const text = buf.toString('utf8');
        const cut = text.length > MAX_READ ? `\n…(показаны первые ${MAX_READ} из ${text.length} символов)` : '';
        return { ok: true, text: `${p}:\n${text.slice(0, MAX_READ)}${cut}` };
      }
      case 'list': {
        const p = expandPath(action.target);
        const items = fs.readdirSync(p, { withFileTypes: true }).slice(0, 300)
          .map((d) => (d.isDirectory() ? `[папка] ${d.name}` : d.name));
        return { ok: true, text: `${p}:\n${items.join('\n') || '(пусто)'}` };
      }
      case 'write': {
        const p = expandPath(action.target);
        let note = '';
        if (fs.existsSync(p)) note = ` (старая версия сохранена: ${backupFile(p)})`;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, action.content, 'utf8');
        return { ok: true, text: `записан файл ${p}, ${action.content.length} символов${note}` };
      }
      case 'run':
        return { ok: true, text: await runPowerShell(action.target) };
      default:
        return { ok: false, text: 'неизвестное действие' };
    }
  } catch (err) {
    return { ok: false, text: `ошибка: ${err.message}` };
  }
}

module.exports = { extract, needsConfirm, describe, execute, expandPath };
