import { createHash, randomUUID } from 'node:crypto';
import { cardChats } from '../public/card-chats.mjs';
import { newCard, setCardChats, trashedChatIds, visibleSource } from './model.mjs';

const actions = [
  ['add', 'добавь|добавьте|добавим|добавить|добавляй|add'],
  ['create', 'создай|создайте|создать|создадим|create'],
  ['prepare', 'подготовь|подготовьте|подготовить|подготовим|prepare'],
  ['check', 'проверь|проверьте|проверить|проверим|check|verify'],
  ['make', 'сделай|сделайте|сделать|сделаем|make|build'],
  ['fix', 'исправь|исправьте|исправить|исправим|почини|починить|fix'],
  ['update', 'обнови|обновите|обновить|обновим|update'],
  ['remove', 'удали|удалить|удалите|убери|убрать|remove|delete'],
  ['write', 'напиши|написать|напишите|write|draft'],
  ['send', 'отправь|отправить|отправьте|send'],
  ['design', 'спроектируй|спроектировать|design'],
  ['implement', 'реализуй|реализовать|внедри|внедрить|implement'],
  ['configure', 'настрой|настроить|настроим|configure'],
  ['collect', 'собери|собрать|соберём|collect'],
  ['publish', 'опубликуй|опубликовать|выложи|выложить|publish'],
  ['test', 'протестируй|протестировать|test'],
  ['translate', 'переведи|перевести|translate'],
  ['review', 'согласуй|согласовать|review'],
];
const verbMap = new Map(actions.flatMap(([canonical, words]) => words.split('|').map(word => [word, canonical])));
const lead = /^(?:(?:пожалуйста|слышь|слушай|давай(?:те)?(?: ещё)?|ещё|еще|и ещё|и еще|надо|нужно|необходимо|нам (?:надо|нужно)|please|we (?:need|have) to|we should|let['’]s|can you please)[,\s]+)+/iu;
const direct = /^(?:\/task(?=\s|[:.!]|$)|(?:add|create)\s+(?:(?:a|the)\s+)?task(?=\s|[:.!]|$)|(?:добавь(?:те)?|создай(?:те)?)\s+(?:мне\s+)?(?:задач[уа]|карточку)(?=\s|[:.!]|$))(?:\s+(?:на доску|в канбан|to (?:the )?board))?\s*[:—–-]?\s*/iu;
const step = /^(?:следующий шаг|следующая задача|next step|next task|задача|todo|to-do)\s*[:—–-]\s*/iu;
const desired = /^(?:я хочу,? чтобы|хочу,? чтобы|нам нужен|нам нужна|i want (?:you to|to)|we need to)\s+/iu;
const vague = /^(?:это|так|потом|ещ[её] раз|вс[её]|дальше|it|that|this|again|it again)(?:[.!])?$/iu;
const conjunction = new RegExp('(?:,?\\s+(?:и|and)\\s+)(?=(?:' + [...verbMap.keys()].join('|') + ')\\s+)', 'iu');
const checklist = /^[-*]\s*\[ \]\s+/u;

function tidy(s) {
  return s.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(/[.!]+$/u, '').trim();
}

export function taskKey(title) {
  const line = tidy(title).toLowerCase().replace(/ё/gu, 'е').replace(lead, '').replace(direct, '').replace(step, '').replace(/[«»“”"]/gu, '');
  const words = line.split(/\s+/u);
  words[0] = verbMap.get(words[0]) ?? words[0];
  return words.join(' ');
}

export function extractTasks(text, role) {
  if (!['user', 'assistant'].includes(role) || !text || /^\s*(?:<|# AGENTS\.md|Продолжи работу по карточке №)/iu.test(text)) return [];
  const out = [];
  const plain = text.replace(/^\s*(?:\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\s*(?:\x60{3,}|~{3,})[^\n]*|$)/gmu, '')
    .replace(/^\s*#{1,6}\s+(?=(?:следующие шаги|next steps)\s*[:—]?\s*$)/gimu, '')
    .replace(/^\s*(?:>|#|<|[-*]\s*\[[xX]\]).*$/gmu, '');
  let nextSteps = false;
  for (const line of plain.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^(?:\*\*)?(?:следующие шаги|next steps)(?:\*\*)?\s*[:—]?\s*(?:\*\*)?$/iu.test(trimmed)) {
      nextSteps = true;
      continue;
    }
    const listItem = /^[-*•]\s+|^\d+[.)]\s+/u.test(trimmed);
    if (trimmed && !listItem) nextSteps = false;
    const marked = checklist.test(trimmed) || nextSteps && listItem;
    const clean = trimmed.replace(checklist, '').replace(/^[-*•]\s+|^\d+[.)]\s+/u, '')
      .replace(/^\*\*([^*]+)\*\*/u, '$1');
    for (const sentence of clean.split(/(?<=[.!?])\s+(?=[\p{L}])|;\s*/u)) {
      if (!sentence || sentence.endsWith('?')) continue;
      const directCommand = role === 'user' && direct.test(sentence.replace(lead, ''));
      const parts = role === 'user' && !directCommand ? sentence.split(conjunction) : [sentence];
      for (const fragment of parts) {
        let title = fragment.replace(lead, '');
        const explicit = role === 'user' && direct.test(title);
        const labelled = step.test(title);
        if (explicit) title = title.replace(direct, '');
        else if (labelled) title = title.replace(step, '');
        else if (role === 'user' && desired.test(title)) title = title.replace(desired, '');
        else if (!marked && (role === 'assistant' || !verbMap.has(title.split(/\s+/u)[0].toLowerCase()))) continue;
        title = tidy(title);
        if (explicit) title = title.replace(/^(?:«(.+)»|“(.+)”|"(.+)")$/u, (_, a, b, c) => a ?? b ?? c);
        if (!title || title.length > 200 || title.length < 3 || !/\p{L}/u.test(title)
          || /^(?:не |don't |do not |«|“|\x60|например(?:\s|,))/iu.test(title)) continue;
        if (!explicit && !labelled && !marked && title.split(' ').length < 2) continue;
        if (!explicit && (vague.test(title) || vague.test(title.split(/\s+/u).slice(1).join(' ')))) continue;
        out.push({ title: title[0].toLocaleUpperCase() + title.slice(1), mode: explicit ? 'add' : 'suggest' });
      }
    }
  }
  return out;
}

// Suppress a request when the same turn explicitly reports that very action complete.
const pastActions = new Map([
  ['проверил', 'check'], ['проверила', 'check'], ['checked','check'], ['verified','check'],
  ['добавил','add'], ['добавила','add'], ['added','add'], ['исправил','fix'], ['исправила','fix'], ['fixed','fix'],
  ['подготовил','prepare'], ['подготовила','prepare'], ['prepared','prepare'], ['обновил','update'], ['обновила','update'], ['updated','update'],
  ['создал','create'], ['создала','create'], ['created','create'], ['опубликовал','publish'], ['опубликовала','publish'], ['published','publish'],
]);
export function completedKeys(text) {
  const keys = new Set();
  for (const sentence of (text ?? '').split(/[.!?]\s+|\n/u)) {
    const words = tidy(sentence).toLowerCase().replace(/^(?:я|i)\s+/u, '').split(' ');
    const verb = pastActions.get(words[0]);
    if (verb && words.length > 1) keys.add(taskKey([verb, ...words.slice(1)].join(' ')));
  }
  return keys;
}

function matchingCard(board, projectId, key) {
  return board.cards.find(card => card.projectId === projectId && taskKey(card.title) === key);
}

function linkOrigins(board, card, origins) {
  if (!card || card.deletedAt) return;
  const ids = cardChats(card);
  const known = new Set(ids);
  const primary = board.chats.find(c => c.id === card.chatId);
  const projects = new Set([card.projectId, ...(primary?.previousProjectIds ?? [])]);
  for (const { provider, session } of origins) {
    if (provider !== 'codex' || known.has(session)) continue;
    const chat = board.chats.find(c => c.id === session);
    if (chat && !chat.deletedAt && [chat.projectId, ...(chat.previousProjectIds ?? [])].some(id => projects.has(id))) known.add(session);
  }
  if (known.size !== ids.length) setCardChats(board, card, [...known], origins.filter(s => s.provider === 'codex').map(s => s.session));
}

export function settle(board, proposal, action, status = 'planned') {
  if (proposal.state !== 'pending') return proposal;
  const source = visibleSource(proposal, trashedChatIds(board));
  if (!source) return proposal;
  const match = matchingCard(board, proposal.projectId, proposal.key);
  if (match || action === 'add') {
    const chat = source.provider === 'codex'
      ? board.chats.find(chat => chat.id === source.session && (chat.projectId === proposal.projectId || source !== proposal.source)) : null;
    const card = match ?? newCard(board, proposal.projectId, proposal.title, chat);
    if (!match) {
      card.source = { ...source };
      card.status = status;
      card.next = proposal.next ?? '';
      card.description = source === proposal.source ? proposal.description ?? '' : '';
      if (proposal.snoozedUntil) card.snoozedUntil = proposal.snoozedUntil;
    }
    linkOrigins(board, card, [proposal.source, ...(proposal.otherSessions ?? [])]);
    proposal.state = 'added';
    proposal.cardId = card.id;
  } else proposal.state = 'dismissed';
  return proposal;
}

export function alreadyCaptured(board, projectId, title) {
  const key = taskKey(title);
  const p = board.proposals?.find(p => p.projectId === projectId && p.state === 'added'
    && (p.key === key || board.cards.some(c => c.id === p.cardId && taskKey(c.title) === key)));
  return p && board.cards.find(card => card.id === p.cardId && !card.deletedAt);
}

export function reconcile(board, card) {
  for (const p of board.proposals ?? []) {
    if (p.state === 'pending' && p.projectId === card.projectId && p.key === taskKey(card.title)) settle(board, p, 'add');
  }
}

export function ingest(board, { projectId, source, title, next, description, mode }) {
  const key = taskKey(title);
  const eventKey = id => createHash('sha256').update(JSON.stringify([id, source.provider, source.session, source.event])).digest('hex');
  const identity = eventKey(projectId);
  const chat = source.provider === 'codex' && board.chats.find(c => c.id === source.session && c.projectId === projectId);
  const previousKeys = (chat?.previousProjectIds ?? []).map(eventKey);
  const records = board.proposals ??= [];
  const replay = records.find(p => p.events.includes(identity) || previousKeys.some(key => p.events.includes(key)));
  let p = replay ?? records.find(p => p.projectId === projectId && p.key === key);
  if (!p && chat) p = records.find(p => p.key === key && [p.source, ...(p.otherSessions ?? [])].some(s => s.provider === 'codex' && s.session === chat.id));
  if (!p) {
    p = { id: randomUUID(), projectId, title, key, source, events: [], state: 'pending' };
    records.push(p);
  }
  if (description && !p.description && p.state === 'pending'
    && p.source.provider === source.provider && p.source.session === source.session) p.description = description;
  if (next && p.state === 'pending' && !p.next) p.next = next;
  if (replay) {
    // An explicit instruction can confirm the same candidate a connector previously proposed.
    if (mode === 'add' && replay.state === 'pending') settle(board, replay, 'add');
    return replay;
  }
  if (p.source.provider !== source.provider || p.source.session !== source.session) {
    const origins = p.otherSessions ??= [];
    if (!origins.some(o => o.provider === source.provider && o.session === source.session)) {
      origins.push({ provider: source.provider, session: source.session });
      if (p.state === 'added') linkOrigins(board, board.cards.find(c => c.id === p.cardId), [source]);
    }
  }
  p.events.push(identity);
  if (p.state === 'pending' && (mode === 'add' || matchingCard(board, projectId, key))) settle(board, p, 'add');
  // Only a fresh direct request can override a past dismissal.
  else if (p.state === 'dismissed' && mode === 'add') {
    if (next) p.next = next;
    p.state = 'pending';
    settle(board, p, 'add');
  }
  return p;
}

export function receipt(board, p) {
  const card = p.cardId && board.cards.find(c => c.id === p.cardId);
  return { id: p.id, title: p.title, decision: p.state,
    ...(p.state === 'pending' && p.description ? { description: p.description } : {}),
    ...(p.state === 'pending' && p.next ? { next: p.next } : {}),
    ...(p.state === 'pending' && p.snoozedUntil ? { snoozedUntil: p.snoozedUntil } : {}),
    ...(card ? { card: cardSummary(card) } : {}) };
}

function cardSummary(card) {
  return { number: card.number, title: card.title, status: card.status, next: card.next,
    description: card.description ?? '', block: card.block ?? '', snoozedUntil: card.snoozedUntil ?? '', tags: card.tags ?? [],
    customValue: card.customValue ?? '', deleted: Boolean(card.deletedAt) };
}

export function projectContext(board, projectId, session, provider) {
  const trashed = trashedChatIds(board);
  const relevant = source => !session || source?.session === session && source?.provider === provider;
  const relevantProposal = p => relevant(p.source) || (p.otherSessions ?? []).some(relevant);
  const localChat = provider === 'codex' && board.chats.some(c => c.id === session && c.projectId === projectId);
  const proposals = (board.proposals ?? []).filter(p => (p.state !== 'pending' || visibleSource(p, trashed))
    && (p.projectId === projectId || (localChat && relevantProposal(p))));
  const relatedCards = new Set(proposals.filter(relevantProposal).map(p => p.cardId));
  const project = board.projects.find(p => p.id === projectId);
  return { revision: board.revision, projectId, projectName: project?.name,
    projectSnoozedUntil: project?.snoozedUntil ?? '', customFieldName: project?.customFieldName || 'Дополнительное поле',
    questions: (board.answerRequests ?? []).filter(q => q.projectId === projectId && !q.resolved && relevant(q) && (q.provider !== 'codex' || !trashed.has(q.session))),
    cards: board.cards.filter(c => (c.projectId === projectId && (relevant(c.source) || relatedCards.has(c.id) || (provider === 'codex' && cardChats(c).includes(session))))
      || (localChat && (relatedCards.has(c.id) || cardChats(c).includes(session)))).map(cardSummary),
    proposals: proposals.filter(relevantProposal).map(p => receipt(board, p)),
    chatOffers: board.chats.filter(chat => !chat.deletedAt && chat.projectId === projectId && chat.cardOffer
      && (!session || provider === 'codex' && session === chat.id))
      .map(chat => ({ id: chat.cardOffer.id, session: chat.id, title: chat.title, decision: chat.cardOffer.state, snoozedUntil: chat.cardOffer.snoozedUntil })) };
}
