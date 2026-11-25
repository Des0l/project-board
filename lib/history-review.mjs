import { createHash } from 'node:crypto';
import { completedKeys, taskKey } from './tasks.mjs';
import { journalHistory } from './journal.mjs';

import { messageText, sourceDescription, supplementDescriptions } from './description.mjs';

const deferred = /^(?:(?:а|и|ну|тогда|мы|нам|мне|я)\s+)*(?:(?:на\s+(?:будущее|потом|завтра)|позже|потом|завтра|дальше\s+(?:сможем|нужно|надо)|(?:ещ[её]\s+)?(?:нужно|надо)\s+будет|осталось|оста[её]тся|предстоит|следующ(?:ий шаг|ая задача)|next (?:step|task)|we still need to|still need to|for later|todo|backlog)\s*[:—–,-]?\s+)(?:(?:нам|надо|нужно|будет|можно|сможем|давай)\s+)*/iu;
const backlog = /^(?:(?:слышь|пожалуйста|please)[,\s]+)?(?:добавь(?:те)?\s+задачу|add (?:a )?task|\/task)\s*[:—–-]?\s+/iu;
const heading = /^(?:(?:что\s+)?(?:осталось(?: сделать)?|дальше|предстоит|планируется)|следующие шаги|(?:план на|на) (?:потом|завтра|будущее)|задачи на будущее|next steps|outstanding tasks|todo|backlog)\s*[:—-]?$/iu;
const actionable = /^(?:[а-яё-]{2,}(?:ть|ти|чь)(?:ся)?|проверь|добавь|подготовь|собери|сделай|открой|провести|проведи|найди|покажи|исправь|перенеси|уточни|check|add|prepare|publish|test|fix|review|create|finish|build|update|verify|write|implement|send|run|enable|remove|decide)\s+\S/iu;
const sensitive = /(?:https?:\/\/|[A-Z]:[\\/]|Bearer\s|(?:token|password|секрет|пароль|api.?key)\s*[:=]|[a-z\d_/-]{40,}|@[\w.-]+\.\w+)/iu;

function cleanText(text) {
  return text.replace(/(?:\x60{3}|~~~)[\s\S]*?(?:(?:\x60{3}|~~~)|$)/gu, '')
    .replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, '$1')
    .replace(/\*\*|__|\x60/gu, '');
}

