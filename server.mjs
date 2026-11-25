import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cardChats, seenIn } from './public/card-chats.mjs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityFor, agentWorkDir, listChats, openCodex } from './lib/codex.mjs';
import { classifyTitles, recommendation, routingCatalog, suggestProjects } from './lib/chat-routing.mjs';
import { columns, decideChatOffer, pendingOffers, mergeSnapshot, moveChats, newCard, openStore, setCardChats, trashedChatIds, visibleSource } from './lib/model.mjs';

import { prepareDraftQueue, queueDraft, reviewQueue, storedProposalDraft } from './lib/draft-queue.mjs';
import { readCardDraft } from './lib/card-draft.mjs';
import { readPastTasks } from './lib/history-review.mjs';
import { renameProject, reviewNames, suggestProjectName } from './lib/project-names.mjs';
import { assignProjectColors, validProjectColor } from './lib/project-colors.mjs';
import { backupBoard } from './lib/backup.mjs';
import { boardLocation } from './lib/data-location.mjs';
import { journalHistory, journalReply } from './lib/journal.mjs';
import { readChatTasks } from './lib/chat-tasks.mjs';
import { alreadyCaptured, ingest, projectContext, receipt, reconcile, settle, taskKey } from './lib/tasks.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const demo = process.argv.includes('--demo');
const offline = demo || process.env.PROJECT_BOARD_OFFLINE === '1';
const aiRouting = !offline && process.env.PROJECT_BOARD_AI_ROUTING !== '0';
const dataRoot = boardLocation(root, demo).dataDir;
const port = Number(process.env.PROJECT_BOARD_PORT || (demo ? '4180' : '4178'));
const localConfig = join(dataRoot, 'projects.local.json');
const configFile = process.env.PROJECT_BOARD_PROJECTS || (!demo && existsSync(localConfig) ? localConfig : null);
let configured;
if (demo) {
  configured = [
    { id: 'atlas', name: 'Атлас', topics: ['Редакция', 'Дизайн'] },
    { id: 'studio', name: 'Студия', topics: ['Видео', 'Звук'] },
  ];
} else if (configFile) {
  configured = JSON.parse(await readFile(configFile, 'utf8')).projects;
} else {
  const workRoot = resolve(process.env.PROJECT_BOARD_ROOT || root);
  configured = [{ id: 'local', name: basename(workRoot) || 'Мой проект', roots: [workRoot] }];
}
if (!Array.isArray(configured) || !configured.length) throw new Error('В конфигурации нужен список projects.');
const ids = new Set();
const projects = configured.map(project => {
  if (!project || typeof project.id !== 'string' || !/^[a-z0-9-]+$/.test(project.id) || project.id === 'all' || ids.has(project.id)
    || typeof project.name !== 'string' || !project.name.trim()) throw new Error('Проверь id и name проекта.');
  ids.add(project.id);
  const roots = demo ? [] : project.roots;
  if (!Array.isArray(roots) || (!demo && !roots.length) || roots.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('Укажи абсолютные рабочие папки в roots.');
  }
  const topics = project.topics ?? [];
  if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string')) throw new Error('Темы проекта должны быть строками.');
  return { id: project.id, name: project.name, auto: project.auto === true, hidden: false, projectTasks: project.projectTasks !== false, topics,
    roots: roots.map(path => resolve(path)), workRoot: roots[0] ?? root };
});
const store = openStore(join(dataRoot, 'board.sqlite'), projects);
if (configFile && !demo) {
  store.change(board => {
    const known = new Map(board.projects.map(project => [project.id, project]));
    for (const project of projects) {
      const existing = known.get(project.id);
      if (existing) {
        existing.roots = project.roots;
        existing.workRoot = project.workRoot;
      } else board.projects.push({ ...project, initialImportAt: null });
    }
  });
}
if (demo) {
  const { seedDemo } = await import('./lib/demo.mjs');
  store.change(seedDemo);
}
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/card-chats.mjs', ['card-chats.mjs', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ...Object.entries({
    'lucide.svg': 'image/svg+xml', 'number-flow.js': 'text/javascript; charset=utf-8',
    'rubik-latin.woff2': 'font/woff2', 'rubik-cyrillic.woff2': 'font/woff2',
  }).map(([name, type]) => ['/vendor/' + name, ['vendor/' + name, type]]),
]);

let clientPromise;
let syncPromise;
let preparingDrafts;
let fullCheck = false;
async function withReader(read) {
  if (offline) throw new RequestError('Чтение истории Codex выключено.', 409);
  const client = await openCodex({ root });
  try { return await read(client); } finally { client.close(); }
}
const inspectAgain = new Set();

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function getCodex() {
  if (offline) throw new RequestError('Подключение к Codex выключено в этом режиме.', 409);
  if (!clientPromise) {
    const disconnect = () => { if (clientPromise === opening) clientPromise = null; };
    const opening = openCodex({ root, onEvent: handleCodexEvent, onExit: disconnect }).catch(error => {
      disconnect();
      throw error;
    });
    clientPromise = opening;
  }
  return clientPromise;
}

function releaseLaunchClient() {
  if (!clientPromise || store.read().cards.some(card => ['starting', 'inProgress'].includes(card.run?.state))) return;
  const current = clientPromise;
  clientPromise = null;
  current.then(client => client.close()).catch(() => {});
}

function findCard(board, id) {
  const card = board.cards.find(card => card.id === id);
  if (!card) throw new RequestError('Карточка не найдена.', 404);
  return card;
}

