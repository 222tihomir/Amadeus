// Платформенные помощники: Windows и Linux/macOS.
// Все проверки ОС собраны здесь, чтобы остальной код не зависел от того, где запущен Amadeus.
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// Файл существует и исполняемый (на Windows права запуска не проверяются).
function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Ищет программу в PATH: на Windows — с расширениями из PATHEXT, на Linux/macOS — как есть.
function findOnPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const hasExt = isWindows && ext && bin.toLowerCase().endsWith(ext.toLowerCase());
      const p = path.join(dir, bin + (hasExt ? '' : ext));
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

module.exports = { isWindows, isMac, isLinux, isExecutable, findOnPath };
