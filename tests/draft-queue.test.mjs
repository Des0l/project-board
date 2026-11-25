import test from 'node:test';
import assert from 'node:assert/strict';
import { newCard, openStore } from '../lib/model.mjs';
import { prepareDraftQueue, reviewQueue } from '../lib/draft-queue.mjs';

test('bulk drafts read a shared chat once, survive retries, and never write a card description', async () => {
  const store = openStore(':memory:', [{ id: 'p' }]);
  try {
    const board = store.change(b => {
      const chat = { id:'chat', projectId:'p' };
      b.chats.push(chat);
      newCard(b, 'p', 'Проверить экспорт CSV', chat);
      newCard(b, 'p', 'Уточнить формат дат', chat);
      newCard(b, 'p', 'Пустая задача');
      newCard(b, 'p', 'Готовый текст', chat).description = 'Моя заметка';
      newCard(b, 'p', 'В корзине', chat).deletedAt = 'today';
    });
    let reads = 0;
    const read = fn => fn({ request: async () => {
      reads++;
      return { data: [{ id:'turn', status:'completed', items:[{ type:'agentMessage', phase:'final_answer', id:'m',
        text:'Экспорт CSV должен включать строки с нулевым остатком. Формат дат должен учитывать часовой пояс.' }] }] };
    } });
    await prepareDraftQueue(store, read);
    const initial = reviewQueue(store.read());
    assert.equal(Object.keys(initial).length, 3);
    assert.equal(initial[board.cards[0].id].state, 'ready');
    assert.equal(initial[board.cards[2].id].state, 'missing');
    assert.equal(reads, 1);
    await prepareDraftQueue(store, read);
    assert.equal(reads, 1);
    assert.deepEqual(reviewQueue(store.read())[board.cards[0].id], initial[board.cards[0].id]);
    assert.deepEqual(store.read().cards, board.cards);
    store.change(b => { b.chats[0].deletedAt = 'now'; });
    assert.equal(reviewQueue(store.read())[board.cards[0].id], undefined);
  } finally { store.close(); }
});

test('a chat-title import can recover its first request from the linked thread metadata', async () => {
  const store = openStore(':memory:', [{ id: 'p' }]);
  try {
    const board = store.change(b => {
      const chat = { id:'chat', projectId:'p', title:'Найти пропавшее письмо' };
      b.chats.push(chat); newCard(b, 'p', chat.title, chat);
    });
    await prepareDraftQueue(store, fn => fn({request: async method => method === 'thread/read'
      ? {thread:{id:'chat', preview:'После подтверждения заказа письмо приходит с пустым контактом.'}} : {data:[]}}));
    assert.equal(reviewQueue(store.read())[board.cards[0].id].description, 'После подтверждения заказа письмо приходит с пустым контактом.');
  } finally { store.close(); }
});

test('failure in one history leaves other results available; concurrent manual edits take precedence', async () => {
  const store = openStore(':memory:', [{ id: 'p' }]);
  try {
    const board = store.change(b => {
      for (const id of ['a','b','c']) {
        const chat = { id, projectId:'p' };
        b.chats.push(chat); newCard(b, 'p', 'Проверить формат CSV', chat);
      }
    });
    await prepareDraftQueue(store, fn => fn({request: async (_, { threadId }) => {
      if (threadId === 'b') throw Error('offline');
      if (threadId === 'c') store.change(b => { b.cards[2].description='Моя правка'; });
      return {data:[{id:'turn', status:'completed', items:[{type:'agentMessage', id:'m', text:'Формат CSV использует запятую.'}]}]};
    }}));
    const drafts = reviewQueue(store.read());
    assert.equal(drafts[board.cards[0].id].state, 'ready');
    assert.equal(drafts[board.cards[1].id].state, 'unavailable');
    assert.equal(drafts[board.cards[2].id], undefined);
    assert.equal(store.read().cards[2].description, 'Моя правка');
  } finally { store.close(); }
});
