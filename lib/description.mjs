// Select short excerpts from visible messages. Keep every excerpt in its original wording.
const stop = /^(?:project|board|task|card|check|verify|add|create|update|should|would|this|that|with|from|when|have|will|also|after|the|and|for|you|your|проек|задач|карто|прове|уточн|добав|сдела|доске|доска|чтобы|после|этого|можно|нужно|должн|котор|своей|только|если|или|как|при|его|для|что|это)$/u;
function terms(text) {
  const words = text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\d]{3,}/gu) ?? [];
  return new Set(words.map(word => /^[а-я]+$/u.test(word)
    ? word.replace(/(?:ами|ями|ого|ему|ов|ам|ах|ом|ем|ой|ы|и|а|у|е|я)$/u, '').slice(0, 5)
    : word.replace(/(?:ing|s)$/u, '')).filter(word => word.length >= 2 && !stop.test(word)));
}
const overlap = (a, b) => [...a].filter(word => b.has(word)).length;
const normalize = text => text.toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
const privateText = /(?:https?:\/\/|[a-z]:[\\/]|(?:^|\s)\/(?:home|Users|mnt)\/|[\w.+-]+@[\w.-]+\.\w+|(?:bearer\s+\S|(?:token|secret|password|пароль|токен|api.?key)\s*[:=])|[a-z\d_/-]{40,})/iu;
const itemStart = /^(?:[-*•]|\d+[.)])\s+/u;

export function messageText(item) {
  if (item.type === 'userMessage') return (item.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')) return item.text ?? '';
  return '';
}

function sentences(text) {
  if (!text || /^\s*(?:<|# AGENTS\.md|Продолжи работу по карточке №)/iu.test(text)) return [];
  const clean = text.split(/# My request:\s*/u).at(-1)
    .replace(/(?:\x60{3}|~~~)[\s\S]*?(?:\x60{3}|~~~|$)/gu, '')
    .replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, '$1').replace(/\*\*|__|\x60/gu, '');
  const result = [];
  let group = 0;
  for (let line of clean.split(/\r?\n/u)) {
    line = line.trim();
    const bullet = itemStart.test(line);
    if (!line || bullet) group++;
    if (!line || /^(?:#|<|>|!\[)/u.test(line)) continue;
    line = line.replace(itemStart, '').replace(/^\[ \]\s*/u, '');
    for (const sentence of line.split(/(?<=[.!?])\s+|;\s*/u)) {
      if (sentence.length < 9 || sentence.length > 550 || privateText.test(sentence) || /(?:#|№)\s*\d+/u.test(sentence)) { group++; continue; }
      result.push({ sentence, group, bullet, words: terms(sentence) });
    }
  }
  return result;
}

export function chatDescription(preview, title) {
  const excerpt = sourceDescription(preview ?? '', title);
  if (excerpt) return excerpt;
  const first = sentences(preview ?? '')[0]?.sentence;
  return first && normalize(first) !== normalize(title) ? first : '';
}

// A short request may get its useful details in the other participant's reply.
export function supplementDescriptions(tasks, messages) {
  for (const task of tasks) {
    if (task.description) continue;
    let best;
    const others = tasks.filter(t => t.title !== task.title).map(t => normalize(t.title));
    for (const text of messages) {
      const excerpt = rankedExcerpt(text, task.title, '', others);
      if (excerpt.score > (best?.score ?? 0)) best = excerpt;
    }
    if (best) task.description = best.description;
  }
  return tasks;
}

// Use following details for a known source only until the next task or list item.
export function sourceDescription(text, title, siblings = []) {
  const lines = sentences(text);
  const key = normalize(title);
  const anchor = lines.findIndex(l => normalize(l.sentence).includes(key));
  const others = siblings.filter(other => other !== title).map(normalize);
  if (anchor < 0) return rankedExcerpt(text, title, '', others).description;
  if (others.some(other => normalize(lines[anchor].sentence).includes(other))) return '';
  const taken = [];
  for (const line of lines.slice(anchor + 1, anchor + 4)) {
    if (line.group !== lines[anchor].group || others.some(other => normalize(line.sentence).includes(other))) break;
    taken.push(line.sentence);
  }
  if (taken.length) return taken.join(' ');
  return rankedExcerpt(text, title, '', others).description;
}

export function rankedExcerpt(text, title, next = '', exclude = []) {
  const subject = terms(title), hints = terms(next), key = normalize(title);
  const lines = sentences(text);
  const ranked = lines.map((line, index) => {
    const normalized = normalize(line.sentence);
    const matches = overlap(subject, line.words), details = overlap(hints, line.words);
    // Ignore the title echoed back in a command, and boilerplate about the board.
    const repeated = normalized.endsWith(key) || exclude.some(other => normalized.includes(other));
    const score = !repeated && (matches >= 2 || matches && details >= 1 || details >= 2)
      ? matches * 2 + details * 3 + (line.bullet ? 3 : 0) : 0;
    return { ...line, index, score };
  }).filter(l => l.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = [];
  const groups = new Set();
  for (const line of ranked) {
    if (groups.has(line.group)) continue;
    groups.add(line.group);
    picked.push(line);
    if (line.bullet) {
      for (let n = line.index + 1; n < Math.min(line.index + 3, lines.length); n++) {
        const detail = lines[n];
        if (detail.group !== line.group || !detail.bullet || detail.sentence.length > 180
          || exclude.some(other => normalize(detail.sentence).includes(other))) break;
        if (overlap(hints, detail.words) || overlap(subject, detail.words)) picked.push({ ...detail, index: n });
      }
    }
    if (groups.size >= 2) break;
  }
  const description = picked.sort((a, b) => a.index - b.index).map(l => l.sentence).join(' ');
  return { description, score: ranked[0]?.score ?? 0 };
}