function findProject(board, id, includeDeleted = false) {
  const project = board.projects.find(project => project.id === id);
  if (!project) throw new RequestError('Проект не найден.', 404);
  if (project.deletedAt && !includeDeleted) throw new RequestError('Сначала восстанови проект из корзины.', 409);
  return project;
}

function cleanText(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new RequestError('Проверь заполнение поля.');
  }
  return value.trim();
}

function bridgeProject(board, id, provider, session, allowTrashed = false) {
  const queued = provider === 'codex' && board.unassignedChats?.find(chat => chat.id === session);
  if (queued) {
    if (queued.deletedAt) throw new RequestError('Чат пропущен. Верни его на разбор из корзины.', 409);
    throw new RequestError('Сначала выбери проект для чата в «Неразобранных задачах».', 409);
  }
  const chat = provider === 'codex' && board.chats.find(c => c.id === session);
  if (chat?.deletedAt && !allowTrashed) throw new RequestError('Чат в корзине доски. Его можно восстановить в разделе «Корзина».', 409);
  return findProject(board, chat?.previousProjectIds?.includes(id) ? chat.projectId : id);
}

function createProject(board, name) {
  name = cleanText(name, 100, true);
  const existing = board.projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing?.deletedAt) throw new RequestError('Проект с таким названием в корзине. Его можно восстановить.', 409);
  if (existing) {
    throw new RequestError('Такой проект уже есть. Выбери его из списка или укажи другое название.', 409);
  }
  const project = { id: randomUUID(), name, roots: [], topics: [], hidden: false, auto: false, projectTasks: true,
    initialImportAt: new Date().toISOString(), nameReview: 'kept' };
  board.projects.push(project);
  assignProjectColors(board.projects);
  return project;
}

function calendarDate(value) {
  if (value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')) {
    const date = new Date(value + 'T00:00:00Z');
    if (Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + 'T')) return value;
  }
  throw new RequestError('Выбери корректную дату.');
}

function occupiedProjects(board, offers = pendingOffers(board), trashed = trashedChatIds(board)) {
  const occupied = new Set();
  for (const chat of board.chats) if (!chat.deletedAt) occupied.add(chat.projectId);
  for (const card of board.cards) if (!card.deletedAt) occupied.add(card.projectId);
  for (const offer of offers) occupied.add(offer.projectId);
  for (const q of board.answerRequests ?? []) {
    if (!q.resolved && (q.provider !== 'codex' || !trashed.has(q.session))) occupied.add(q.projectId);
  }
  return occupied;
}

function publicState() {
  const board = store.read();
  const { proposals = [], answerRequests = [], lastCheck, descriptionDrafts, ...rest } = board;
  const trashed = trashedChatIds(board);
  const activeChats = board.chats.filter(chat => !chat.deletedAt);
  const pending = pendingOffers(board, trashed);
  const occupied = occupiedProjects(board, pending, trashed);
  const projects = board.projects.filter(p => !p.deletedAt);
  const catalog = board.unassignedChats?.length && routingCatalog(board);
  const providers = new Map();
  for (const p of proposals) {
    for (const origin of [p.source, ...(p.otherSessions ?? [])]) {
      if (origin.provider !== 'codex') providers.set(origin.provider, { name: origin.provider, submitted: true });
    }
  }
  for (const name of board.bridgeSenders ?? []) providers.set(name, { name, submitted: true });
  for (const name of board.contextReaders ?? []) {
    providers.set(name, { ...providers.get(name), name, requested: true });
  }
  const naming = projects.filter(p => p.nameReview === 'pending').map(p => ({
    projectId: p.id, suggestion: suggestProjectName(activeChats.filter(c => c.projectId === p.id)),
  }));
  return { ...rest, descriptionDrafts: reviewQueue(board), naming, projects: projects.map(p => ({ ...p, canRemove: !occupied.has(p.id) })),
    unassignedChats: (board.unassignedChats ?? []).map(chat => ({
      id: chat.id, title: chat.title, folder: chat.cwd, sourceName: board.projects.find(p => p.id === chat.projectId)?.name,
      deletedAt: chat.deletedAt, ...(!chat.deletedAt && { recommendation: recommendation(chat, catalog, !aiRouting || lastCheck?.failed) }),
    })),
    trashedProjects: board.projects.filter(p => p.deletedAt).map(({ id, name, deletedAt }) => ({ id, name, deletedAt })),
    chats: activeChats.map(({ taskCursor, journal, ...chat }) => chat), proposals: pending,
    trashedChats: board.chats.filter(c => c.deletedAt).map(({ id, title, projectId, deletedAt }) => ({ id, title, projectId, deletedAt })),
    answerRequests: answerRequests.filter(item => !item.resolved && (item.provider !== 'codex' || !trashed.has(item.session))),
    bridge: { cli: join(root, 'board.mjs'), node: process.execPath, skill: join(root, 'skills', 'project-board', 'SKILL.md'), port }, columns, sync: { offline, demo, aiRouting, working: Boolean(syncPromise), error: lastCheck?.error || '', lastCheck, providers: [...providers.values()] } };
}

function recordTurn(threadId, turn) {
  const reply = turn.status === 'completed' ? (turn.items ?? []).findLast(item =>
    item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) : null;
  store.change(board => {
    const chat = board.chats.find(chat => chat.id === threadId);
    if (chat && !chat.deletedAt && reply && (!chat.reply?.at || chat.reply.at <= turn.completedAt)) chat.reply = { id: reply.id || turn.id, at: turn.completedAt, turnId: turn.id };
    for (const card of board.cards) {
      if (card.chatId !== threadId || card.run?.turnId !== turn.id) continue;
      card.run.state = turn.status;
      card.run.error = turn.error?.message ?? '';
    }
  });
}

