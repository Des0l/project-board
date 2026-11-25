import assert from 'node:assert/strict';
import test from 'node:test';
import { join, parse, resolve } from 'node:path';
import { agentWorkDir, listChats, projectForPath } from '../lib/codex.mjs';
import { seedDemo } from '../lib/demo.mjs';
import { decideChatOffer, pendingOffers, mergeSnapshot, newCard, openStore } from '../lib/model.mjs';

const project = { id: 'example', auto: true };

test('only explicit native waiting flags appear, and the next snapshot clears resolved or archived waits', async () => {
  const workspace = { ...project, roots: [resolve('.')] };
  const statuses = { input: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    approve: { type: 'active', activeFlags: ['waitingOnApproval'] }, work: { type: 'active', activeFlags: [] }, idle: { type: 'idle' } };
  const client = { request: async () => ({ data: Object.entries(statuses).map(([id, status]) =>
    ({ id, name: 'A question?', cwd: resolve('.'), status })) }) };
  const incoming = await listChats(client, [workspace]);
  assert.deepEqual(incoming.map(c => c.waitingFor), ['input', 'approval', null, null]);
  const board = { projects: [workspace], cards: [], chats: [] };
  mergeSnapshot(board, incoming, 'first');
  delete statuses.approve;
  statuses.input = { type: 'idle' };
  mergeSnapshot(board, await listChats(client, [workspace]), 'second');
  assert.ok(board.chats.every(chat => !chat.waitingFor));
});
const firstReply = { id: 'first', at: 100, turnId: 'a' };
function thread(id, reply = firstReply) {
  return { id, projectId: project.id, title: id, reply };
}
function acceptPendingChats(board) {
  for (const chat of board.chats) {
    if (chat.cardOffer?.state === 'pending') decideChatOffer(board, chat, 'add');
  }
}
function boardTest(callback) {
  const store = openStore(':memory:', [project]);
  try {
    callback(store);
  } finally {
    store.close();
  }
}

test('initial imports set a baseline and subsequent imports expose new replies', () => boardTest(store => {
  let board = store.change(state => mergeSnapshot(state, [thread('old')], 'initial'));
  assert.equal(board.cards.length, 0);
  assert.equal(pendingOffers(board).length, 1);
  board = store.change(acceptPendingChats);
  assert.equal(board.cards[0].status, 'planned');
  assert.equal(board.cards[0].seen, 'first');
  board = store.change(state => mergeSnapshot(state, [thread('old'), thread('new')], 'next'));
  assert.equal(board.cards.length, 1);
  board = store.change(acceptPendingChats);
  assert.equal(board.cards.length, 2);
  assert.equal(board.cards[1].seen, null);
}));

test('autocards respect the project toggle and retain cards in the trash', () => boardTest(store => {
  store.change(state => mergeSnapshot(state, [thread('old')], 'initial'));
  store.change(state => {
    acceptPendingChats(state);
    state.cards[0].deletedAt = 'deleted now';
    state.projects[0].auto = false;
  });
  const offered = store.change(state => mergeSnapshot(state, [thread('old'), thread('offer')], 'with auto off'));
  assert.equal(offered.chats.length, 2);
  assert.equal(offered.cards.length, 1);
  const board = store.change(state => {
    state.projects[0].auto = true;
    mergeSnapshot(state, [thread('old'), thread('offer'), thread('new')], 'with auto on');
    acceptPendingChats(state);
  });
  assert.deepEqual(board.cards.map(card => card.chatId), ['old', 'new']);
  assert.equal(board.cards[0].deletedAt, 'deleted now');
}));

test('a refresh preserves card status, edits and newer replies', () => boardTest(store => {
  const newer = { id: 'second', at: 110, turnId: 'b' };
  store.change(state => mergeSnapshot(state, [thread('chat', newer)], 'initial'));
  const board = store.change(state => {
    acceptPendingChats(state);
    state.cards[0].status = 'review';
    state.cards[0].title = 'Edited title';
    newCard(state, project.id, 'Manual task');
    mergeSnapshot(state, [thread('chat')], 'next');
  });
  assert.equal(board.cards[0].status, 'review');
  assert.equal(board.cards[0].title, 'Edited title');
  assert.equal(board.cards[1].chatId, null);
  assert.equal(board.chats[0].reply.id, 'second');
}));


test('nested workspaces use the most specific project in either configuration order', () => {
  const outerRoot = resolve('workspace');
  const innerRoot = join(outerRoot, 'site');
  const outer = { id: 'outer', roots: [outerRoot] };
  const inner = { id: 'inner', roots: [innerRoot] };
  for (const order of [[outer, inner], [inner, outer]]) {
    assert.equal(projectForPath(order, join(innerRoot, 'client')), inner);
    assert.equal(projectForPath(order, join(outerRoot, 'site-old')), outer);
  }
});

