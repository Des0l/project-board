import { cardChats, seenIn } from '../public/card-chats.mjs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export const columns = [
  { id: 'planned', name: 'В планах' },
  { id: 'queued', name: 'В очереди' },
  { id: 'active', name: 'В работе' },
  { id: 'review', name: 'На проверке' },
  { id: 'done', name: 'Готово' },
];

export function openStore(file, projects) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
  const initial = { revision: 0, nextNumber: 1, projects: projects.map(project => ({ ...project, initialImportAt: null })), chats: [], cards: [], syncedAt: null };
  database.prepare('INSERT OR IGNORE INTO board VALUES (1, ?)').run(JSON.stringify(initial));
  const read = database.prepare('SELECT value FROM board WHERE id = 1');
  const write = database.prepare('UPDATE board SET value = ? WHERE id = 1');
  return {
    read: () => JSON.parse(read.get().value),
    change(mutate) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const raw = read.get().value;
        const board = JSON.parse(raw);
        mutate(board);
        if (JSON.stringify(board) !== raw) {
          board.revision++;
          write.run(JSON.stringify(board));
        }
        database.exec('COMMIT');
        return board;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => database.close(),
  };
}

export function newCard(board, projectId, title, chat = null, acknowledge = true) {
  const card = {
    id: randomUUID(), number: board.nextNumber++, projectId, title, createdAt: new Date().toISOString(),
    status: 'planned', statusSince: new Date().toISOString(), dueOn: '', focusOn: '', topic: '', next: '', description: '', block: '', tags: [], customValue: '',
    chatId: chat?.id ?? null, seen: acknowledge ? chat?.reply?.id ?? null : null, run: null,
  };
  if (chat?.cardOffer?.state === 'pending') chat.cardOffer.state = 'added';
  board.cards.push(card);
  return card;
}

export function setCardChats(board, card, ids, sourceIds = []) {
  const previous = new Set(cardChats(card));
  const seen = new Map();
  for (const id of ids) {
    const chat = board.chats.find(chat => chat.id === id && (chat.projectId === card.projectId || previous.has(id) || sourceIds.includes(id)));
    if (!chat) throw new Error('Чат не найден в проекте.');
    seen.set(id, previous.has(id) ? seenIn(card, id) ?? null : chat.reply?.id ?? null);
    if (chat.cardOffer?.state === 'pending') chat.cardOffer.state = 'added';
  }
  const [primary, ...others] = ids;
  if (card.chatId !== (primary ?? null)) card.run = null;
  card.chatId = primary ?? null;
  card.seen = seen.get(primary) ?? null;
  card.otherChatIds = others;
  card.otherSeen = Object.fromEntries(others.map(id => [id, seen.get(id)]));
}

export function decideChatOffer(board, chat, action, status = 'planned') {
  if (chat.cardOffer?.state !== 'pending') return;
  if (action === 'dismiss') {
    chat.cardOffer.state = 'dismissed';
    return;
  }
  if (!board.cards.some(card => cardChats(card).includes(chat.id))) {
    const card = newCard(board, chat.projectId, chat.title, chat, chat.cardOffer.initial);
    card.status = status;
    card.description = chat.offerDescription ?? '';
    if (chat.cardOffer.snoozedUntil) card.snoozedUntil = chat.cardOffer.snoozedUntil;
  }
  chat.cardOffer.state = 'added';
}

export function trashedChatIds(board) {
  return new Set(board.chats.filter(chat => chat.deletedAt).map(chat => chat.id));
}

export function visibleSource(proposal, trashed) {
  return [proposal.source, ...(proposal.otherSessions ?? [])].find(s => s.provider !== 'codex' || !trashed.has(s.session));
}

export function pendingOffers(board, trashed = trashedChatIds(board)) {
  const tasks = [];
  for (const p of board.proposals ?? []) {
    if (p.state !== 'pending') continue;
    const source = visibleSource(p, trashed);
    if (source) tasks.push({ id: p.id, title: p.title, next: p.next, description: source === p.source ? p.description : undefined, projectId: p.projectId, source, snoozedUntil: p.snoozedUntil, kind: 'task' });
  }
  const chats = board.chats.filter(chat => !chat.deletedAt && chat.cardOffer?.state === 'pending').map(chat => ({
    id: chat.cardOffer.id, projectId: chat.projectId, title: chat.title, description: chat.offerDescription, snoozedUntil: chat.cardOffer.snoozedUntil, kind: 'chat', source: { provider: 'codex', session: chat.id },
  }));
  return [...tasks, ...chats];
}

