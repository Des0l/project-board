import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// VACUUM INTO reads a consistent snapshot, including committed pages still in the WAL.
export function backupBoard(dataDir, destination, configFile) {
  mkdirSync(destination, { recursive: true });
  const temp = mkdtempSync(join(destination, '.creating-'));
  const output = join(destination, 'board-' + new Date().toISOString().replaceAll(':', '-') + '-' + temp.slice(-6));
  try {
    const db = new DatabaseSync(join(dataDir, 'board.sqlite'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.prepare('VACUUM INTO ?').run(join(temp, 'board.sqlite'));
    } finally { db.close(); }
    if (configFile && existsSync(configFile)) copyFileSync(configFile, join(temp, 'projects.local.json'));
    renameSync(temp, output);
    return output;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