test('agent launch uses the chat directory only inside the primary workspace', () => {
  const primary = resolve('Projects', 'Studio');
  const other = resolve('Projects', 'Archive');
  const project = { roots: [primary, other] };
  const nested = join(primary, '..notes', 'chapter');
  assert.equal(agentWorkDir(primary, nested), nested);
  assert.equal(agentWorkDir(primary, primary), primary);
  assert.equal(agentWorkDir(parse(primary).root, nested), nested);
  assert.equal(agentWorkDir(primary, resolve('Projects', 'Studio-old', 'chapter')), primary);
  assert.equal(projectForPath([project], other), project);
  assert.equal(agentWorkDir(primary, other), primary);
  assert.equal(agentWorkDir(primary, undefined), primary);
  assert.equal(agentWorkDir(primary, 'relative-folder'), primary);
});

test('chat discovery and agent launch use native path case rules', () => {
  const primary = resolve('Projects', 'Studio');
  const project = { roots: [primary] };
  const differentCase = resolve('Projects', 'studio', 'chapter');
  const windows = process.platform === 'win32';
  assert.equal(projectForPath([project], differentCase), windows ? project : null);
  assert.equal(agentWorkDir(primary, differentCase), windows ? differentCase : primary);
});

test('reopening the standalone demo preserves edits and removed cards', () => {
  const store = openStore(':memory:', [{ id: 'studio' }, { id: 'atlas' }]);
  try {
    const seeded = store.change(seedDemo);
    assert.equal(seeded.cards.length, 7);
    assert.ok(seeded.cards.every(card => !card.chatId));
    const edited = store.change(board => {
      board.cards[0].title = 'My edit';
      board.cards.splice(1, 1);
    });
    assert.deepEqual(store.change(seedDemo), edited);
  } finally {
    store.close();
  }
});

test('first scan offers each chat once even with later offers disabled', () => boardTest(store => {
  store.change(board => { board.projects[0].auto = false; });
  const offers = store.change(board => mergeSnapshot(board, [thread('one'), thread('one'), thread('two')], 'first'));
  assert.equal(offers.cards.length, 0);
  assert.equal(pendingOffers(offers).length, 2);
  const first = store.change(acceptPendingChats);
  assert.deepEqual(first.cards.map(card => [card.chatId, card.status, card.seen]), [
    ['one', 'planned', 'first'], ['two', 'planned', 'first'],
  ]);
  const later = store.change(board => {
    board.cards[0].status = 'done';
    board.cards[1].deletedAt = 'dismissed';
    mergeSnapshot(board, [thread('one'), thread('two'), thread('three')], 'later');
  });
  assert.equal(later.cards.length, 2);
  assert.equal(later.cards[0].status, 'done');
  assert.equal(later.cards[1].deletedAt, 'dismissed');
  assert.equal(later.chats.length, 3);
}));

test('first import is per scanned project and upgrading does not resurrect old skipped chats', () => boardTest(store => {
  const board = store.change(state => {
    delete state.projects[0].initialImportAt;
    state.projects[0].auto = false;
    state.syncedAt = 'before-upgrade';
    state.chats.push(thread('old'));
    state.projects.push({ id: 'another', initialImportAt: null, auto: false });
    mergeSnapshot(state, [thread('old')], 'first-project', [project.id]);
    assert.equal(state.projects[1].initialImportAt, null);
    mergeSnapshot(state, [thread('old'), { ...thread('new-project-chat'), projectId: 'another' }], 'both');
  });
  assert.equal(board.cards.length, 0);
  assert.deepEqual(pendingOffers(board).map(p => p.source.session), ['new-project-chat']);
  assert.deepEqual(board.projects.map(item => item.initialImportAt), ['before-upgrade', 'both']);
}));

test('declining a chat survives a repeat scan; two chats with the same name can be reviewed independently', () => boardTest(store => {
  const chats = [thread('a'), thread('b')].map(chat => ({ ...chat, title: 'Same title' }));
  const result = store.change(board => {
    mergeSnapshot(board, chats, 'first');
    decideChatOffer(board, board.chats[0], 'dismiss');
    decideChatOffer(board, board.chats[1], 'add', 'active');
    decideChatOffer(board, board.chats[1], 'add', 'done');
    mergeSnapshot(board, chats, 'second');
  });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].status, 'active');
  assert.equal(result.cards[0].chatId, 'b');
  assert.equal(pendingOffers(result).length, 0);
}));
