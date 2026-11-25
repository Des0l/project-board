import { createHash, randomUUID } from 'node:crypto';
import { cardChats } from '../public/card-chats.mjs';
import { readCardDrafts } from './card-draft.mjs';

function basis(board, card) {
  const links = cardChats(card).filter(id => board.chats.some(chat => chat.id === id && !chat.deletedAt)).sort();
  return createHash('sha256').update(JSON.stringify([card.projectId, card.title, card.next, links, card.source])).digest('hex');
}

function eligible(board, card) {
  return !card.deletedAt && !card.description?.trim() && board.projects.some(p => p.id === card.projectId && !p.deletedAt);
}

export function storedProposalDraft(board, card) {
  const p = board.proposals?.find(p => p.cardId === card.id && p.description && (p.source.provider !== 'codex'
    || cardChats(card).includes(p.source.session) && board.chats.some(c => c.id === p.source.session && !c.deletedAt)));
  return p && { description: p.description, provider: p.source.provider, chatId: p.source.provider === 'codex' ? p.source.session : null };
}

export function queueDraft(board, card) {
  const draft = board.descriptionDrafts?.[card.id];
  return draft && eligible(board, card) && draft.basis === basis(board, card) ? draft : null;
}

export function reviewQueue(board) {
  return Object.fromEntries(board.cards.flatMap(card => {
    const draft = queueDraft(board, card);
    if (!draft || draft.state === 'skipped') return [];
    const { basis, ...entry } = draft;
    return [[card.id, entry]];
  }));
}

export async function prepareDraftQueue(store, withReader) {
  const board = store.read();
  const entries = [], pending = [], results = new Map();
  for (const card of board.cards) {
    if (!eligible(board, card)) continue;
    const old = queueDraft(board, card);
    if (old && ['ready', 'skipped'].includes(old.state)) continue;
    entries.push({ card, basis: basis(board, card), version: board.descriptionDrafts?.[card.id]?.version });
    const stored = storedProposalDraft(board, card);
    if (stored) results.set(card, stored);
    else if (cardChats(card).some(id => board.chats.some(c => c.id === id && !c.deletedAt))) pending.push(card);
  }
  if (pending.length) {
    try {
      const found = await withReader(client => readCardDrafts(client, pending, board.chats));
      for (const [card, draft] of found) results.set(card, draft);
    } catch {
      for (const card of pending) results.set(card, { error: true });
    }
  }
  if (!entries.length) return;
  store.change(current => {
    const drafts = current.descriptionDrafts ??= {};
    for (const entry of entries) {
      const card = current.cards.find(c => c.id === entry.card.id);
      if (!card || !eligible(current, card) || basis(current, card) !== entry.basis || drafts[card.id]?.version !== entry.version) continue;
      const { error, ...draft } = results.get(entry.card) ?? {};
      drafts[card.id] = { ...draft, description: draft.description ?? '', basis: entry.basis, version: randomUUID(),
        state: draft.description ? 'ready' : error ? 'unavailable' : 'missing' };
    }
  });
}
