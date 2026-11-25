import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTasks, ingest, projectContext, receipt, reconcile, settle } from '../lib/tasks.mjs';
import { readChatTasks } from '../lib/chat-tasks.mjs';
import { newCard, openStore } from '../lib/model.mjs';

const event = (title, id, mode = 'suggest', provider = 'codex', session = 'one') =>
  ({ projectId: 'p', title, mode, source: { provider, session, event: id } });
function fixture() {
  return { projects: [{ id: 'p' }, { id: 'q' }], chats: [{ id: 'one', projectId: 'p' }], cards: [], nextNumber: 1 };
}

test('direct instructions in either language are distinct from inferred tasks', () => {
  assert.deepEqual(extractTasks('Слышь, добавь задачу: проверить форму', 'user'), [{ mode: 'add', title: 'Проверить форму' }]);
  assert.deepEqual(extractTasks('Добавь задачу «Снять интервью»', 'user'), [{ mode: 'add', title: 'Снять интервью' }]);
  assert.equal(extractTasks('Please add a task: Translate the map', 'user')[0].mode, 'add');
  assert.deepEqual(extractTasks('Давай обновим карту и проверь форму.', 'user').map(x => x.title), ['Обновим карту','Проверь форму']);
  assert.equal(extractTasks('Хочу, чтобы карточки показывали теги', 'user')[0].mode, 'suggest');
  assert.deepEqual(extractTasks('Next steps:\n1. Record the interview\n2. Get approval', 'assistant').map(x => x.mode), ['suggest', 'suggest']);
  assert.equal(extractTasks('Следующий шаг — подготовить фото', 'assistant')[0].mode, 'suggest');
  assert.deepEqual(extractTasks('Add task: deploy the site', 'assistant'), []);
});

test('chatter, examples, quoted commands, acknowledgements and board echoes are quiet', () => {
  for (const text of ['да', 'Добавь задачу.', 'Add a task', 'Спасибо!','Мы уже подготовили баннер.', 'Может, добавить форму?', 'Проверь ещё раз.', 'Не надо добавлять экспорт',
    '> Add task: write fake task', 'Пример:\n\x60\x60\x60text\nAdd task: quoted code\n\x60\x60\x60', '<environment_context>\nAdd task: fake',
    'Продолжи работу по карточке №1\nСледующий шаг — опубликовать пост', '- [x] Prepare the report']) {
    assert.deepEqual(extractTasks(text, 'user'), [], text);
  }
});

test('stable event IDs, title variants, source scoping, deleted cards and status feedback', () => {
  const board = fixture();
  const p = ingest(board, event('Проверь экспорт CSV', 'item1'));
  const repeated = ingest(board, event('Проверить экспорт CSV.', 'other', 'suggest', 'other', 'two'));
  assert.equal(repeated.id, p.id);
  settle(board, p, 'add');
  settle(board, p, 'add');
  const card = board.cards[0];
  Object.assign(card, { title: 'Проверка выгрузки', status: 'review' });
  assert.equal(ingest(board, event('Совсем другой заголовок', 'item1')).id, p.id);
  const scoped = projectContext(board, 'p', 'two', 'other');
  assert.equal(scoped.cards[0].title, card.title);
  assert.equal(scoped.cards[0].status, 'review');
  assert.equal(card.chatId, 'one');
  card.deletedAt = 'today';
  assert.equal(receipt(board, ingest(board, event('Проверь экспорт CSV', 'again', 'add'))).card.deleted, true);
  assert.equal(board.cards.length, 1);
  assert.notEqual(ingest(board, event('Проверь экспорт PDF', 'item2')).id, p.id);
  assert.notEqual(ingest(board, { ...event('Проверь экспорт CSV', 'item1'), projectId: 'q' }).id, p.id);
});

test('dismissal survives replay until a fresh explicit request', () => {
  const board = fixture();
  const p = ingest(board, event('Cut video 2', 'a'));
  settle(board, p, 'dismiss');
  settle(board, p, 'add'); // late browser request
  assert.equal(ingest(board, event('Cut video 2', 'b')).state, 'dismissed');
  assert.equal(ingest(board, event('Cut video 2', 'a', 'add')).state, 'dismissed');
  assert.equal(board.cards.length, 0);
  assert.equal(ingest(board, event('Cut video 2', 'fresh', 'add')).state, 'added');
});

test('manual cards arriving on either side of a proposal cover the task', () => {
  const board = fixture();
  const p = ingest(board, event('Add export', '1'));
  const manual = newCard(board, 'p', 'Add export');
  reconcile(board, manual);
  assert.equal(p.cardId, manual.id);
  newCard(board, 'p', 'Fix export');
  assert.equal(ingest(board, event('Fix export', '2')).state, 'added');
  assert.equal(board.cards.length, 2);
});

const entry = (id, text, type = 'userMessage') => ({ turnId: 't', item: type === 'userMessage'
  ? { id, type, content: [{ type: 'text', text }] } : { id, type, phase: 'final_answer', text } });
function history(pages) {
  return { request: async (_, p) => {
    const index = Number(p.cursor ?? 0);
    const items = pages.flat();
    const size = Math.min(p.limit, 2);
    return { data: items.slice(index, index + size), nextCursor: index + size < items.length ? String(index + size) : null };
  } };
}
test('cursor baselines old history, catches up across pages, skips tools and handles rollback', async () => {
  const old = entry('0', 'Add task: old task');
  const baseline = await readChatTasks(history([[old]]), 'one', undefined);
  assert.deepEqual(baseline.tasks, []);
  const fresh = history([[entry('3','Next step: Publish report','agentMessage'), entry('2','Add task: tool output','commandExecution')],
    [entry('1','Сделай список'), old]]);
  const batch = await readChatTasks(fresh, 'one', baseline.anchor);
  assert.deepEqual(batch.tasks.map(x => x.title), ['Сделай список', 'Publish report']);
  assert.deepEqual((await readChatTasks(fresh, 'one', batch.anchor)).tasks, []);
  const reset = await readChatTasks(fresh, 'one', 'forgotten');
  assert.deepEqual(reset.tasks, []);
  assert.equal(reset.gap, true);
  assert.equal((await readChatTasks(fresh, 'one', null)).tasks.length, 3);
  await assert.rejects(readChatTasks({ request() { throw Error('offline'); } }, 'one', baseline.anchor), /offline/);
});

test('explicit completion in the same turn suppresses only the matching inferred action', async () => {
  const items = [entry('4', 'Обновил карту.', 'agentMessage'), entry('3','Добавь задачу: обновить карту'),
    entry('2','Обнови карту и проверь подписи')];
  const batch = await readChatTasks(history([items]), 'one', null);
  assert.deepEqual(batch.tasks.map(t => [t.mode, t.title]), [['suggest','Проверь подписи'], ['add','Обновить карту']]);
});

test('task events and checkpoints commit together or fully roll back', () => {
  const db = openStore(':memory:', [{ id: 'p' }]);
  try {
    assert.throws(() => db.change(board => {
      ingest(board, event('Task A', '1', 'add'));
      board.chats.push({ taskCursor: 'after' });
      throw Error('interrupted');
    }));
    const board = db.read();
    assert.equal(board.cards.length, 0);
    assert.equal(board.chats.length, 0);
    assert.equal(board.proposals, undefined);
  } finally { db.close(); }
});