export function moveChats(board, chats, target) {
  const ids = new Set(chats.map(chat => chat.id));
  for (const chat of chats) {
    chat.sourceProjectId ??= chat.projectId;
    const previous = chat.previousProjectIds ??= [];
    if (!previous.includes(chat.projectId)) previous.push(chat.projectId);
    chat.projectId = target.id;
  }
  for (const card of board.cards) {
    const primary = card.chatId || (card.source?.provider === 'codex' && card.source.session);
    if (!ids.has(primary)) continue;
    card.projectId = target.id;
    if (card.topic && !target.topics.includes(card.topic)) target.topics.push(card.topic);
  }
  for (const proposal of board.proposals ?? []) {
    if (proposal.source.provider === 'codex' && ids.has(proposal.source.session)) proposal.projectId = target.id;
  }
  for (const question of board.answerRequests ?? []) {
    if (question.provider === 'codex' && ids.has(question.session)) question.projectId = target.id;
  }
}

export function mergeSnapshot(board, incoming, at, scannedIds = board.projects.map(project => project.id)) {
  const scanned = new Set(scannedIds);
  const projects = new Map(board.projects.filter(project => scanned.has(project.id)).map(project => [project.id, project]));
  // Existing databases already imported their chats under the original project settings.
  const first = new Set([...projects.values()].filter(project =>
    project.initialImportAt === null || (project.initialImportAt === undefined && !board.syncedAt)).map(project => project.id));
  const existing = new Map(board.chats.map(chat => [chat.id, chat]));
  const unassigned = new Map((board.unassignedChats ?? []).map(chat => [chat.id, chat]));
  const listed = new Set(incoming.map(chat => chat.id));
  for (const chat of board.chats) {
    if (scanned.has(chat.projectId) && !listed.has(chat.id)) delete chat.waitingFor;
  }
  const linked = new Set(board.cards.flatMap(cardChats));
  for (const thread of incoming) {
    let chat = existing.get(thread.id);
    if (chat?.deletedAt) continue;
    const queued = unassigned.get(thread.id);
    if (queued) {
      if (!queued.deletedAt) {
        queued.title = thread.title;
        queued.cwd = thread.cwd;
        queued.updatedAt = thread.updatedAt;
      }
      continue;
    }
    // A move may have been saved while the agent catalog was being read.
    const projectId = chat?.sourceProjectId ? chat.projectId : thread.projectId;
    const project = projects.get(projectId) ?? (chat?.sourceProjectId && board.projects.find(p => p.id === projectId));
    if (!project) continue;
    if (project.deletedAt) {
      // Codex timestamps have one-second precision. Updates to older chats do not make them new.
      if (!chat && Number.isFinite(thread.createdAt) && thread.createdAt >= Math.floor(Date.parse(project.deletedAt) / 1000)) {
        const entry = { id: thread.id, title: thread.title, cwd: thread.cwd, projectId, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
        (board.unassignedChats ??= []).push(entry);
        unassigned.set(entry.id, entry);
      }
      continue;
    }
    const newlyFound = !chat;
    if (newlyFound) {
      chat = { ...thread, reply: thread.reply ?? null };
      existing.set(chat.id, chat);
      board.chats.push(chat);
    } else {
      const reply = chat.reply;
      Object.assign(chat, thread, { projectId });
      if (thread.reply?.at && reply?.at > thread.reply.at) chat.reply = reply;
    }
    if (((first.has(project.id) && !project.projectTasks) || (newlyFound && project.auto)) && !linked.has(chat.id)) {
      chat.cardOffer ??= { id: randomUUID(), state: 'pending', initial: first.has(project.id) };
    }
  }
  for (const project of projects.values()) {
    if (project.deletedAt) continue;
    project.initialImportAt ??= board.syncedAt && !first.has(project.id) ? board.syncedAt : at;
  }
  board.syncedAt = at;
}