function historicalCandidates(text, role, recent) {
  if (!text || /^\s*(?:<|# AGENTS\.md|Продолжи работу по карточке №)/iu.test(text)) return [];
  const out = [];
  let inPlan = false;
  let datedPlan = false;
  for (const raw of cleanText(text).split(/\r?\n/u)) {
    const line = raw.trim().replace(/^#{1,6}\s+/u, '');
    if (!line || line.startsWith('>')) continue;
    if (heading.test(line)) { inPlan = true; datedPlan = /завтра|на будущее|backlog/iu.test(line); continue; }
    const list = /^(?:[-*•]|\d+[.)])\s+/u.test(line);
    if (!list) inPlan = false;
    const body = line.replace(/^(?:[-*•]|\d+[.)])\s+/u, '');
    const box = /^\[ \]\s+/u.test(body);
    if (/^\[[xX]\]/u.test(body)) continue;
    for (const [index, sentence] of body.replace(/^\[ \]\s+/u, '').split(/(?<=[.!?])\s+/u).entries()) {
      if (index > 0 && inPlan && list) continue;
      if (sentence.endsWith('?') || sensitive.test(sentence)) continue;
      const direct = role === 'user' && backlog.test(sentence);
      const strong = direct || box || /^(?:todo|backlog|на будущее|задачи? на потом)\s*[:—-]/iu.test(sentence);
      if (!strong && !recent && role === 'assistant') continue;
      let title;
      if (direct) title = sentence.replace(backlog, '');
      else if (deferred.test(sentence)) title = sentence.replace(deferred, '');
      else if (box || inPlan && list) title = sentence;
      else if (recent && role === 'assistant') {
        const untested = sentence.match(/^В ([\p{L}\d][\p{L}\d -]{1,45}) (эту версию|расширение|приложение|сборку|форму) (?:пока |ещ[её] )?не проверял[аи]?[.!]?$/iu);
        if (untested) title = 'Проверить ' + untested[2] + ' в ' + untested[1];
      }
      if (!title) continue;
      title = title.replace(/[.!:]+$/u, '').replace(/\s+/gu, ' ').trim();
      const note = title.match(/^(?:пометь|запиши)\s+.{0,25}?про\s+(.{3,55}?)\s+[-—–]\s+(.+)$/iu);
      if (note) title = note[2].split(/\s+\(|\s+[-—–]\s+или нет|,?\s+подумаем потом/iu)[0].trim() + ' · ' + note[1].trim();
      if (/^(?:есть (?:сайт|проект)|я |это |у меня |запусти .{0,40}(?:окно|браузер)\s*,)/iu.test(title)) continue;
      if (title.length < 9 || title.length > 175 || (!direct && !(inPlan && list && datedPlan) && !actionable.test(title)) || /\b(?:localhost|127\.0\.0\.1)\b/iu.test(title)) continue;
      out.push(title[0].toUpperCase() + title.slice(1));
    }
  }
  return out;
}

function reviewTurn(turn) {
  const positives = { recent: [], older: [] };
  const done = new Set();
  for (const item of turn.items) {
    const role = item.type === 'userMessage' ? 'user' : 'assistant';
    if (role === 'assistant' && (item.type !== 'agentMessage' || (item.phase != null && item.phase !== 'final_answer'))) continue;
    const text = role === 'user' ? item.content.filter(s => s.type === 'text').map(s => s.text).join('\n') : item.text;
    if (!text) continue;
    if (role === 'assistant') for (const key of completedKeys(cleanText(text))) done.add(key);
    for (const [kind, recent] of [['recent', true], ['older', false]]) {
      const titles = historicalCandidates(text, role, recent);
      for (const title of titles) positives[kind].push({ title, itemId: item.id, description: sourceDescription(text, title, titles) });
    }
  }
  const messages = turn.items.map(messageText).filter(Boolean);
  for (const tasks of Object.values(positives)) supplementDescriptions(tasks, messages);
  return { id: turn.id, at: turn.completedAt ?? turn.startedAt ?? 0, positives, done };
}

function outstanding(turns, chatId) {
  turns.sort((a, b) => b.at - a.at);
  const laterDone = new Set();
  const seen = new Set();
  const tasks = [];
  for (const [i, turn] of turns.entries()) {
    for (const key of turn.done) laterDone.add(key);
    for (const { title, itemId, description } of turn.positives[i < 3 ? 'recent' : 'older']) {
      const key = taskKey(title);
      if (laterDone.has(key) || seen.has(key)) continue;
      seen.add(key);
      const digest = createHash('sha256').update(key).digest('hex').slice(0, 20);
      tasks.push({ title, description, mode: 'suggest', source: { provider: 'codex', session: chatId,
        event: JSON.stringify([turn.id, itemId]) + '/history/' + digest, turnId: turn.id, history: true, at: turn.at } });
    }
  }
  return { tasks, turns: turns.length };
}

export async function visitChatTurns(client, chat, observe, reset) {
  let cursor = null;
  const pages = new Set();
  try {
    do {
      const page = await client.request('thread/turns/list', { threadId: chat.id, sortDirection: 'desc', itemsView: 'summary', cursor, limit: 30 });
      for (const turn of page.data) if (turn.status === 'completed') observe(turn);
      cursor = page.nextCursor;
      if (cursor && pages.has(cursor)) throw new Error('Повтор страницы истории.');
      pages.add(cursor);
    } while (cursor);
  } catch (error) {
    if (!/invalid paginated history lineage/i.test(error.message)) throw error;
    reset();
    await journalHistory(client, chat, undefined, undefined, observe);
  }
}

export async function readPastTasks(client, chat) {
  const turns = new Map();
  await visitChatTurns(client, chat, turn => turns.set(turn.id, reviewTurn(turn)), () => turns.clear());
  return outstanding([...turns.values()], chat.id);
}
