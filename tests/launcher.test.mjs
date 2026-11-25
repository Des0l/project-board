import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { openStore } from '../lib/model.mjs';

test('launcher reopens the matching local board and refuses another database on the same port', async t => {
  const dataDir = resolve('.work', 'launcher-fixture');
  const paths = [];
  const listener = createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'project-board', demo: false, dataDir }));
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise(done => listener.close(done)));
  const port = String(listener.address().port);
  const launch = data => promisify(execFile)(process.execPath, ['open-board.mjs', '--no-open'], {
    env: { ...process.env, PROJECT_BOARD_DATA: data, PROJECT_BOARD_PORT: port }, windowsHide: true,
  });
  assert.equal((await launch(dataDir)).stdout.trim(), 'http://127.0.0.1:' + port);
  await assert.rejects(launch(resolve(dataDir, 'other')), /Порт .* уже занят/);
  assert.deepEqual(paths, ['/api/launcher', '/api/launcher']);
});

test('fresh portable folder remembers a running board and protects existing or missing data', async t => {
  const scratch = resolve('.work', 'test-temp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, 'распаковка-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'lib'));
  await copyFile('open-board.mjs', resolve(root, 'open-board.mjs'));
  await copyFile('lib/data-location.mjs', resolve(root, 'lib/data-location.mjs'));
  const dataDir = resolve(root, 'первая база');
  const db = openStore(resolve(dataDir, 'board.sqlite'), [{ id: 'first', name: 'Первая' }]);
  db.close();
  let identity = { app: 'project-board', demo: true, dataDir };
  const server = createServer((_req, res) => res.end(JSON.stringify(identity)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const port = String(server.address().port);
  const launch = () => promisify(execFile)(process.execPath, ['open-board.mjs', '--no-open'], {
    cwd: root, windowsHide: true, env: { ...process.env, PROJECT_BOARD_DATA: '', PROJECT_BOARD_ROOT: '',
      PROJECT_BOARD_PROJECTS: '', PROJECT_BOARD_PORT: port },
  });
  await assert.rejects(launch(), /Порт .* уже занят/);
  identity = { ...identity, demo: false };
  assert.equal((await launch()).stdout.trim(), 'http://127.0.0.1:' + port);
  const link = JSON.parse(await readFile(resolve(root, 'board-location.local.json'), 'utf8'));
  assert.equal(link.dataDir, dataDir);
  await rm(resolve(dataDir, 'board.sqlite'));
  await assert.rejects(launch(), /Не найдена сохранённая база/);
  const separate = openStore(resolve(root, 'data', 'board.sqlite'), []);
  separate.close();
  await assert.rejects(launch(), /База этой копии/);
});
