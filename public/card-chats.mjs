export function cardChats(card) {
  return card ? [card.chatId, ...(card.otherChatIds ?? [])].filter(Boolean) : [];
}

export function seenIn(card, chatId) {
  return chatId === card.chatId ? card.seen : card.otherSeen?.[chatId];
}
