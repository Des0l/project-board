import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor, readChatTasks } from '../lib/chat-tasks.mjs';
import { readPastTasks } from '../lib/history-review.mjs';
import { readCardDraft } from '../lib/card-draft.mjs';
import { ingest, settle } from '../lib/tasks.mjs';
import { pendingOffers } from '../lib/model.mjs';

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const final = (id, text) => ({ id, type: 'agentMessage', phase: 'final_answer', text });
const turn = (id, ...items) => ({ id, status: 'completed', completedAt: 100, items });
const history = (...turns) => ({ request: async () => ({ data: turns, nextCursor: null }) });

test('two tasks from the same message get their own descriptions before and after acceptance', async () => {
  const item = user('u', '- Add task: Review export. The file must include local dates.\n- Add task: Test uploads. Use a file over 5 MB.');
  const tasks = candidatesFor(item, 't', 'chat');
  const expected = ['The file must include local dates.', 'Use a file over 5 MB.'];
  assert.deepEqual(tasks.map(t => t.description), expected);
  const past = await readPastTasks(history(turn('t', item)), { id: 'chat' });
  for (const t of tasks) assert.equal(past.tasks.find(p => p.title === t.title).description, t.description);
  const board = { projects: [{ id: 'p' }], chats: [{ id: 'chat', projectId: 'p' }], cards: [], nextNumber: 1 };
  for (const task of tasks) ingest(board, { ...task, projectId: 'p', mode: 'suggest' });
  assert.deepEqual(pendingOffers(board).map(p => p.description), expected);
  settle(board, board.proposals[0], 'add');
  assert.equal(board.cards[0].description, expected[0]);
  board.cards[0].description = 'My notes';
  ingest(board, { ...tasks[0], projectId: 'p', description: 'different', mode: 'add' });
  assert.equal(board.cards[0].description, 'My notes');
});

test('a title-only request can use a relevant reply from the same turn; other turns and tools are excluded', async () => {
  const items = [
    { turnId: 'y', item: final('2', 'Экспорт CSV отправляется на почту.') },
    { turnId: 'x', item: { type: 'commandExecution', text: 'Экспорт CSV там.' } },
    { turnId: 'x', item: final('1', 'Экспорт CSV должен сохранять местные даты.') },
    { turnId: 'x', item: user('0', 'Проверь экспорт CSV.') },
  ];
  const batch = await readChatTasks({ request: async () => ({ data: items }) }, 'chat', null);
  assert.equal(batch.tasks[0].description, 'Экспорт CSV должен сохранять местные даты.');
});

test('draft uses the recorded source, skips trashed chats and does not mutate the original card', async () => {
  const item = user('u', 'Добавь задачу: проверить экспорт CSV. Даты нужны по Москве.');
  const card = { chatId: 'chat', otherChatIds: ['trash'], title: 'Проверить экспорт CSV', number: 5, description: 'Мой текст',
    source: { provider: 'codex', session: 'chat', event: '["t","u"]/0' } };
  const chats = [{ id: 'chat' }, { id: 'trash', deletedAt: 'today' }, { id: 'unrelated' }];
  const client = { request: async (_, args) => {
    assert.equal(args.threadId, 'chat');
    return { data: [turn('other', final('a', 'Экспорт CSV уходит в другой проект.')), turn('t', item)] };
  } };
  const draft = await readCardDraft(client, card, chats);
  assert.equal(draft.description, 'Даты нужны по Москве.');
  assert.equal(draft.turnId, 't');
  assert.equal(card.description, 'Мой текст');
  assert.equal((await readCardDraft(history(turn('t', user('u', 'Привет!'))), card, chats)).description, '');
});

test('a legacy manual card can find relevant details in a secondary linked chat', async () => {
  const card = { number: 5, chatId: 'a', otherChatIds: ['b'], title: 'Проверить экспорт таблицы', next: 'Поля содержат местные даты.' };
  const client = { request: async (_, { threadId }) => ({ data: [turn('t', final('i',
    threadId === 'b' ? 'Экспорт таблицы содержит даты по Москве.' : 'Срок оплаты через неделю.'))] }) };
  const draft = await readCardDraft(client, card, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(draft.chatId, 'b');
  assert.equal(draft.description, 'Экспорт таблицы содержит даты по Москве.');
});