function handleCodexEvent(method, params) {
  if (method === 'turn/completed') {
    recordTurn(params.threadId, params.turn);
    inspectAgain.add(params.threadId);
    releaseLaunchClient();
  }
}

function syncNow(full = false) {
  if (syncPromise) {
    return full && !fullCheck ? syncPromise.then(() => syncNow(true)) : syncPromise;
  }
  if (offline) {
    store.change(board => { reviewNames(board); board.lastCheck = { at: new Date().toISOString(), localOnly: true }; });
    return Promise.resolve();
  }
  fullCheck = full;
  const startedAt = new Date().toISOString();
  syncPromise = withReader(async client => {
    const board = store.read();
    const known = new Map(board.chats.map(chat => [chat.id, chat]));
    const unassigned = new Set((board.unassignedChats ?? []).map(chat => chat.id));
    const projectsById = new Map(board.projects.map(project => [project.id, project]));
    // Keep archived roots in path matching. A chat manually moved out still belongs to its destination.
    const catalog = await listChats(client, board.projects);
    const listed = catalog.filter(thread => {
      const previous = known.get(thread.id);
      return !unassigned.has(thread.id) && !previous?.deletedAt && !projectsById.get(previous?.sourceProjectId ? previous.projectId : thread.projectId)?.deletedAt;
    });
    const activeLinks = new Set(board.cards.filter(card => !card.deletedAt).flatMap(cardChats));
    const taskBatches = new Map();
    const pastBatches = new Map();
    const runs = new Map(board.cards.filter(card => card.run?.state === 'inProgress' && card.run.turnId)
      .map(card => [card.chatId, card.run.turnId]));
    const since = Math.floor(Date.parse(board.syncedAt) / 1000);
    const previousOffers = new Set(pendingOffers(board).map(p => p.id));
    const results = new Map();
    let inspected = 0;
    for (let offset = 0; offset < listed.length; offset += 6) {
      await Promise.all(listed.slice(offset, offset + 6).map(async thread => {
        const previous = known.get(thread.id);
        const project = projectsById.get(previous?.sourceProjectId ? previous.projectId : thread.projectId);
        const tracked = project.projectTasks || activeLinks.has(thread.id) || (!previous && (project.auto || !project.initialImportAt));
        const inspect = tracked && (full || previous?.taskCursor === undefined || previous.historyIssue || !previous.checked
          || previous.updatedAt !== thread.updatedAt || previous.updatedAt >= since || previous.activity === 'active'
          || runs.has(thread.id) || inspectAgain.has(thread.id));
        const historyNeeded = tracked && project.suggestTasks !== false && previous?.historyReview?.status !== 'read'
          && (!previous?.historyReview || full || previous.updatedAt !== thread.updatedAt);
        if (historyNeeded) {
          try {
            const past = await readPastTasks(client, thread);
            pastBatches.set(thread.id, past);
          } catch {
            thread.historyReview = { at: startedAt, status: 'unavailable' };
          }
        }
        if (!inspect) return;
        inspected++;
        try {
          const result = await activityFor(client, thread.id, runs.has(thread.id) ? [runs.get(thread.id)] : []);
          results.set(thread.id, result);
          inspectAgain.delete(thread.id);
          thread.checked = true;
          thread.historyIssue = false;
          if (result.reply) thread.reply = result.reply;
          if (result.latest?.status === 'inProgress') thread.activity = 'active';
          if (tracked) {
            const newlyCreated = !previous && project.initialImportAt && board.syncedAt
              && thread.createdAt >= Math.floor(Date.parse(board.syncedAt) / 1000);
            if (newlyCreated && result.latest?.status === 'inProgress') {
              taskBatches.set(thread.id, { anchor: null, tasks: [] });
            } else if (result.latest?.status !== 'inProgress' || previous?.taskCursor === undefined) {
              const batch = await readChatTasks(client, thread.id, newlyCreated ? null : previous?.taskCursor);
              taskBatches.set(thread.id, batch);
              thread.historyCheckedAt = startedAt;
            }
            if (result.latest?.status === 'inProgress') inspectAgain.add(thread.id);
          }
          thread.historySource = 'codex';
          thread.journal = null;
        } catch (error) {
          thread.historyIssue = true;
          if (/invalid paginated history lineage/i.test(error.message)) {
            try {
              const local = await journalHistory(client, thread, previous, runs.get(thread.id));
              results.set(thread.id, local.activity);
              taskBatches.set(thread.id, local.batch);
              Object.assign(thread, { historySource: 'journal', journal: local.journal,
                checked: true, historyIssue: false, historyCheckedAt: startedAt });
              if (local.activity.reply) thread.reply = local.activity.reply;
              if (local.activity.latest?.status === 'inProgress') thread.activity = 'active';
              inspectAgain.delete(thread.id);
            } catch { /* Keep the old checkpoint and retry at the next check. */ }
          }
        }
      }));
    }
    store.change(current => {
      mergeSnapshot(current, catalog, new Date().toISOString(), board.projects.map(project => project.id));
      for (const chat of current.chats) {
        if (chat.deletedAt) continue;
        const past = pastBatches.get(chat.id);
        if (past) {
          const project = findProject(current, chat.projectId);
          const eligible = project.projectTasks || current.cards.some(card => !card.deletedAt && cardChats(card).includes(chat.id))
            || (!known.has(chat.id) && (project.auto || !projectsById.get(project.id)?.initialImportAt));
          if (eligible && project.suggestTasks !== false) {
            for (const task of past.tasks) ingest(current, { ...task, projectId: chat.projectId });
            chat.historyReview = { at: startedAt, status: 'read', turns: past.turns };
          }
        }
        const batch = taskBatches.get(chat.id);
        if (!batch) continue;
        chat.taskCursor = batch.anchor;
        if (batch.gap) chat.historyGapAt = startedAt;
        const old = known.get(chat.id);
        if (old?.historyIssue && old.taskCursor === undefined && !old.reply && chat.reply) {
          for (const card of current.cards) {
            if (!cardChats(card).includes(chat.id) || seenIn(card, chat.id)) continue;
            if (card.chatId === chat.id) card.seen = chat.reply.id;
            else (card.otherSeen ??= {})[chat.id] = chat.reply.id;
          }
        }
        const project = findProject(current, chat.projectId);
        if (!project.projectTasks && !current.cards.some(card => !card.deletedAt && cardChats(card).includes(chat.id))) continue;
        for (const task of batch.tasks) {
          if (task.mode === 'add' || project.suggestTasks !== false) ingest(current, { ...task, mode: 'suggest', projectId: project.id });
        }
      }
      for (const card of current.cards) {
        if (card.run?.state !== 'inProgress') continue;
        const turn = results.get(card.chatId)?.turns.find(turn => turn.id === card.run.turnId);
        if (!turn && runs.get(card.chatId) === card.run.turnId && results.has(card.chatId)
          && current.chats.some(chat => chat.id === card.chatId && !chat.historyIssue && chat.historySource === 'codex')) {
          card.run.state = 'interrupted';
          card.run.error = 'Сохранённый запуск не найден в доступной истории Codex.';
        } else if (turn && turn.status !== 'inProgress') {
          card.run.state = turn.status;
          card.run.error = turn.error?.message ?? '';
        }
      }
      reviewNames(current);
      const issues = listed.filter(t => t.historyIssue).map(t => t.title);
      const newUnassigned = (current.unassignedChats ?? []).filter(chat => !chat.deletedAt && !unassigned.has(chat.id)).length;
      current.lastCheck = {
        at: current.syncedAt, listed: listed.length, inspected, historyRead: pastBatches.size,
        newChats: current.chats.filter(c => !c.deletedAt && !known.has(c.id) && !unassigned.has(c.id)).length + newUnassigned,
        replies: listed.filter(t => known.get(t.id)?.taskCursor !== undefined && t.reply && t.reply.id !== known.get(t.id)?.reply?.id).length,
        newOffers: pendingOffers(current).filter(p => !previousOffers.has(p.id)).length + newUnassigned,
        issues, error: issues.length ? 'Чатов с недоступной историей: ' + issues.length + '.' : '',
      };
    });
    releaseLaunchClient();
  }).catch(error => {
    store.change(board => { board.lastCheck = { at: new Date().toISOString(), failed: true, error: error.message }; });
    console.error('[Codex]', error.message);
  }).then(() => {
    if (aiRouting) return suggestProjects(store, data => classifyTitles(root, data), full);
  }).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function launch(id) {
  if (offline) throw new RequestError('Подключение к Codex выключено в этом режиме.', 409);
  let request;
  store.change(board => {
    const card = findCard(board, id);
    if (card.deletedAt) throw new RequestError('Сначала восстанови карточку.');
    const chat = board.chats.find(chat => chat.id === card.chatId);
    if (!chat || chat.deletedAt) throw new RequestError('Выбери активный чат или восстанови его из корзины.');
    if (!card.next) throw new RequestError('Сначала запиши следующий шаг.');
    if (board.cards.some(item => item.chatId === chat.id && ['starting', 'inProgress'].includes(item.run?.state))) {
      throw new RequestError('В этом чате уже запущена работа.', 409);
    }
    const project = findProject(board, card.projectId);
    const runId = randomUUID();
    card.run = { id: runId, state: 'starting', at: new Date().toISOString(), turnId: null, error: '' };
    const workspace = findProject(board, chat.sourceProjectId || chat.projectId, true);
    request = { runId, projectName: project.name, chatId: chat.id, cwd: agentWorkDir(workspace.workRoot, chat.cwd), number: card.number,
      title: card.title, status: columns.find(column => column.id === card.status).name, next: card.next };
  });
  try {
    const client = await getCodex();
    const activity = await activityFor(client, request.chatId);
    if (activity.latest?.status === 'inProgress') throw new Error('В этом чате уже идёт работа. Дождись ответа.');
    const resumed = await client.request('thread/resume', { threadId: request.chatId, excludeTurns: true });
    if (resumed.thread.status?.type === 'active') throw new Error('В этом чате уже идёт работа. Дождись ответа.');
    const message = [
      'Продолжи работу по карточке №' + request.number + ' «' + request.title + '».',
      'Проект на доске — ' + request.projectName + '.',
      'Статус на доске — ' + request.status + '.',
      'Следующий шаг — ' + request.next,
      'Выполни доступную часть в режиме чтения и верни результат в этот чат. Работай в фоне, без управления окнами и мышью.',
    ].join('\n');
    const supported = await client.request('model/list', { limit: 100, includeHidden: false });
    const model = supported.data.find(model => model.model === resumed.model)
      ?? supported.data.find(model => model.isDefault) ?? supported.data[0];
    if (!model) throw new Error('Codex не вернул доступную модель.');
    const result = await client.request('turn/start', {
      model: model.model, threadId: request.chatId, clientUserMessageId: request.runId, cwd: request.cwd,
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: message, text_elements: [] }],
    });
    store.change(board => {
      const card = findCard(board, id);
      card.run.turnId = result.turn.id;
      card.run.state = result.turn.status;
      card.run.error = result.turn.error?.message ?? '';
    });
    if (result.turn.status !== 'inProgress') recordTurn(request.chatId, result.turn);
  } catch (error) {
    store.change(board => {
      const card = findCard(board, id);
      card.run.state = 'failed';
      card.run.error = error.message;
    });
    throw new RequestError(error.message, 409);
  } finally {
    releaseLaunchClient();
  }
}

