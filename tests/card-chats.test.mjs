import test from 'node:test';
import assert from 'node:assert/strict';
import { cardChats, seenIn } from '../public/card-chats.mjs';
import { mergeSnapshot, newCard, pendingOffers, setCardChats } from '../lib/model.mjs';
import { ingest, projectContext, settle } from '../lib/tasks.mjs';

function fixture() {
  const board = { nextNumber: 1, projects: [{ id: 'a', initialImportAt: null, projectTasks: true }], chats: [], cards: [] };
  const chats = Array.from({ length: 10 }, (_, i) => ({ id: 'c' + i, projectId: 'a', title: 'Чат ' + i, reply: { id: 'r' + i } }));
  mergeSnapshot(board, chats, 'first');
  return board;
}
const submit = (board, chat, title) => ingest(board, { projectId: 'a', title, mode: 'suggest', source: { provider: 'codex', session: chat, event: title } });

test('ten conversations can share one card, before and after acceptance', () => {
  const b = fixture();
  assert.equal(b.cards.length, 0);
  assert.deepEqual(pendingOffers(b), []);
  for (const chat of b.chats.slice(0, 5)) submit(b, chat.id, 'Собрать отчёт');
  assert.equal(pendingOffers(b).length, 1);
  settle(b, b.proposals[0], 'add');
  for (const chat of b.chats.slice(5)) submit(b, chat.id, 'Собрать отчёт');
  assert.equal(b.cards.length, 1);
  const card = b.cards[0];
  assert.deepEqual(cardChats(card), b.chats.map(c => c.id));
  assert.equal(card.chatId, 'c0');
  for (const chat of b.chats) assert.deepEqual(projectContext(b, 'a', chat.id, 'codex').cards.map(c => c.number), [card.number]);
  card.otherSeen.c1 = 'custom';
  setCardChats(b, card, ['c1', 'c0']);
  assert.equal(card.seen, 'custom');
  assert.equal(seenIn(card, 'c0'), 'r0');
});

test('five distinct outcomes from one conversation stay separate; old cards retain their link', () => {
  const b = fixture();
  for (let i = 0; i < 5; i++) settle(b, submit(b, 'c0', 'Снять выпуск ' + i), 'add');
  assert.equal(b.cards.length, 5);
  assert.ok(b.cards.every(c => c.chatId === 'c0'));
  assert.equal(projectContext(b, 'a', 'c0', 'codex').cards.length, 5);
  const legacy = newCard(b, 'a', 'Manual', b.chats[2]);
  assert.deepEqual(cardChats(legacy), ['c2']);
  assert.equal(seenIn(legacy, 'c2'), 'r2');
});
