const generic = /^(?:(?:new|untitled|unnamed|my)\s+project|project|untitled|новый\s+проект|мой\s+проект|проект(?:\s+без\s+названия)?|без\s+названия)(?:[\s_#№().-]*\d+[)]?)?$/iu;
const filler = new Set('для про как или еще ещё новый новые какой можно нужно чтобы туда работа работы суть что этот этого сделать сайта сайт проект проекта задачи задача разработать сделать исправить добавить обсудить найти изучить проверить сравнить настроить создать with from this that project create update review add fix test the for and'.split(' '));
const subject = title => title.trim().replace(/^(?:изучить|обсудить|найти|проверить|настроить|создать|добавить|разработать|исправить|сравнить|оценить|review|create|update|fix|discuss)\s+/iu, '');
export function suggestProjectName(chats) {
  const originals = [...new Set(chats.map(chat => (chat.title ?? '').trim()).filter(title => title && !/^(?:чат без названия|untitled chat|new chat)$/iu.test(title)))];
  const titles = [...new Set(originals.map(subject).filter(Boolean))];
  if (titles.length === 1) {
    const phrase = originals.length === 1 ? originals[0] : titles[0];
    return phrase.length <= 80 && !generic.test(phrase) ? phrase[0].toUpperCase() + phrase.slice(1) : '';
  }
  const phrases = new Map();
  for (const title of titles) {
    const words = title.match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? [];
    const seen = new Set();
    for (let i = 0; i < words.length; i++) for (let length = 1; length <= 3 && i + length <= words.length; length++) {
      const span = words.slice(i, i + length);
      if (span.some(word => filler.has(word.toLowerCase())) || !span.some(word => word.length >= 3)) continue;
      const text = span.join(' '), key = text.toLowerCase();
      if (!seen.has(key)) {
        const match = phrases.get(key) ?? { name: text, count: 0 };
        match.count++;
        phrases.set(key, match);
        seen.add(key);
      }
    }
  }
  const best = [...phrases.values()].filter(p => p.count >= Math.max(2, Math.ceil(titles.length * 0.66)) && p.name.length <= 80)
    .sort((a, b) => b.count - a.count || b.name.length - a.name.length)[0];
  return best ? best.name[0].toUpperCase() + best.name.slice(1) : '';
}

export function reviewNames(board) {
  for (const p of board.projects) {
    if (generic.test(p.name.trim()) && !p.nameReview) p.nameReview = 'pending';
  }
}

export function renameProject(board, project, name, at, basisIds) {
  if (project.name === name) { project.nameReview = 'kept'; return; }
  const chats = board.chats.filter(c => !c.deletedAt && c.projectId === project.id && (!basisIds || basisIds.has(c.id))).map(({ id, title }) => ({ id, title }));
  project.originalName ??= project.name;
  (project.renames ??= []).push({ from: project.name, to: name, at, chats });
  project.name = name;
  project.nameReview = 'renamed';
}