function updateCard(board, id, body) {
  const card = findCard(board, id);
  const project = findProject(board, card.projectId);
  if (body.previousDescription !== undefined && body.previousDescription !== (card.description ?? '')) {
    throw new RequestError('Описание уже изменилось. Скопируй свой текст и открой карточку заново.', 409);
  }
  if (body.status !== undefined) {
    if (!columns.some(column => column.id === body.status)) throw new RequestError('Неизвестная колонка.');
    if (card.status !== body.status) {
      card.status = body.status;
      card.statusSince = new Date().toISOString();
      delete card.statusObserved;
    }
  }
  for (const [key, limit] of [['title', 200], ['next', 1000], ['description', 4000], ['block', 400], ['customValue', 240]]) {
    if (body[key] !== undefined) card[key] = cleanText(body[key], limit, key === 'title');
  }
  for (const field of ['dueOn', 'focusOn']) {
    if (body[field] !== undefined) card[field] = calendarDate(body[field]);
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 24) throw new RequestError('Можно добавить до 24 тегов.');
    const unique = new Map();
    for (const value of body.tags) {
      const tag = cleanText(value, 40, true).replace(/\s+/gu, ' ');
      if (tag.includes(',')) throw new RequestError('Раздели теги запятыми.');
      if (!unique.has(tag.toLowerCase())) unique.set(tag.toLowerCase(), tag);
    }
    card.tags = [...unique.values()];
  }
  if (body.description?.trim() && board.descriptionDrafts) delete board.descriptionDrafts[card.id];
  if (body.topic !== undefined) {
    if (body.topic !== '' && !project.topics.includes(body.topic)) throw new RequestError('Неизвестная тема.');
    card.topic = body.topic;
  }
  if (body.chatId !== undefined || body.otherChatIds !== undefined) {
    const primary = body.chatId === undefined ? card.chatId : body.chatId;
    const others = body.otherChatIds ?? card.otherChatIds ?? [];
    if (!Array.isArray(others)) throw new RequestError('Выбери связанные чаты.');
    const ids = [...new Set([...(primary ? [primary] : []), ...others])];
    const existing = cardChats(card);
    if (ids.some(id => typeof id !== 'string' || !board.chats.some(chat => chat.id === id && (existing.includes(id) || (!chat.deletedAt && chat.projectId === project.id))))) {
      throw new RequestError('Чат не найден в проекте.', 404);
    }
    if ((ids[0] ?? null) !== card.chatId && ['starting', 'inProgress'].includes(card.run?.state)) throw new RequestError('Основной чат ещё работает.', 409);
    setCardChats(board, card, ids);
  }
  if (body.title !== undefined) reconcile(board, card);
  if (body.seen !== undefined) {
    const id = body.seenChatId ?? card.chatId;
    const chat = cardChats(card).includes(id) && board.chats.find(chat => chat.id === id && !chat.deletedAt);
    if (!chat?.reply || chat.reply.id !== body.seen) throw new RequestError('Уже появился другой ответ. Обнови карточку.', 409);
    if (chat.id === card.chatId) card.seen = body.seen;
    else (card.otherSeen ??= {})[chat.id] = body.seen;
  }
}

