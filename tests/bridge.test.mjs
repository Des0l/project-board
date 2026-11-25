import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mergeSnapshot, openStore } from '../lib/model.mjs';
import { backupBoard } from '../lib/backup.mjs';

async function withBoard(projectIds, check) {
  const scratch = resolve('.work', 'test-temp');
  await mkdir(scratch, { recursive: true });
  const data = await mkdtemp(resolve(scratch, 'bridge-'));
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = String(socket.address().port);
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, PROJECT_BOARD_DATA: data, PROJECT_BOARD_OFFLINE: '1', PROJECT_BOARD_PORT: port, PROJECT_BOARD_PROJECTS: '' };
  if (projectIds.length) {
    const projects = projectIds.map(id => ({ id, name: id, roots: [resolve(data, id)] }));
    env.PROJECT_BOARD_PROJECTS = resolve(data, 'projects.local.json');
    await writeFile(env.PROJECT_BOARD_PROJECTS, JSON.stringify({ projects }));
  }
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['board.mjs', ...args], { env, encoding: 'utf8', windowsHide: true }));
  const url = 'http://127.0.0.1:' + port + '/api/';
  const request = async (path, method = 'GET', data) => {
    const resp = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Board-Action': '1' }, body: data && JSON.stringify(data) });
    return { code: resp.status, body: await resp.json() };
  };
  let server;
  async function start() {
    server = spawn(process.execPath, ['server.mjs'], { env, windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode != null) throw Error('Server exited');
      try { if ((await request('state')).code === 200) return; } catch { /* still starting */ }
      await sleep(40);
    }
    throw Error('Server timeout');
  }
  async function stop() {
    if (server && server.exitCode == null && server.signalCode == null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
  try {
    await start();
    await check({ cli, request, start, stop, data, env });
  } finally {
    await stop();
    if (data.startsWith(scratch + sep + 'bridge-')) await rm(data, { recursive: true, force: true });
  }
}

test('desktop plugin reads, creates and moves a card, then the online snapshot opens independently', async () => {
  await withBoard(['alpha'], async ({ env, request, data }) => {
    function rpc(method, params) {
      const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
      return JSON.parse(execFileSync(process.execPath, ['plugins/project-board/board-tools.mjs'], {
        input, env: { ...env, PROJECT_BOARD_APP_DIR: resolve('.') }, encoding: 'utf8', windowsHide: true
      })).result;
    }
    function call(name, args) {
      const result = rpc('tools/call', { name, arguments: args });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    }
    assert.ok(rpc('initialize', { protocolVersion: '2025-06-18' }).capabilities.tools);
    assert.equal(rpc('tools/list', {}).tools.length, 4);
    assert.equal(call('list_projects', {})[0].id, 'alpha');
    const card = call('create_card', { projectId: 'alpha', title: 'Desktop task' });
    const changed = call('update_card', { id: card.id, status: 'review', next: 'Read report' });
    assert.equal(changed.status, 'review');
    assert.deepEqual(call('list_cards', { projectId: 'alpha' }), [changed]);
    const folder = backupBoard(data, resolve(data, 'copies'), env.PROJECT_BOARD_PROJECTS);
    const copy = openStore(resolve(folder, 'board.sqlite'), []);
    try {
      assert.deepEqual(copy.read().cards, (await request('state')).body.cards);
      copy.change(b => { b.cards[0].title = 'Independent copy'; });
      assert.equal((await request('state')).body.cards[0].title, 'Desktop task');
    } finally { copy.close(); }
  });
});

test('project colors migrate once, reserve trashed colors and survive settings, renames and restarts', async () => {
  const ids = Array.from({ length: 24 }, (_, n) => 'proj-' + n);
  await withBoard(ids, async ({ request, stop, start, data }) => {
    await stop();
    const db = openStore(resolve(data, 'board.sqlite'), []);
    try {
      db.change(board => {
        for (const project of board.projects) delete project.color;
        board.projects.at(-1).color = '#5267c5';
        board.projects.at(-1).deletedAt = new Date().toISOString();
      });
    } finally { db.close(); }
    await start();
    const project = async () => (await request('state')).body.projects.find(p => p.id === ids[0]);
    const created = await request('projects', 'POST', { name: 'Another' });
    const active = created.body.projects.map(p => p.color);
    assert.equal(created.code, 201);
    assert.equal(active.length, 24);
    assert.equal(new Set(active).size, active.length);
    assert.ok(active.every(color => /^#[0-9a-f]{6}$/.test(color) && color !== '#5267c5'));
    assert.equal((await request('projects/' + ids[0], 'PATCH', { color: 'pink' })).code, 400);
    assert.equal((await project()).color, active[0]);
    await request('projects/' + ids[0], 'PATCH', { color: '#EF823A' });
    await request('projects/' + ids[0], 'PATCH', { name: 'Renamed' });
    await request('projects/' + ids.at(-1) + '/restore', 'POST');
    const before = (await request('state')).body.projects;
    assert.equal(before.find(p => p.id === ids.at(-1)).color, '#5267c5');
    assert.equal((await project()).color, '#ef823a');
    await stop();
    await start();
    assert.deepEqual((await request('state')).body.projects, before);
  });
});

test('empty configured project stays removed while moved chats keep syncing and responding to old project IDs', async () => {
  await withBoard(['bucket', 'dest'], async ({ request, stop, start, data }) => {
    const threads = ids => ids.map(id => ({ id, title: id, projectId: 'bucket' }));
    function scan(snapshot) {
      const db = openStore(resolve(data, 'board.sqlite'), []);
      try { db.change(b => mergeSnapshot(b, snapshot, new Date().toISOString())); } finally { db.close(); }
    }
    scan(threads(['moved', 'discarded']));
    const remove = () => request('projects/bucket/trash', 'POST');
    assert.equal((await remove()).code, 409);
    await request('chats/move', 'POST', { fromProjectId: 'bucket', toProjectId: 'dest', chatIds: ['moved'] });
    await request('chats/trash', 'POST', { fromProjectId: 'bucket', chatIds: ['discarded'] });
    const card = (await request('cards', 'POST', { projectId: 'bucket', title: 'Manual card' })).body.cards[0];
    assert.equal((await remove()).code, 409);
    await request('cards/' + card.id + '/trash', 'POST');
    const source = { provider: 'external', session: 'inbox', event: 'one' };
    const task = { projectId: 'bucket', source, mode: 'suggest', title: 'Draft' };
    const offer = (await request('bridge/tasks', 'POST', task)).body;
    assert.equal((await remove()).code, 409);
    await request('proposals/' + offer.id + '/dismiss', 'POST');
    const q = { projectId: 'bucket', source, question: 'Which file?' };
    await request('bridge/questions', 'POST', { ...q, action: 'ask' });
    assert.equal((await remove()).code, 409);
    await request('bridge/questions', 'POST', { ...q, action: 'answered' });
    assert.equal((await remove()).body.trashedProjects[0].id, 'bucket');
    assert.equal((await remove()).body.trashedProjects.length, 1);
    await stop();
    const createdAt = Math.floor(Date.now() / 1000) + 1;
    const fresh = threads(['route', 'skip']).map(t => ({ ...t, createdAt, updatedAt: createdAt, cwd: resolve(data, 'bucket') }));
    scan([...threads(['discarded']), { ...threads(['new-chat'])[0], createdAt: 1, updatedAt: createdAt },
      ...fresh, { ...threads(['moved'])[0], title: 'Updated' }]);
    scan([{ ...fresh[0], title: 'New title' }, fresh[1]]);
    await start();
    const state = (await request('sync', 'POST', { full: true })).body;
    assert.deepEqual(state.projects.map(p => p.id), ['dest']);
    assert.deepEqual(state.naming, []);
    assert.deepEqual(state.chats.map(c => [c.title, c.projectId]), [['Updated', 'dest']]);
    assert.deepEqual(state.unassignedChats.map(c => [c.id, c.title]), [['route', 'New title'], ['skip', 'skip']]);
    assert.ok(state.unassignedChats.every(c => c.sourceName === 'bucket'));
    assert.deepEqual((await request('bridge/projects')).body.map(p => p.id), ['dest']);
    assert.equal((await request('bridge/tasks', 'POST', task)).code, 409);
    assert.equal((await request('cards/' + card.id + '/restore', 'POST')).code, 409);
    assert.equal((await request('chats/restore', 'POST', { fromProjectId: 'bucket', chatIds: ['discarded'] })).code, 409);
    const moved = await request('bridge/tasks', 'POST', { ...task, mode: 'add', source: { ...source, provider: 'codex', session: 'moved' } });
    assert.equal(moved.code, 200);
    assert.equal((await request('bridge/context?provider=codex&session=moved&project=bucket')).body.projectId, 'dest');
    const beforeCards = (await request('state')).body.cards.length;
    assert.equal((await request('unassigned/assign', 'POST', { chatId: 'route', toProjectId: 'dest', confirmRecommendation: true })).code, 409);
    assert.equal((await request('unassigned/assign', 'POST', { chatId: 'route', toProjectId: 'bucket' })).code, 409);
    const assigned = (await request('unassigned/assign', 'POST', { chatId: 'route', toProjectId: 'dest' })).body;
    assert.equal(assigned.trashedProjects[0].id, 'bucket');
    assert.equal(assigned.cards.length, beforeCards);
    assert.equal((await request('unassigned/assign', 'POST', { chatId: 'route', name: 'Duplicate on retry' })).code, 409);
    const dismissed = (await request('unassigned/dismiss', 'POST', { chatId: 'skip' })).body;
    assert.ok(dismissed.unassignedChats[0].deletedAt);
    await stop();
    scan(fresh);
    await start();
    const again = (await request('state')).body;
    assert.equal(again.chats.find(c => c.id === 'route').projectId, 'dest');
    assert.deepEqual(again.unassignedChats, dismissed.unassignedChats);
    assert.equal((await request('bridge/context?provider=codex&session=route&project=bucket')).body.projectId, 'dest');
    assert.equal((await request('unassigned/restore', 'POST', { chatId: 'skip' })).body.unassignedChats[0].deletedAt, undefined);
    const created = (await request('unassigned/assign', 'POST', { chatId: 'skip', name: 'New destination' })).body;
    assert.equal(created.chats.find(c => c.id === 'skip').projectId, created.projects.find(p => p.name === 'New destination').id);
    assert.deepEqual(created.unassignedChats, []);
    assert.equal((await request('projects/bucket/restore', 'POST')).body.trashedProjects.length, 0);
    scan(threads(['new-chat']));
    const after = (await request('state')).body;
    assert.equal(after.chats.find(c => c.id === 'new-chat').projectId, 'bucket');
    assert.equal(after.trashedChats[0].id, 'discarded');
  });
});

test('discarding chats ignores stable IDs across sync and restart; shared proposals and existing cards survive', async () => {
  await withBoard(['first', 'other'], async ({ request, stop, start, data }) => {
    const applyCatalog = threads => {
      const db = openStore(resolve(data, 'board.sqlite'), []);
      try { db.change(b => mergeSnapshot(b, threads, new Date().toISOString())); } finally { db.close(); }
    };
    const chat = (id, title) => ({ id, title, projectId: 'first', waitingFor: 'input' });
    applyCatalog([chat('a', 'Old chat'), chat('b', 'Second'), chat('c', 'Shared')]);
    const batch = { fromProjectId: 'first', chatIds: ['a', 'b'] };
    const task = (session, title, mode = 'suggest') => request('bridge/tasks', 'POST', {
      projectId: 'first', title, mode, source: { provider: 'codex', session, event: title } });
    const one = (await task('a', 'Private suggestion')).body;
    const shared = (await task('a', 'Shared suggestion')).body;
    await task('c', 'Shared suggestion');
    await task('a', 'Accepted card', 'add');
    const question = { projectId: 'first', action: 'ask', question: 'Which file?', source: { provider: 'codex', session: 'a', event: 'ask' } };
    await request('bridge/questions', 'POST', question);
    assert.equal((await request('chats/trash', 'POST', { ...batch, chatIds: ['a', 'unknown'] })).code, 409);
    assert.equal((await request('state')).body.trashedChats.length, 0);
    const removed = (await request('chats/trash', 'POST', batch)).body;
    assert.deepEqual(removed.chats.map(c => c.id), ['c']);
    assert.deepEqual(removed.trashedChats.map(c => c.id), ['a', 'b']);
    assert.equal(removed.answerRequests.length, 0);
    assert.deepEqual(removed.proposals.map(p => [p.id, p.source.session]), [[shared.id, 'c']]);
    assert.equal(removed.cards[0].title, 'Accepted card');
    assert.equal(removed.cards[0].chatId, 'a');
    assert.equal((await task('a', 'Late event')).code, 409);
    assert.equal((await request('proposals/' + one.id + '/add', 'POST', {})).code, 409);
    const added = (await request('proposals/' + shared.id + '/add', 'POST', {})).body.cards.find(c => c.title === 'Shared suggestion');
    assert.equal(added.chatId, 'c');
    assert.deepEqual(added.otherChatIds ?? [], []);
    await stop();
    applyCatalog([{ ...chat('a', 'Renamed chat'), projectId: 'other', reply: { id: 'new', at: 99 } }, chat('b', 'Second'), chat('d', 'Old chat')]);
    await start();
    const synced = (await request('sync', 'POST', { full: true })).body;
    assert.deepEqual(synced.chats.map(c => c.id), ['c', 'd']);
    assert.deepEqual(synced.trashedChats, removed.trashedChats);
    assert.equal(synced.proposals.length, 0);
    assert.equal((await request('chats/move', 'POST', { ...batch, toProjectId: 'other' })).code, 409);
    const restored = (await request('chats/restore', 'POST', { ...batch, chatIds: ['a'] })).body;
    assert.deepEqual(restored.trashedChats.map(c => c.id), ['b']);
    assert.equal(restored.chats.find(c => c.id === 'a').projectId, 'first');
    assert.equal(restored.proposals[0].id, one.id);
    assert.equal(restored.answerRequests[0].session, 'a');
    assert.equal(restored.cards.length, 2);
  });
});

test('manual projects and chat assignments survive catalog sync, bridge retries and restarts', async () => {
  await withBoard(['original', 'other'], async ({ request, stop, start, data }) => {
    const snapshot = ['a', 'b', 'c'].map(id => ({ id, title: id, projectId: 'original' }));
    function syncFixture() {
      const db = openStore(resolve(data, 'board.sqlite'), []);
      try { db.change(board => mergeSnapshot(board, snapshot, new Date().toISOString())); }
      finally { db.close(); }
    }
    syncFixture();
    const source = { provider: 'codex', session: 'a', event: 'first' };
    const task = { mode: 'add', title: 'Write release notes', projectId: 'original', source };
    const receipt = (await request('bridge/tasks', 'POST', task)).body;
    const proposal = (await request('bridge/tasks', 'POST', { ...task, mode: 'suggest', title: 'Design a cover', source: { ...source, event: 'second' } })).body;
    const secondary = { ...task, mode: 'suggest', title: 'Design a cover', source: { ...source, session: 'c', event: 'cover' } };
    assert.equal((await request('bridge/tasks', 'POST', secondary)).body.id, proposal.id);
    await request('bridge/questions', 'POST', { projectId: 'original', action: 'ask', question: 'Which date?', source });
    let state = (await request('state')).body;
    const card = state.cards[0];
    assert.equal((await request('cards/' + card.id, 'PATCH', { otherChatIds: ['c'] })).code, 200);
    assert.equal((await request('projects', 'POST', { name: 'Manual' })).code, 201);
    assert.equal((await request('projects', 'POST', { name: ' manual ' })).code, 409);
    const move = { fromProjectId: 'original', name: 'Publishing', chatIds: ['a', 'b'] };
    const moved = await request('chats/move', 'POST', move);
    assert.equal(moved.code, 200);
    const target = moved.body.projects.find(p => p.name === move.name).id;
    const stale = await request('chats/move', 'POST', { ...move, name: 'Accidental', chatIds: ['a', 'c'] });
    assert.equal(stale.code, 409);
    await stop();
    syncFixture();
    await start();
    state = (await request('state')).body;
    assert.equal(state.projects.length, 4);
    assert.deepEqual(state.chats.map(c => c.projectId), [target, target, 'original']);
    assert.equal(state.cards[0].projectId, target);
    assert.deepEqual(state.cards[0].otherChatIds, ['c']);
    assert.equal(state.proposals.find(p => p.id === proposal.id).projectId, target);
    assert.equal(state.answerRequests[0].projectId, target);
    const shared = (await request('bridge/context?project=original&provider=codex&session=c')).body;
    assert.equal(shared.cards[0].number, card.number);
    assert.equal((await request('cards/' + card.id, 'PATCH', { otherChatIds: ['c', 'b'] })).code, 200);
    for (const id of ['original', target]) {
      const again = await request('bridge/tasks', 'POST', { ...task, projectId: id, title: 'Edited source title' });
      assert.equal(again.body.id, receipt.id);
      assert.equal((await request('bridge/context?project=' + id + '&provider=codex&session=a')).body.projectId, target);
    }
    await request('bridge/questions', 'POST', { projectId: 'original', action: 'answered', source });
    assert.equal((await request('state')).body.answerRequests.length, 0);
    const back = await request('chats/move', 'POST', { fromProjectId: target, toProjectId: 'original', chatIds: ['a'] });
    assert.equal(back.body.cards[0].projectId, 'original');
    assert.equal(back.body.cards.length, 1);
    await request('chats/move', 'POST', { fromProjectId: 'original', toProjectId: target, chatIds: ['a'] });
    const repeat = await request('bridge/tasks', 'POST', { ...secondary, source: { ...secondary.source, event: 'cover-again' } });
    assert.equal(repeat.body.id, proposal.id);
    const accepted = (await request('proposals/' + proposal.id + '/add', 'POST', {})).body.cards.find(c => c.title === secondary.title);
    assert.equal(accepted.projectId, target);
    assert.deepEqual(accepted.otherChatIds, ['c']);
  });
});

test('CLI, HTTP and the board share decisions and card edits across restarts', async () => {
  await withBoard([], async ({ cli, request, stop, start }) => {
    const source = ['--project', 'local', '--provider', 'example', '--session', 'thread'];
    assert.equal(cli('projects')[0].id, 'local');
    const next = 'Сверить титры с утверждённым списком.';
    const p = cli('suggest', ...source, '--next', next, '--event', 'first', 'Подготовить ролик');
    assert.equal(p.decision, 'pending');
    assert.equal(p.next, next);
    assert.equal((await request('state')).body.proposals[0].next, next);
    assert.equal((await request('proposals/' + p.id + '/add', 'POST', { status: 'invalid' })).code, 400);
    const decisions = await Promise.all([request('proposals/' + p.id + '/add', 'POST', { status: 'active' }), request('proposals/' + p.id + '/add', 'POST', { status: 'active' })]);
    assert.ok(decisions.every(d => d.code === 200 && d.body.cards.length === 1));
    assert.equal(cli('context', ...source).cards[0].status, 'active');
    const local = (await request('sync', 'POST')).body;
    assert.equal(local.sync.lastCheck.localOnly, true);
    assert.equal(local.sync.error, '');
    assert.deepEqual(local.sync.providers, [{ name: 'example', submitted: true, requested: true }]);
    const id = decisions[0].body.cards[0].id;
    assert.equal((await request('cards/' + id, 'PATCH', { status: 'review', tags: ['Видео', 'видео', 'C#'], customValue: 'Канал 2' })).code, 200);
    await request('projects/local', 'PATCH', { customFieldName: 'Площадка' });
    const dismissed = cli('suggest', ...source, '--event', 'later', 'Подготовить аудио');
    await request('proposals/' + dismissed.id + '/dismiss', 'POST');
    await stop();
    await start();
    const context = cli('context', ...source);
    assert.equal(context.customFieldName, 'Площадка');
    assert.deepEqual(context.cards[0].tags, ['Видео', 'C#']);
    assert.equal(context.cards[0].status, 'review');
    assert.equal(context.cards[0].next, next);
    assert.equal(context.cards[0].customValue, 'Канал 2');
    assert.equal(cli('suggest', ...source, '--event', 'retry', 'Подготовить аудио').decision, 'dismissed');
    assert.equal(cli('add', ...source, '--event', 'manual', 'Подготовь ролик').card.number, context.cards[0].number);
    assert.equal((await request('cards', 'POST', { projectId: 'local', title: 'Подготовить ролик' })).code, 409);
    assert.equal((await request('cards/' + id, 'PATCH', { tags: ['x'.repeat(41)] })).code, 400);
    await request('cards/' + id + '/trash', 'POST');
    assert.equal(cli('add', ...source, '--event', 'manual', 'Подготовить ролик').card.deleted, true);
    const state = (await request('state')).body;
    assert.deepEqual(state.proposals, []);
    assert.equal(state.cards.length, 1);
  });
});

test('release planning for three of ten projects preserves project scope, next steps and decisions on retry', async () => {
  const selected = ['atlas', 'studio', 'catalog'];
  const projects = [...selected, 'store', 'paper', 'notes', 'map', 'weather', 'audio', 'calendar'];
  await withBoard(projects, async ({ cli, request, stop, start }) => {
    assert.equal(cli('projects').length, 10);
    const plans = [
      ['atlas', 'Сверить расписание', 'Сверить три маршрута. Готово, когда время каждого совпадает с расписанием редактора.'],
      ['studio', 'Согласовать титры', 'Отправить финальные титры редактору и получить подтверждение.'],
      ['catalog', 'Проверить выгрузку', 'Открыть CSV и сверить число строк с количеством товаров.'],
    ];
    const add = ([id, title, next]) => cli('add', '--project', id, '--provider', 'codex', '--session', 'release-planning',
      '--event', 'release-review-1', '--next', next, title);
    const initial = plans.map(add);
    assert.equal(new Set(initial.map(result => result.card.number)).size, 3);
    for (const [i, result] of initial.entries()) {
      assert.equal(result.decision, 'added');
      assert.equal(result.card.status, 'planned');
      assert.equal(result.card.next, plans[i][2]);
    }
    const state = (await request('state')).body;
    const first = state.cards.find(c => c.projectId === 'atlas');
    assert.equal((await request('cards/' + first.id, 'PATCH', { next: 'Проверить ответ редактора', status: 'review', block: 'Ждём подтверждения' })).code, 200);
    await stop();
    await start();
    const retried = plans.map(add);
    assert.deepEqual(retried.map(r => r.card.number), initial.map(r => r.card.number));
    assert.equal(retried[0].card.status, 'review');
    assert.equal(retried[0].card.next, 'Проверить ответ редактора');
    assert.equal(cli('context', '--project', 'atlas').cards[0].block, 'Ждём подтверждения');
    const final = (await request('state')).body;
    assert.deepEqual(final.cards.map(c => c.projectId).sort(), [...selected].sort());
    assert.equal(final.proposals.length, 0);
    const invalid = await request('bridge/tasks', 'POST', { projectId: 'atlas', mode: 'add', title: 'Invalid',
      source: { provider: 'codex', session: 'release-planning', event: 'invalid' }, next: 'x'.repeat(1001) });
    assert.equal(invalid.code, 400);
  });
});

test('item and project snoozes persist independently and accepting a sleeping proposal retains its date', async () => {
  await withBoard(['atlas', 'studio'], async ({ cli, request, stop, start }) => {
    const source = ['--project', 'atlas', '--provider', 'agent', '--session', 'thread'];
    const offer = cli('suggest', ...source, 'Check schedule');
    const pause = (kind, id, until) => request('snooze', 'POST', { kind, id, until });
    assert.equal((await pause('proposal', offer.id, '2000-01-01')).code, 400);
    assert.equal((await pause('proposal', offer.id, '2099-02-30')).code, 400);
    assert.equal((await pause('proposal', offer.id, '2099-05-02')).code, 200);
    const response = await pause('project', 'atlas', '2099-05-07');
    assert.equal(response.body.proposals[0].snoozedUntil, '2099-05-02');
    const accepted = cli('add', ...source, 'Check schedule').card;
    assert.equal(accepted.snoozedUntil, '2099-05-02');
    assert.equal((await pause('proposal', offer.id, '')).code, 409);
    cli('suggest', ...source, 'Review museum prices');
    await stop();
    await start();
    const ctx = cli('context', ...source);
    assert.equal(ctx.projectSnoozedUntil, '2099-05-07');
    assert.equal(ctx.cards[0].status, 'planned');
    assert.equal(cli('context', '--project', 'studio').projectSnoozedUntil, '');
    const resumed = (await pause('project', 'atlas', '')).body;
    assert.equal(resumed.cards[0].snoozedUntil, '2099-05-02');
    assert.equal(resumed.proposals.length, 1);
    assert.equal((await pause('card', resumed.cards[0].id, '')).body.cards[0].snoozedUntil, undefined);
  });
});

test('explicit questions stay visible until answered, including across restarts and delayed retries', async () => {
  await withBoard(['atlas'], async ({ cli, request, stop, start }) => {
    const source = ['--project', 'atlas', '--provider', 'editor', '--session', 'issue-12'];
    const first = cli('ask', ...source, '--event', 'q1', 'Which cover?');
    assert.equal(cli('ask', ...source, '--event', 'q1', 'Which cover?').id, first.id);
    cli('ask', ...source, '--event', 'q2', 'Which size?');
    await stop();
    await start();
    assert.equal((await request('state')).body.answerRequests.length, 2);
    assert.ok(cli('answered', ...source, '--event', 'q1').resolved);
    assert.ok(cli('ask', ...source, '--event', 'q1', 'Which cover?').resolved);
    cli('answered', ...source, '--event', 'closed-first');
    assert.ok(cli('ask', ...source, '--event', 'closed-first', 'Late signal?').resolved);
    assert.deepEqual(cli('context', ...source).questions.map(q => q.event), ['q2']);
    assert.equal((await request('state')).body.cards.length, 0);
  });
});
