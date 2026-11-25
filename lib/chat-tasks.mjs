import { completedKeys, extractTasks, taskKey } from './tasks.mjs';

import { messageText, sourceDescription, supplementDescriptions } from './description.mjs';

const marker = ({ turnId, item }) => JSON.stringify([turnId, item.id]);

export function candidatesFor(item, turnId, threadId) {
  const text = messageText(item);
  const candidates = extractTasks(text, item.type === 'userMessage' ? 'user' : 'assistant');
  const titles = candidates.map(task => task.title);
  return candidates.map((task, index) => ({ ...task, description: sourceDescription(text, task.title, titles),
    source: { provider: 'codex', session: threadId, event: marker({ turnId, item }) + '/' + index } }));
}

export function unfinished(tasks, done) {
  return tasks.filter(task => task.mode === 'add' || !done?.has(taskKey(task.title)));
}

export async function readChatTasks(client, threadId, anchor) {
  let cursor = null;
  let newest = null;
  const messages = [];
  const pages = new Set();
  const completed = new Map();
  const texts = new Map();
  function collected() {
    return messages.reverse().flatMap(({ turnId, tasks }) =>
      supplementDescriptions(unfinished(tasks, completed.get(turnId)), texts.get(turnId) ?? []));
  }
  do {
    const page = await client.request('thread/items/list', {
      threadId, cursor, sortDirection: 'desc', limit: cursor === null ? 1 : 40,
    });
    for (const entry of page.data) {
      const id = marker(entry);
      newest ??= id;
      if (anchor === undefined || id === anchor) return { anchor: newest, tasks: collected() };
      const { item } = entry;
      const text = messageText(item);
      if (text) {
        if (!texts.has(entry.turnId)) texts.set(entry.turnId, []);
        texts.get(entry.turnId).push(text);
      }
      if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) {
        const keys = completed.get(entry.turnId) ?? new Set();
        for (const key of completedKeys(item.text)) keys.add(key);
        completed.set(entry.turnId, keys);
      }
      const tasks = candidatesFor(item, entry.turnId, threadId);
      if (tasks.length) messages.push({ turnId: entry.turnId, tasks });
    }
    cursor = page.nextCursor;
    if (cursor && pages.has(cursor)) throw new Error('Codex вернул повторную страницу.');
    pages.add(cursor);
  } while (cursor);
  // A missing old anchor can mean the conversation was compacted or rolled back.
  return { anchor: newest, tasks: anchor === null ? collected() : [], gap: anchor != null };
}
