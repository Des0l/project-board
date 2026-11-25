import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { completedKeys } from './tasks.mjs';
import { messageText, supplementDescriptions } from './description.mjs';
import { candidatesFor, unfinished } from './chat-tasks.mjs';

// Codex supplies this path through thread/read. Only the selected thread's own
// completed events are eligible; never traverse its broken parent chain.
async function* records(file, start, end) {
  const chunk = Buffer.allocUnsafe(128 * 1024);
  let carry = [];
  let lineStart = start;
  for (let pos = start; pos < end;) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, end - pos), pos);
    if (!bytesRead) throw new Error('Журнал изменился во время чтения.');
    let i = 0;
    while (i < bytesRead) {
      const lf = chunk.subarray(i, bytesRead).indexOf(10);
      if (lf < 0) { carry.push(Buffer.from(chunk.subarray(i, bytesRead))); break; }
      const part = chunk.subarray(i, i + lf);
      const raw = carry.length ? Buffer.concat([...carry, part]) : part;
      const next = pos + i + lf + 1;
      if (raw.length) yield { data: JSON.parse(raw.toString('utf8')), start: lineStart, end: next };
      lineStart = next;
      carry = [];
      i += lf + 1;
    }
    pos += bytesRead;
  }
  // A writer may still be appending the last line. Its offset stays uncommitted.
}

async function fingerprint(file, offset) {
  const length = Math.min(offset, 256);
  const tail = Buffer.alloc(length);
  const { bytesRead } = await file.read(tail, 0, length, offset - length);
  if (bytesRead !== length) throw new Error('Не удалось сверить позицию в журнале.');
  return createHash('sha256').update(tail).digest('hex');
}

async function withJournal(client, chat, read) {
  const { thread } = await client.request('thread/read', { threadId: chat.id, includeTurns: false });
  if (thread.id !== chat.id || !thread.path || !isAbsolute(thread.path)
    || !basename(thread.path).includes(chat.id) || !thread.path.endsWith('.jsonl')) throw new Error('Codex не вернул журнал этого чата.');
  const file = await open(thread.path, 'r');
  try {
    const { size } = await file.stat();
    const { value: first } = await records(file, 0, size).next();
    const meta = first?.data.payload;
    if (first?.data.type !== 'session_meta' || meta?.id !== chat.id || !meta.cwd
      || resolve(meta.cwd) !== resolve(chat.cwd)) throw new Error('Журнал не соответствует чату проекта.');
    return await read(file, size, first.end);
  } finally { await file.close(); }
}

function message(payload) {
  const item = payload.item;
  if (!item?.id || !Array.isArray(item.content)) return;
  const text = item.content.filter(c => typeof c.text === 'string' && c.type?.toLowerCase() === 'text').map(c => c.text).join('\n');
  if (item.type === 'UserMessage') return { id: item.id, type: 'userMessage', content: [{ type: 'text', text }] };
  if (item.type === 'AgentMessage' && (item.phase === 'final_answer' || item.phase == null)) return { id: item.id, type: 'agentMessage', text, phase: item.phase };
}

export async function journalHistory(client, chat, previous, expectedTurn, observe) {
  return withJournal(client, chat, async (file, size, headerEnd) => {
    const saved = previous?.journal;
    const resumed = !expectedTurn && saved && saved.offset >= headerEnd && saved.offset <= size
      && await fingerprint(file, saved.offset) === saved.fingerprint;
    let offset = resumed ? saved.offset : headerEnd;
    let anchor = resumed ? previous.taskCursor : null;
    let positionKnown = Boolean(resumed || previous?.taskCursor === null);
    const since = Date.parse(previous?.historyCheckedAt);
    let reply = resumed ? previous.reply : null;
    let preview = resumed ? saved.preview : null;
    let latest;
    let current;
    const turns = [];
    const tasks = [];
    for await (const { data, start, end } of records(file, offset, size)) {
      if (data.type !== 'event_msg') continue;
      const p = data.payload;
      if (!p?.turn_id || (p.thread_id && p.thread_id !== chat.id)) continue;
      const id = p.turn_id;
      if (p.type === 'task_started' || (p.type === 'item_completed' && !current)) {
        current = { id, items: observe ? [] : null, tasks: [], texts: [], done: new Set(), last: null, anchor };
        latest = { id, status: 'inProgress' };
      }
      if (current?.id !== id) continue;
      if (p.type === 'item_completed') {
        const marker = JSON.stringify([id, p.item?.id]);
        const item = message(p);
        if (item) {
          current.items?.push(item);
          current.anchor = marker;
          if (item.type === 'agentMessage') {
            current.last = { id: item.id, start, end };
            for (const key of completedKeys(item.text)) current.done.add(key);
          }
          if (positionKnown || (Number.isFinite(since) && Date.parse(data.timestamp) >= since)) {
            current.texts.push(messageText(item));
            current.tasks.push(...candidatesFor(item, id, chat.id));
          }
        }
        if (marker === previous?.taskCursor) positionKnown = true;
      } else if (p.type === 'turn_aborted' || p.type === 'task_complete') {
        const at = p.completed_at ?? Math.floor(Date.parse(data.timestamp) / 1000);
        const complete = p.type === 'task_complete';
        if (complete) {
          if (observe) observe({ id, status: 'completed', items: current.items, completedAt: at });
          tasks.push(...supplementDescriptions(unfinished(current.tasks, current.done), current.texts));
          if (current.last) {
            preview = current.last;
            reply = { id: preview.id, at, turnId: id };
          }
        }
        latest = { id, status: complete ? 'completed' : 'interrupted' };
        turns.push(latest);
        offset = end;
        anchor = current.anchor;
        current = null;
      }
    }
    if (latest?.status === 'inProgress') turns.push(latest);
    return {
      journal: { offset, fingerprint: await fingerprint(file, offset), preview },
      activity: { reply, latest, turns },
      batch: { anchor, tasks, gap: !positionKnown && previous?.taskCursor != null && !Number.isFinite(since) },
    };
  });
}

export async function journalReply(client, chat) {
  return withJournal(client, chat, async (file, size) => {
    const p = chat.journal?.preview;
    if (p && p.id === chat.reply?.id && p.end <= size) {
      for await (const { data } of records(file, p.start, p.end)) {
        const item = message(data.payload);
        if (data.type === 'event_msg' && data.payload.type === 'item_completed' && data.payload.thread_id === chat.id
          && item?.type === 'agentMessage' && item.id === p.id) return { id: item.id, text: item.text };
      }
    }
    throw new Error('Позиция ответа изменилась. Обнови доску.');
  });
}
