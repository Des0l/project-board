import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { journalHistory, journalReply } from '../lib/journal.mjs';

const chat = { id: 'thread-1', cwd: resolve('.'), historyIssue: true };
function row(type, payload) {
  return JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', type, payload }) + '\n';
}
const meta = id => row('session_meta', { id, cwd: chat.cwd });
const event = (turn_id, type, fields = {}) => row('event_msg', { type, turn_id, thread_id: chat.id, ...fields });
function utterance(turn, id, type, text) {
  return event(turn, 'item_completed', { item: { type, id, content: [{ type: 'text', text }], phase: 'final_answer' } });
}
const finish = id => event(id, 'task_complete', { completed_at: 1700000020 });
test('branch journal baselines, catches up on complete turns, survives split writes and verifies reply identity', async () => {
  const tempRoot = resolve('.work/test-temp');
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'local-history-'));
  const path = join(dir, 'rollout-thread-1_segment.jsonl');
  const client = { request: async () => ({ thread: { ...chat, path } }) };
  try {
    await writeFile(path, meta(chat.id) + event('a','task_started')
      + utterance('a','1','UserMessage','Проверь старый архив') + utterance('a','2','AgentMessage','Старый ответ') + finish('a'));
    const initial = await journalHistory(client, chat, undefined);
    assert.deepEqual(initial.batch.tasks, []);
    const before = { ...chat, taskCursor: initial.batch.anchor, journal: initial.journal, reply: initial.activity.reply };
    assert.deepEqual(await journalReply(client, before), { id: '2', text: 'Старый ответ' });
    const half = finish('b').slice(0, -2);
    await appendFile(path, event('b','task_started') + utterance('b','3','UserMessage','Проверь форму') + utterance('b','4','AgentMessage','Проверю позже') + half);
    const during = await journalHistory(client, chat, before);
    assert.equal(during.journal.offset, initial.journal.offset);
    assert.deepEqual(during.batch.tasks, []);
    await appendFile(path, '}\n');
    const after = await journalHistory(client, chat, before);
    assert.deepEqual(after.batch.tasks.map(t => t.title), ['Проверь форму']);
    assert.equal(after.activity.reply.id, '4');
    const saved = { ...chat, taskCursor: after.batch.anchor, journal: after.journal, reply: after.activity.reply };
    assert.deepEqual((await journalHistory(client, chat, saved)).batch.tasks, []);
    await appendFile(path, event('c','task_started') + utterance('c','5','UserMessage','Удали архив') + event('c','turn_aborted'));
    assert.deepEqual((await journalHistory(client, chat, saved)).batch.tasks, []);
    await writeFile(path, meta('other-thread'));
    await assert.rejects(journalHistory(client, chat, saved), /не соответствует/);
  } finally {
    if (dir.startsWith(tempRoot + sep + 'local-history-')) await rm(dir, { recursive: true, force: true });
  }
});
