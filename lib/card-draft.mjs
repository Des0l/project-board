import { cardChats } from '../public/card-chats.mjs';
import { chatDescription, messageText, rankedExcerpt, sourceDescription } from './description.mjs';
import { visitChatTurns } from './history-review.mjs';
import { extractTasks } from './tasks.mjs';

function turnExcerpt(card, turn, chatId) {
  const source = card.source?.provider === 'codex' && card.source.session === chatId ? card.source : null;
  const anchored = source?.event?.startsWith('["');
  if (anchored && !source.event.startsWith('[' + JSON.stringify(turn.id) + ',')) return null;
  const items = turn.items.map(item => ({ item, text: messageText(item) })).filter(entry => entry.text);
  const originTime = Date.parse(card.createdAt ?? card.statusSince) / 1000;
  const distance = Math.abs(originTime - (turn.completedAt ?? turn.startedAt));
  const proximity = distance < 3600 ? 5 : distance < 86400 ? 2 : 0;
  const mentionsCard = new RegExp('(?:#|№)\\s*' + card.number + '(?!\\d)', 'u');
  const identified = card.number != null && items.some(entry => mentionsCard.test(entry.text));
  let best = null;
  for (const { item, text } of items) {
    let { description, score } = rankedExcerpt(text, card.title, card.next);
    if (anchored && source.event.startsWith(JSON.stringify([turn.id, item.id]) + '/')) {
      const siblings = extractTasks(text, item.type === 'userMessage' ? 'user' : 'assistant').map(t => t.title);
      const exact = sourceDescription(text, card.title, siblings);
      if (exact) { description = exact; score += 100; }
    }
    if (!description) continue;
    score += proximity + (identified ? 8 : 0);
    if (!best || score > best.score) best = { score, description, chatId, turnId: turn.id, itemId: item.id };
  }
  return best;
}

// Several cards can refer to the same conversation. Read each history once per request.
export async function readCardDrafts(client, cards, chats) {
  const linked = new Map();
  for (const card of cards) {
    for (const id of new Set(cardChats(card))) {
      if (!linked.has(id)) linked.set(id, []);
      linked.get(id).push(card);
    }
  }
  const best = new Map(), errors = new Map();
  for (const chat of chats.filter(chat => linked.has(chat.id) && !chat.deletedAt)) {
    const fromChat = new Map();
    try {
      await visitChatTurns(client, chat, turn => {
        for (const card of linked.get(chat.id)) {
          const candidate = turnExcerpt(card, turn, chat.id);
          if (candidate && candidate.score > (fromChat.get(card)?.score ?? 0)) fromChat.set(card, candidate);
        }
      }, () => fromChat.clear());
      // Older one-card-per-chat imports use the chat title. The initial request can
      // survive in thread metadata even when earlier messages are missing from history.
      const imported = linked.get(chat.id).filter(card => !fromChat.has(card) && !card.source && card.title === chat.title);
      if (imported.length) {
        let description = chat.offerDescription;
        if (!description) {
          try {
            const { thread } = await client.request('thread/read', { threadId: chat.id, includeTurns: false });
            if (thread?.id === chat.id) description = chatDescription(thread.preview, chat.title);
          } catch (error) { for (const card of imported) errors.set(card, error); }
        }
        if (description) for (const card of imported) fromChat.set(card, { description, score: 1, chatId: chat.id });
      }
      for (const [card, candidate] of fromChat) {
        if (candidate.score > (best.get(card)?.score ?? 0)) best.set(card, candidate);
      }
    } catch (error) {
      for (const card of linked.get(chat.id)) errors.set(card, error);
    }
  }
  return new Map(cards.map(card => {
    if (!best.has(card)) return [card, errors.has(card) ? { error: errors.get(card) } : { description: '' }];
    const { score, ...draft } = best.get(card);
    return [card, draft];
  }));
}

export async function readCardDraft(client, card, chats) {
  const results = await readCardDrafts(client, [card], chats);
  const draft = results.get(card);
  if (draft.error) throw draft.error;
  return draft;
}
