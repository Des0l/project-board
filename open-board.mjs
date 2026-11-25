import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { boardLocation, rememberRunningBoard } from './lib/data-location.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const port = Number(process.env.PROJECT_BOARD_PORT || (demo ? 4180 : 4178));
const url = 'http://127.0.0.1:' + port;
let location;

function samePath(a, b) {
  if (typeof a !== 'string') return false;
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

async function running() {
  const options = { signal: AbortSignal.timeout(1800), redirect: 'error' };
  const occupied = 'Порт ' + port + ' уже занят. Для отдельной доски укажите другой PROJECT_BOARD_PORT.';
  let response;
  try {
    response = await fetch(url + '/api/launcher', options);
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error(occupied);
  }
  if (response.ok) {
    const info = await response.json().catch(() => null);
    if (info?.app === 'project-board' && info.demo === demo) {
      if (samePath(info.dataDir, location.dataDir)) return true;
      if (location.fresh && await rememberRunningBoard(root, info.dataDir)) {
        location = boardLocation(root, demo);
        return true;
      }
      throw new Error('Порт ' + port + ' уже занят другой доской. Открытая база: ' + info.dataDir
        + '\nБаза этой копии: ' + location.dataDir + '\nДля отдельной доски укажите другой PROJECT_BOARD_PORT.');
    }
  } else if (response.status === 404) {
    // Older servers identify their application through the bridge.
    const legacy = await fetch(url + '/api/state', options);
    const info = legacy.ok && await legacy.json().catch(() => null);
    if (!process.env.PROJECT_BOARD_DATA && info?.sync?.demo === demo && samePath(info.bridge?.cli, join(root, 'board.mjs'))) return true;
  }
  throw new Error(occupied);
}

async function start() {
  const logDir = join(root, '.work', 'logs');
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, 'launcher-' + port + '.log');
  const fd = openSync(log, 'a');
  let child, failure;
  try {
    const env = { ...process.env, PROJECT_BOARD_DATA: location.dataDir };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter);
    child = spawn(process.execPath, [join(root, 'server.mjs'), ...(demo ? ['--demo'] : [])], {
      cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true, detached: true,
    });
    child.once('error', error => { failure = error; });
    child.unref();
  } finally {
    closeSync(fd);
  }
  for (let i = 0; i < 80; i++) {
    await delay(125);
    if (await running()) return;
    if (failure || child.exitCode !== null || child.signalCode !== null) break;
  }
  throw new Error('Доска не ответила. Журнал запуска: ' + log + (failure ? '\n' + failure.message : ''));
}

async function openBrowser() {
  if (args.includes('--app') && process.platform === 'win32') {
    const folders = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const product of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
      const executable = folders.map(folder => join(folder, product)).find(existsSync);
      if (!executable) continue;
      const window = spawn(executable, ['--app=' + url], { detached: true, stdio: 'ignore' });
      const started = await new Promise(resolve => { window.once('spawn', () => resolve(true)); window.once('error', () => resolve(false)); });
      if (started) { window.unref(); return; }
    }
  }
  const [command, ...params] = process.platform === 'win32'
    ? [join(process.env.SystemRoot, 'System32', 'rundll32.exe'), 'url.dll,FileProtocolHandler', url]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', url];
  const browser = spawn(command, params, { stdio: 'ignore', detached: true, windowsHide: true });
  await new Promise((ok, fail) => { browser.once('spawn', ok); browser.once('error', fail); });
  browser.unref();
}

function installMenuEntry() {
  if (process.platform !== 'linux') throw new Error('Этот параметр добавляет ярлык в меню Linux.');
  const xdg = process.env.XDG_DATA_HOME || '';
  const dir = join(isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share'), 'applications');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'local.project-board.desktop');
  // Path is a Desktop Entry string value. Keep it separate from the command line.
  const escapes = { '\\': '\\\\', ' ': '\\s', '\t': '\\t', '\r': '\\r', '\n': '\\n' };
  const workingDir = root.replace(/[\\ \t\r\n]/g, ch => escapes[ch]);
  const entry = ['[Desktop Entry]', 'Type=Application', 'Name=Доска проектов',
    'Exec=/bin/sh ./Open-board.sh', 'Path=' + workingDir, 'Terminal=false', 'Categories=Office;', ''].join('\n');
  const temporary = file + '.' + process.pid;
  writeFileSync(temporary, entry, { flag: 'wx' });
  renameSync(temporary, file);
  console.log(file);
}

try {
  location = boardLocation(root, demo);
  if (location.fresh && (args.includes('--backup') || args.includes('--install-plugin'))) await running();
  if (args.length === 1 && args[0] === '--backup') {
    const { backupBoard } = await import('./lib/backup.mjs');
    console.log(backupBoard(location.dataDir, join(root, 'backups'), process.env.PROJECT_BOARD_PROJECTS || join(location.dataDir, 'projects.local.json')));
  } else if (args.length === 1 && args[0] === '--install-plugin') {
    const { installBoardPlugin } = await import('./lib/install-board-plugin.mjs');
    installBoardPlugin(root, location.dataDir, port);
  } else if (args.length === 1 && args[0] === '--install-shortcut') {
    installMenuEntry();
  } else {
    if (args.some(a => !['--demo', '--no-open', '--app'].includes(a))) throw new Error('Параметры запуска: --app, --demo, --no-open, --backup, --install-plugin. Для ярлыка Linux: --install-shortcut.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Проверьте PROJECT_BOARD_PORT (1–65535).');
    if (!await running()) await start();
    console.log(url);
    if (!args.includes('--no-open')) await openBrowser();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