async function readBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32_768) throw new RequestError('Слишком большой запрос.', 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new RequestError('Неверный формат запроса.');
  }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  if (req.method === 'GET' && staticFiles.has(path)) {
    const [file, type] = staticFiles.get(path);
    const content = await readFile(join(root, 'public', file));
    res.writeHead(200, { 'Content-Type': type });
    return res.end(content);
  }
  if (req.method === 'GET' && path === '/api/launcher') return json(res, { app: 'project-board', demo, dataDir: resolve(dataRoot) });
  if (req.method === 'GET' && path === '/api/state') return json(res, publicState());

  if (req.method === 'GET' && path === '/api/bridge/projects') {
    return json(res, store.read().projects.filter(p => !p.deletedAt).map(({ id, name }) => ({ id, name })));
  }
  if (req.method === 'GET' && path === '/api/bridge/context') {
    const board = store.read();
    const provider = url.searchParams.get('provider');
    const session = url.searchParams.get('session');
    const p = bridgeProject(board, url.searchParams.get('project'), provider, session);
    if (Boolean(provider) !== Boolean(session)) throw new RequestError('Для контекста чата нужны provider и session.');
    let current = board;
    if (provider) {
      cleanText(provider, 64, true);
      cleanText(session, 240, true);
      const localClient = req.headers['x-board-action'] === '1' || (!req.headers.origin && !req.headers['sec-fetch-site']);
      if (localClient && !board.contextReaders?.includes(provider)) current = store.change(state => {
        const readers = state.contextReaders ??= [];
        if (!readers.includes(provider)) readers.push(provider);
      });
    }
    return json(res, projectContext(current, p.id, session, provider));
  }

  const cardMatch = path.match(/^\/api\/cards\/([0-9a-f-]+)(?:\/(launch|reply|trash|restore|description-draft))?$/);
  if (req.method === 'GET' && cardMatch?.[2] === 'reply') {
    const board = store.read();
    const card = findCard(board, cardMatch[1]);
    const id = url.searchParams.get('chat') || card.chatId;
    const chat = cardChats(card).includes(id) && board.chats.find(chat => chat.id === id && !chat.deletedAt);
    if (!chat?.reply) throw new RequestError('У этого чата пока нет ответа.', 404);
    if (chat.historySource === 'journal') {
      try { return json(res, await withReader(client => journalReply(client, chat))); }
      catch { throw new RequestError('Не удалось прочитать локальный ответ. Обнови доску.', 409); }
    }
    const response = await withReader(client => client.request('thread/turns/list', {
      threadId: chat.id, sortDirection: 'desc', limit: 5, itemsView: 'full',
    }));
    for (const turn of response.data) {
      const answer = turn.items.find(item => item.type === 'agentMessage' && item.id === chat.reply.id);
      if (answer) return json(res, { id: answer.id, text: answer.text });
    }
    throw new RequestError('Ответ изменился. Обнови доску.', 409);
  }

  if (!['POST', 'PATCH'].includes(req.method)) throw new RequestError('Страница не найдена.', 404);
  const ownOrigin = 'http://' + req.headers.host;
  if (req.headers['x-board-action'] !== '1' || (req.headers.origin && req.headers.origin !== ownOrigin)) {
    throw new RequestError('Запрос не с этой доски.', 403);
  }
  const body = await readBody(req);
  if (req.method === 'POST' && path === '/api/description-drafts/prepare') {
    preparingDrafts ??= prepareDraftQueue(store, withReader).finally(() => { preparingDrafts = null; });
    await preparingDrafts;
    return json(res, publicState());
  }
  const draftMatch = path.match(/^\/api\/description-drafts\/([0-9a-f-]+)\/(edit|save|skip)$/);
  if (req.method === 'POST' && draftMatch) {
    store.change(board => {
      const card = findCard(board, draftMatch[1]);
      const draft = queueDraft(board, card);
      if (!draft || draft.state === 'skipped' || body.version !== draft.version) {
        throw new RequestError('Карточка или черновик уже изменились. Обнови список.', 409);
      }
      if (draftMatch[2] === 'skip') {
        board.descriptionDrafts[card.id] = { state: 'skipped', basis: draft.basis, version: randomUUID() };
        return;
      }
      const description = cleanText(body.description, 4000, true);
      if (draftMatch[2] === 'save') updateCard(board, card.id, { description });
      else Object.assign(draft, { description, state: 'ready', version: randomUUID() });
    });
    return json(res, publicState());
  }
  if (req.method === 'POST' && (cardMatch?.[2] === 'description-draft' || path === '/api/description-draft')) {
    const board = store.read();
    let card;
    if (cardMatch) {
      card = findCard(board, cardMatch[1]);
      if (card.deletedAt) throw new RequestError('Карточка в корзине.', 409);
      const cached = queueDraft(board, card);
      if (cached?.state === 'ready') return json(res, { description: cached.description, chatId: cached.chatId });
      const proposal = storedProposalDraft(board, card);
      if (proposal) return json(res, proposal);
    } else {
      const project = findProject(board, body.projectId);
      const chat = board.chats.find(c => c.id === body.chatId && c.projectId === project.id && !c.deletedAt);
      if (!chat) throw new RequestError('Чат не найден.', 404);
      card = { title: cleanText(body.title, 200, true), chatId: chat.id };
      if (card.title === chat.title && chat.offerDescription) return json(res, { description: chat.offerDescription, chatId: chat.id });
    }
    if (!cardChats(card).some(id => board.chats.some(c => c.id === id && !c.deletedAt))) {
      throw new RequestError('У доски нет доступной переписки для этой карточки.', 409);
    }
    try { return json(res, await withReader(client => readCardDraft(client, card, board.chats))); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError('Не удалось прочитать переписку. Проверь подключение Codex и попробуй ещё раз.', 503);
    }
  }
  if (req.method === 'POST' && path === '/api/backup') {
    return json(res, { folder: backupBoard(dataRoot, join(root, 'backups'), configFile) }, 201);
  }

  if (req.method === 'POST' && path === '/api/projects') {
    store.change(board => createProject(board, body.name));
    return json(res, publicState(), 201);
  }

  if (req.method === 'POST' && ['/api/unassigned/assign', '/api/unassigned/dismiss', '/api/unassigned/restore'].includes(path)) {
    store.change(board => {
      const queue = board.unassignedChats ?? [];
      const index = queue.findIndex(chat => chat.id === body.chatId);
      if (index < 0) throw new RequestError('Чат уже распределён. Обнови доску.', 409);
      const chat = queue[index];
      if (path.endsWith('/dismiss')) { chat.deletedAt ??= new Date().toISOString(); return; }
      if (path.endsWith('/restore')) { delete chat.deletedAt; return; }
      if (chat.deletedAt) throw new RequestError('Сначала восстанови чат из корзины.', 409);
      if (body.confirmRecommendation === true) {
        const suggestion = recommendation(chat, routingCatalog(board), offline);
        if (suggestion.state !== 'match' || suggestion.projectId !== body.toProjectId) {
          throw new RequestError('Рекомендация изменилась. Обнови доску или выбери проект вручную.', 409);
        }
      }
      const target = body.toProjectId ? findProject(board, body.toProjectId) : createProject(board, body.name);
      queue.splice(index, 1);
      delete chat.routing;
      chat.reply = null;
      board.chats.push(chat);
      if (chat.projectId !== target.id) moveChats(board, [chat], target);
    });
    return json(res, publicState());
  }

  if (req.method === 'POST' && ['/api/chats/move', '/api/chats/trash', '/api/chats/restore'].includes(path)) {
    store.change(board => {
      const from = findProject(board, body.fromProjectId);
      if (!Array.isArray(body.chatIds) || !body.chatIds.length) throw new RequestError('Выбери хотя бы один чат.');
      const ids = new Set(body.chatIds);
      const chats = board.chats.filter(chat => chat.projectId === from.id && ids.has(chat.id));
      if (chats.length !== ids.size) throw new RequestError('Состав проекта изменился. Открой список чатов ещё раз.', 409);
      if (path === '/api/chats/trash') {
        if (board.cards.some(c => ids.has(c.chatId) && ['starting', 'inProgress'].includes(c.run?.state))) {
          throw new RequestError('В выбранном чате выполняется задача доски. Дождись её завершения.', 409);
        }
        const at = new Date().toISOString();
        for (const chat of chats) {
          chat.deletedAt ??= at;
          delete chat.waitingFor;
        }
        return;
      }
      if (path === '/api/chats/restore') {
        for (const chat of chats) if (chat.deletedAt) {
          delete chat.deletedAt;
          chat.checked = false;
        }
        return;
      }
      if (chats.some(c => c.deletedAt)) throw new RequestError('Сначала восстанови чат из корзины.', 409);
      const target = body.toProjectId ? findProject(board, body.toProjectId) : createProject(board, body.name);
      if (target.id === from.id) throw new RequestError('Выбери другой проект.');
      moveChats(board, chats, target);
    });
    return json(res, publicState());
  }

  if (req.method === 'POST' && path === '/api/snooze') {
    const until = calendarDate(body.until);
    if (until && until <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date())) {
      throw new RequestError('Выберите дату позже сегодняшней.');
    }
    store.change(board => {
      let item;
      if (body.kind === 'project') item = findProject(board, body.id);
      else if (body.kind === 'card') {
        item = findCard(board, body.id);
        if (item.deletedAt) throw new RequestError('Задача в корзине.', 409);
      } else if (body.kind === 'proposal') {
        item = board.proposals?.find(p => p.id === body.id && visibleSource(p, trashedChatIds(board))) ?? board.chats.find(c => !c.deletedAt && c.cardOffer?.id === body.id)?.cardOffer;
        if (!item || item.state !== 'pending') throw new RequestError('Предложение уже разобрано.', 409);
      } else throw new RequestError('Неизвестный тип задачи.');
      if (until) item.snoozedUntil = until;
      else delete item.snoozedUntil;
    });
    return json(res, publicState());
  }

  if (req.method === 'POST' && path === '/api/bridge/questions') {
    const { action } = body;
    if (!['ask', 'answered'].includes(action)) throw new RequestError('Неизвестное действие с вопросом.');
    const provider = cleanText(body.source?.provider, 64, true);
    const session = cleanText(body.source?.session, 240, true);
    const event = cleanText(body.source?.event, 240, true);
    const question = action === 'ask' ? cleanText(body.question, 1000, true) : '';
    let item;
    store.change(board => {
      const projectId = bridgeProject(board, body.projectId, provider, session, action === 'answered').id;
      const records = board.answerRequests ??= [];
      item = records.find(q => q.projectId === projectId && q.provider === provider && q.session === session && q.event === event);
      if (!item) {
        item = { id: randomUUID(), projectId, provider, session, event, question, resolved: false };
        records.push(item);
      }
      if (action === 'answered') item.resolved = true;
      const senders = board.bridgeSenders ??= [];
      if (!senders.includes(provider)) senders.push(provider);
    });
    return json(res, { id: item.id, resolved: item.resolved });
  }

  if (req.method === 'POST' && path === '/api/bridge/tasks') {
    const title = cleanText(body.title, 200, true);
    const next = body.next === undefined ? '' : cleanText(body.next, 1000);
    const description = body.description === undefined ? '' : cleanText(body.description, 4000);
    if (!['add', 'suggest'].includes(body.mode)) throw new RequestError('Выбери add или suggest.');
    const source = Object.fromEntries(['provider', 'session', 'event'].map(key =>
      [key, cleanText(body.source?.[key], key === 'provider' ? 64 : 240, true)]));
    let result;
    const board = store.change(board => {
      const project = bridgeProject(board, body.projectId, source.provider, source.session);
      const senders = board.bridgeSenders ??= [];
      if (!senders.includes(source.provider)) senders.push(source.provider);
      result = ingest(board, { projectId: project.id, source, title, next, description, mode: body.mode });
    });
    return json(res, { revision: board.revision, ...receipt(board, result) });
  }
  const proposalMatch = path.match(/^\/api\/proposals\/([0-9a-f-]+)\/(add|dismiss)$/);
  if (req.method === 'POST' && proposalMatch) {
    store.change(board => {
      const p = board.proposals?.find(p => p.id === proposalMatch[1]);
      const status = body.status === undefined ? 'planned' : body.status;
      if (!columns.some(column => column.id === status)) throw new RequestError('Выбери колонку доски.');
      if (p) {
        if (!visibleSource(p, trashedChatIds(board))) throw new RequestError('Чат предложения в корзине.', 409);
        return settle(board, p, proposalMatch[2], status);
      }
      const chat = board.chats.find(chat => !chat.deletedAt && chat.cardOffer?.id === proposalMatch[1]);
      if (!chat) throw new RequestError('Предложение не найдено.', 404);
      decideChatOffer(board, chat, proposalMatch[2], status);
    });
    return json(res, publicState());
  }

  if (req.method === 'POST' && path === '/api/sync') {
    await syncNow(body.full === true);
    return json(res, publicState());
  }
  if (req.method === 'POST' && path === '/api/cards') {
    store.change(board => {
      const project = findProject(board, body.projectId);
      const chat = body.chatId ? board.chats.find(chat => !chat.deletedAt && chat.id === body.chatId && chat.projectId === project.id) : null;
      if (body.chatId && !chat) throw new RequestError('Чат не найден.', 404);
      if (chat && body.title === undefined && board.cards.some(card => cardChats(card).includes(chat.id))) return;
      const title = cleanText(body.title ?? chat?.title, 200, true);
      const captured = alreadyCaptured(board, project.id, title) || (chat && board.cards.find(c => !c.deletedAt
        && c.projectId === project.id && cardChats(c).includes(chat.id) && taskKey(c.title) === taskKey(title)));
      if (captured) throw new RequestError('Эта задача уже на доске · #' + captured.number + '.', 409);
      const card = newCard(board, project.id, title, chat);
      if (chat && title === chat.title) card.description = chat.offerDescription ?? '';
      updateCard(board, card.id, body);
    });
    return json(res, publicState(), 201);
  }
  if (req.method === 'PATCH' && cardMatch && !cardMatch[2]) {
    store.change(board => updateCard(board, cardMatch[1], body));
    return json(res, publicState());
  }
  if (req.method === 'POST' && ['trash', 'restore'].includes(cardMatch?.[2])) {
    store.change(board => {
      const card = findCard(board, cardMatch[1]);
      findProject(board, card.projectId);
      if (cardMatch[2] === 'trash' && ['starting', 'inProgress'].includes(card.run?.state)) {
        throw new RequestError('Дождись ответа чата перед удалением.', 409);
      }
      card.deletedAt = cardMatch[2] === 'trash' ? (card.deletedAt ?? new Date().toISOString()) : null;
    });
    return json(res, publicState());
  }
  if (req.method === 'POST' && cardMatch?.[2] === 'launch') {
    await launch(cardMatch[1]);
    return json(res, publicState(), 202);
  }
  const projectMatch = path.match(/^\/api\/projects\/([a-z0-9-]+)(?:\/(trash|restore))?$/);
  if (req.method === 'POST' && projectMatch?.[2]) {
    store.change(board => {
      const project = findProject(board, projectMatch[1], true);
      if (projectMatch[2] === 'restore') delete project.deletedAt;
      else if (!project.deletedAt) {
        if (occupiedProjects(board).has(project.id)) throw new RequestError('В проекте остались чаты, карточки, предложения или вопросы. Сначала разбери их.', 409);
        project.deletedAt = new Date().toISOString();
      }
    });
    return json(res, publicState());
  }
  if (req.method === 'PATCH' && projectMatch && !projectMatch[2]) {
    store.change(board => {
      const project = findProject(board, projectMatch[1]);
      if (body.color !== undefined) {
        if (!validProjectColor(body.color)) throw new RequestError('Выбери цвет в формате #RRGGBB.');
        project.color = body.color.toLowerCase();
      }
      if (body.name !== undefined || body.keepName === true) {
        if (body.previousName !== undefined && body.previousName !== project.name) throw new RequestError('Название уже изменилось. Открой проект ещё раз.', 409);
        if (body.name !== undefined) {
          const ids = body.basisChatIds;
          if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !board.chats.some(c => c.id === id && !c.deletedAt && c.projectId === project.id)))) {
            throw new RequestError('Состав чатов изменился. Открой проект ещё раз.', 409);
          }
          renameProject(board, project, cleanText(body.name, 100, true), new Date().toISOString(), ids && new Set(ids));
        } else project.nameReview = 'kept';
      }
      for (const key of ['auto', 'hidden', 'suggestTasks', 'projectTasks']) {
        if (typeof body[key] === 'boolean') project[key] = body[key];
      }
      if (body.customFieldName !== undefined) project.customFieldName = cleanText(body.customFieldName, 55);
      if (body.reviewOn !== undefined) {
        const date = cleanText(body.reviewOn, 10);
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError('Выбери дату пересмотра.');
        project.reviewOn = date;
      }
      if (body.topic !== undefined) {
        const topic = cleanText(body.topic, 55, true);
        if (!project.topics.some(item => item.toLowerCase() === topic.toLowerCase())) project.topics.push(topic);
      }
    });
    return json(res, publicState());
  }
  throw new RequestError('Страница не найдена.', 404);
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'sha256-IRGtDaJoWUyd8zoPZ2Rl1Ad5ErPWovCmj1jXl1LdmQA=' 'sha256-rSzNlaEk7jK2+NkFeDCzSwU6BVeAJMVkcadWzMqwSQ8=' 'sha256-HR6/MuuYfB8aijiNP5MPm3YOR8WqVmL7UkE3Q8OslTs='; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const host = req.headers.host ?? '';
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return json(res, { error: 'Локальный адрес не совпадает.' }, 403);
  try {
    await route(req, res);
  } catch (error) {
    if (!(error instanceof RequestError)) console.error(error);
    json(res, { error: error instanceof RequestError ? error.message : 'Ошибка доски. Проверь журнал запуска.' }, error.status ?? 500);
  }
});

server.on('error', error => {
  console.error(error.message);
  store.close();
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  store.change(board => {
    assignProjectColors(board.projects);
    const observedAt = new Date().toISOString();
    for (const card of board.cards) {
      if (!card.statusSince) {
        card.statusSince = observedAt;
        card.statusObserved = true;
      }
      if (['starting', 'inProgress'].includes(card.run?.state) && !card.run.turnId) {
        card.run.state = 'interrupted';
        card.run.error = 'Доска перезапустилась. Проверь последний ответ перед повторным запуском.';
      }
    }
  });
  console.log('Доска проектов: http://127.0.0.1:' + port);

});

function shutdown() {
  clientPromise?.then(client => client.close()).catch(() => {});
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
