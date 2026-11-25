import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../lib/model.mjs';
import { recommendation, routingCatalog, suggestProjects } from '../lib/chat-routing.mjs';

function fixture() {
  const store = openStore(':memory:', [{ id: 'maps', name: 'Атлас', topics: ['Маршруты'] }, { id: 'music', name: 'Звук' },
    { id: 'old', name: 'Old workspace', deletedAt: 'yesterday' }]);
  store.change(b => {
    b.chats.push({ id: 'seed', projectId: 'music', sourceProjectId: 'old', title: 'Запись интервью', cwd: '/private' },
      { id: 'deleted', projectId: 'maps', title: 'removed', deletedAt: 'yesterday' });
    b.unassignedChats = [{ id: 'one', projectId: 'old', title: 'Микрофон', cwd: '/private' },
      { id: 'two', projectId: 'old', title: 'Позже' }, { id: 'skip', title: 'removed', deletedAt: 'yesterday' }];
  });
  return store;
}

test('model gets title evidence only; a suggestion and an abstention are cached without moving either chat', async () => {
  const store = fixture();
  try {
    let calls = 0;
    const classify = async input => {
      calls++;
      assert.deepEqual(input, { projects: [
        { project: 1, name: 'Атлас', topics: ['Маршруты'], examples: [] },
        { project: 2, name: 'Звук', topics: [], examples: ['Запись интервью'] }],
        chats: [{ chat: 1, title: 'Микрофон' }, { chat: 2, title: 'Позже' }] });
      return [{ chat: 2, project: null, reason: '' }, { chat: 1, project: 2, reason: 'Тема записи звука.' }];
    };
    await suggestProjects(store, classify);
    await suggestProjects(store, classify, true);
    const board = store.read();
    assert.equal(calls, 1);
    assert.deepEqual(board.unassignedChats.map(c => c.id), ['one', 'two', 'skip']);
    assert.equal(board.unassignedChats[0].routing.projectId, 'music');
    assert.equal(board.unassignedChats[1].routing.state, 'uncertain');
    assert.equal(board.unassignedChats[2].routing, undefined);
    assert.equal(board.cards.length, 0);
    board.chats.push({ title: 'Ещё один пример', projectId: 'maps' });
    assert.equal(recommendation(board.unassignedChats[0], routingCatalog(board), false).state, 'match');
    board.projects[1].deletedAt = 'today';
    assert.equal(recommendation(board.unassignedChats[0], routingCatalog(board), false).state, 'pending');
  } finally { store.close(); }
});

test('unavailable or invalid model output stays manual; a retry cannot undo a concurrent user decision', async () => {
  const store = fixture();
  try {
    await suggestProjects(store, async () => { throw Error('offline'); });
    assert.equal(store.read().unassignedChats[0].routing.state, 'unavailable');
    let calls = 0;
    await suggestProjects(store, () => { calls++; });
    assert.equal(calls, 0);
    await suggestProjects(store, async () => {
      store.change(b => { b.unassignedChats.splice(0, 1); });
      return [{ chat: 1, project: 1, reason: 'ok' }, { chat: 2, project: 99, reason: 'invented' }];
    }, true);
    assert.deepEqual(store.read().unassignedChats.map(c => c.id), ['two', 'skip']);
    assert.equal(store.read().unassignedChats[0].routing.state, 'unavailable');
    await suggestProjects(store, async () => [{ chat: 1, project: 1, reason: 'A' }, { chat: 1, project: 2, reason: 'B' }], true);
    assert.equal(store.read().unassignedChats[0].routing.state, 'unavailable');
  } finally { store.close(); }
});
