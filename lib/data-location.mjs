import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const linkName = 'board-location.local.json';

export function boardLocation(root, demo) {
  const local = join(root, 'data');
  if (demo) return { dataDir: join(local, 'demo') };
  if (process.env.PROJECT_BOARD_DATA) return { dataDir: resolve(root, process.env.PROJECT_BOARD_DATA) };
  if (existsSync(join(local, 'board.sqlite')) || existsSync(join(local, 'projects.local.json'))) return { dataDir: local };
  const file = join(root, linkName);
  if (existsSync(file)) {
    let dir;
    try { dir = JSON.parse(readFileSync(file, 'utf8')).dataDir; } catch { /* Report the file to repair. */ }
    if (typeof dir !== 'string' || !isAbsolute(dir) || !existsSync(join(dir, 'board.sqlite'))) {
      throw new Error('Не найдена сохранённая база доски. Проверь путь в ' + file);
    }
    return { dataDir: dir };
  }
  return { dataDir: local, fresh: !process.env.PROJECT_BOARD_PROJECTS && !process.env.PROJECT_BOARD_ROOT };
}

export async function rememberRunningBoard(root, dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || /^[\\/]{2}/.test(dir)) return false;
  const dbFile = join(dir, 'board.sqlite');
  if (!existsSync(dbFile)) return false;
  const { DatabaseSync } = await import('node:sqlite');
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db.prepare("SELECT id FROM board WHERE id = 1 AND json_type(value, '$.projects') = 'array' AND json_type(value, '$.cards') = 'array'").get();
      if (!row) return false;
    } finally { db.close(); }
  } catch { return false; }
  if (boardLocation(root, false).fresh) {
    try { writeFileSync(join(root, linkName), JSON.stringify({ dataDir: dir }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return boardLocation(root, false).dataDir === dir;
}
