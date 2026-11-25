import '/vendor/number-flow.js';
import { cardChats, seenIn } from './card-chats.mjs';

const byId = id => document.getElementById(id);
const modal = byId('modal');
const content = byId('content');
const viewNames = { board: 'Общая доска', inbox: 'Неразобранные задачи', focus: 'Фокус дня', dates: 'Сроки', chats: 'Чаты', snoozed: 'Отложенные', trash: 'Корзина' };
function currentView() {
  const view = location.hash.slice(1);
  return Object.hasOwn(viewNames, view) ? view : 'board';
}
const filters = { view: currentView(), topic: '', tag: '', attention: false, search: '' };
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });
const historyDateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const returnDateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' });
const proposalPlural = new Intl.PluralRules('ru-RU');
const proposalForms = { one: 'предложение', few: 'предложения', many: 'предложений' };
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
let state;
let dragged;
let toastTimer;
let dialogCard;
let checking = false;
let openCheckStarted = false;
let awaySince = null;
let checkedInTab = 0;
const resumeDelay = 30 * 60_000;
let checkProblem = '';
const offerColumns = new Map();
let renderMinute = -1;
let lastBoardMarkup;
let lastInboxMarkup;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
const fullDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' });
const dayMs = 86_400_000;

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function icon(name) {
  return '<svg class="icon-line" aria-hidden="true"><use href="/vendor/lucide.svg#' + name + '"></use></svg>';
}

function selected(condition) {
  return condition ? ' selected' : '';
}

function findChat(id) {
  return state.chats.find(chat => chat.id === id);
}

function projectFor(id) {
  return state.projects.find(project => project.id === id);
}

function hasNewReply(card) {
  return cardChats(card).some(id => {
    const reply = findChat(id)?.reply;
    return reply && reply.id !== seenIn(card, id);
  });
}

function ageInfo(card) {
  if (!card.statusSince) return null;
  const elapsed = Math.max(0, Date.now() - Date.parse(card.statusSince));
  if (!Number.isFinite(elapsed)) return null;
  const days = Math.floor(elapsed / dayMs);
  const hours = Math.floor(elapsed / 3_600_000);
  const minutes = Math.floor(elapsed / 60_000);
  const duration = days ? days + ' дн.' : hours ? hours + ' ч' : minutes ? minutes + ' мин' : '< 1 мин';
  const monitored = card.status === 'active' || card.status === 'review';
  const level = monitored && days >= 7 ? 'late' : monitored && days >= 3 ? 'warn' : '';
  const since = fullDate.format(new Date(card.statusSince));
  const title = (card.statusObserved ? 'Точная дата перехода неизвестна. Доска отсчитывает только время наблюдения с ' : 'Время после перехода в эту колонку. Начало — ') + since + ' (МСК).'
    + (monitored ? ' После 3 дней отметка оранжевая, после 7 — красная.' : '');
  return { duration, level, title };
}

function ageLabel(card) {
  const age = ageInfo(card);
  if (!age) return '';
  const prefix = age.level ? 'Без движения ' : card.statusObserved ? 'Наблюдаем ' : 'В колонке ';
  return '<span tabindex="0" class="age ' + age.level + '" title="' + html(age.title) + '">'
    + (age.level ? '<i aria-hidden="true"></i>' : icon('clock-3')) + prefix
    + (card.statusObserved && age.duration !== '< 1 мин' ? '≥ ' : '') + html(age.duration) + '</span>';
}

function daysUntilDue(card, today) {
  if (!card.dueOn || card.status === 'done') return Infinity;
  return (Date.parse(card.dueOn) - Date.parse(today)) / dayMs;
}

function needsAttention(card, today) {
  return Boolean(card.block || card.status === 'review' || hasNewReply(card) || ageInfo(card)?.level
    || daysUntilDue(card, today) <= 7);
}

const projectFilterKey = 'project-board.project-filter.v1';
let projectChoices = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(projectFilterKey) ?? '[]');
  if (Array.isArray(saved)) projectChoices = new Map(saved.filter(entry =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'));
} catch { /* The filter also works when browser storage is unavailable. */ }

function projectVisible(id) {
  const project = projectFor(id);
  return Boolean(project && (projectChoices.get(id) ?? !project.hidden));
}

function saveProjectChoices() {
  try { localStorage.setItem(projectFilterKey, JSON.stringify([...projectChoices])); } catch { /* In-memory selection stays active. */ }
}

function activeProjects() {
  return state.projects.filter(project => projectVisible(project.id));
}

function setProjectFilter(ids, enabled) {
  for (const id of ids) projectChoices.set(id, enabled);
  filters.topic = '';
  saveProjectChoices();
  render();
}

function projectMark(id) {
  return '<svg class="project-mark" viewBox="0 0 16 16" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="7" fill="' + html(projectFor(id)?.color || '#737d78') + '" stroke="#26372d" stroke-opacity=".35"/></svg>';
}

function drawProjectFilters(projects, active) {
  const checkboxList = byId('project-options-list');
  const options = projects.map(p => '<label class="project-option"><input type="checkbox" value="' + html(p.id) + '">'
    + projectMark(p.id) + '<span>' + html(p.name) + '</span></label>').join('');
  if (checkboxList.dataset.markup !== options) {
    const focused = checkboxList.contains(document.activeElement) && document.activeElement.value;
    checkboxList.innerHTML = options;
    checkboxList.dataset.markup = options;
    if (focused) (checkboxList.querySelector('[value="' + CSS.escape(focused) + '"]') ?? byId('all-projects')).focus({ preventScroll: true });
  }
  const visible = new Set(active.map(p => p.id));
  for (const input of checkboxList.querySelectorAll('input')) input.checked = visible.has(input.value);
  const all = byId('all-projects');
  all.checked = active.length > 0 && active.length === projects.length;
  all.indeterminate = active.length > 0 && active.length < projects.length;
  all.disabled = !projects.length;
  byId('project-total').textContent = active.length + ' из ' + projects.length;

  const group = byId('projects');
  const markup = active.map(p => '<span class="project-tag"><button type="button" class="project-open" data-project="' + html(p.id)
    + '" title="Настройки и цвет проекта «' + html(p.name) + '»" aria-label="Настройки проекта «' + html(p.name) + '»">'
    + projectMark(p.id) + '<span class="project-name">' + html(p.name) + '</span></button>'
    + '<button type="button" class="project-hide" data-hide-project="' + html(p.id) + '" title="Скрыть проект «' + html(p.name)
    + '»" aria-label="Скрыть проект «' + html(p.name) + '»">' + icon('x') + '</button></span>').join('');
  if (group.dataset.markup !== markup) {
    group.innerHTML = markup;
    group.dataset.markup = markup;
  }
}

async function api(path, method = 'GET', data) {
  const request = { method };
  if (method !== 'GET') {
    request.headers = { 'Content-Type': 'application/json', 'X-Board-Action': '1' };
    request.body = JSON.stringify(data ?? {});
  }
  const response = await fetch('/api/' + path, request);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Связь с доской прервалась.');
  return body;
}

function accept(next) {
  if (state && state.revision > next.revision) return;
  const changed = !state || JSON.stringify(state) !== JSON.stringify(next);
  state = next;
  if (!dragged && (changed || renderMinute !== Math.floor(Date.now() / 60_000))) render();
}

function notify(message) {
  const node = byId('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

function localDay() {
  return dayFormat.format(new Date());
}

function returnDate(item) {
  const projectDate = projectFor(item.projectId)?.snoozedUntil || '';
  return item.snoozedUntil > projectDate ? item.snoozedUntil : projectDate;
}

function showDate(date) {
  return returnDateFormat.format(new Date(date + 'T00:00:00Z'));
}

function snoozeButton(kind, id, compact = false) {
  return '<button type="button" class="ghost snooze-action" data-snooze="' + html(id) + '" data-kind="' + kind
    + '" title="Отложить до…" aria-label="Отложить до…">' + (compact ? icon('calendar-range') : 'Отложить до…') + '</button>';
}

function dueProjects() {
  return state.projects.filter(project => project.reviewOn && project.reviewOn <= localDay()
    && !(project.snoozedUntil > localDay()) && projectVisible(project.id));
}

function drawNamingOffers() {
  const node = byId('naming-offers');
  const offers = (state.naming ?? []).filter(p => projectVisible(p.projectId));
  node.hidden = !offers.length || !['board', 'chats'].includes(filters.view);
  const markup = offers.map(p => {
    const project = projectFor(p.projectId);
    if (project.canRemove) return '<article class="name-offer"><div><strong>«' + html(project.name)
      + '» пуст</strong></div>' + removeProjectButton(project) + '</article>';
    const chats = state.chats.filter(c => c.projectId === p.projectId);
    const sample = chats.slice(0, 3).map(c => c.title).join(' · ');
    const split = chats.length > 1 && !p.suggestion;
    return '<article class="name-offer"><div><strong>' + (split ? 'Разобрать чаты в «' : 'Переименовать «') + html(projectFor(p.projectId).name) + '»?</strong>'
      + '<p>' + (sample ? html(sample) + (chats.length > 3 ? '…' : '') : 'Пока нет чатов') + '</p></div>'
      + '<button class="ghost" type="button" ' + (split ? 'data-sort-project' : 'data-name-review') + '="' + html(p.projectId) + '">' + (split ? 'Разобрать чаты' : 'Выбрать название') + '</button></article>';
  }).join('');
  if (node.dataset.markup !== markup) { node.innerHTML = markup; node.dataset.markup = markup; }
}

function suggestionRow(p, chat) {
  const source = chat ? '<a href="codex://threads/' + encodeURIComponent(chat.id) + '">' + html(chat.title) + '</a>' : html(p.source.provider);
  return '<article class="suggestion-row"><div><strong>' + html(p.title) + '</strong><small>'
    + (p.kind === 'chat' ? 'Новый чат · ' : '') + source
    + (p.source.history ? ' · Из переписки' + (p.source.at ? ' за ' + historyDateFormat.format(p.source.at * 1000) : '') : '')
    + '</small>' + (p.description ? '<p class="offer-description">' + html(p.description) + '</p>' : '') + (p.next ? '<p class="help">' + html(p.next) + '</p>' : '')
    + '</div><div class="suggestion-actions"><label class="offer-column">Колонка<select data-offer-column="' + html(p.id) + '" aria-label="Колонка для новой карточки">'
    + state.columns.map(column => '<option value="' + column.id + '"' + selected(column.id === (offerColumns.get(p.id) || 'planned')) + '>' + html(column.name) + '</option>').join('')
    + '</select></label><button type="button" class="ghost" data-preview="' + html(p.id) + '">Посмотреть</button>'
    + snoozeButton('proposal', p.id) + '<button type="button" class="ghost" data-dismiss="' + html(p.id)
    + '">Пропустить</button><button type="button" class="primary" data-accept="' + html(p.id) + '">Добавить на доску</button></div></article>';
}

function unassignedRow(chat) {
  const suggestion = chat.recommendation;
  const target = suggestion?.state === 'match' && projectFor(suggestion.projectId);
  let detail = '';
  if (target) detail = '<p><strong>Codex предлагает «' + html(target.name) + '»</strong><br>' + html(suggestion.reason) + '</p>';
  else if (suggestion?.state === 'uncertain') detail = '<p class="help">По названию Codex не смог выбрать один проект.</p>';
  else if (suggestion?.state === 'unavailable') detail = '<p class="help">Подбор Codex недоступен. Можно выбрать проект вручную.</p>';
  else if (suggestion?.state === 'pending') detail = '<p class="help">Рекомендация появится после проверки Codex.</p>';
  return '<article class="suggestion-row"><div><strong>' + html(chat.title) + '</strong><small title="' + html(chat.folder) + '">Из папки проекта «'
    + html(chat.sourceName) + '» · <a href="codex://threads/' + encodeURIComponent(chat.id) + '">Открыть чат</a></small>' + detail + '</div>'
    + '<div class="suggestion-actions"><button type="button" class="ghost" data-skip-unassigned="' + html(chat.id) + '">Пропустить</button>'
    + '<button type="button" class="' + (target ? 'ghost' : 'primary') + '" data-assign-chat="' + html(chat.id) + '">' + (target ? 'Выбрать другой' : 'Выбрать проект') + '</button>'
    + (target ? '<button type="button" class="primary" data-confirm-chat="' + html(chat.id) + '" data-destination="' + html(target.id) + '">Перенести в «' + html(target.name) + '»</button>' : '')
    + '</div></article>';
}

function drawInbox(search, proposals, readyDrafts) {
  const groups = new Map();
  const waiting = (state.unassignedChats ?? []).filter(chat => !chat.deletedAt);
  const matches = waiting.filter(chat => [chat.title, chat.sourceName, chat.folder].join(' ').toLocaleLowerCase('ru').includes(search));
  let hidden = 0;
  for (const p of proposals) {
    if (!projectVisible(p.projectId)) { hidden++; continue; }
    const chat = p.source.provider === 'codex' && findChat(p.source.session);
    const project = projectFor(p.projectId);
    if (![p.title, project.name, chat?.title, p.source.provider].join(' ').toLocaleLowerCase('ru').includes(search)) continue;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(suggestionRow(p, chat));
  }
  byId('inbox-help').hidden = groups.size === 0;
  let markup = hidden ? '<div class="inbox-scope"><span>Фильтр проектов скрывает ' + hidden + ' ' + proposalForms[proposalPlural.select(hidden)] + '</span>'
    + '<button type="button" class="ghost" data-show-projects>Показать все проекты</button></div>' : '';
  if (readyDrafts) {
    markup = '<section class="inbox-group review-inbox"><div><h2>Черновики описаний <span>' + readyDrafts + '</span></h2>'
      + '<p class="help">Описания для существующих карточек из всех проектов.</p></div>'
      + '<button type="button" class="primary" data-review-drafts>Проверить черновики</button></section>' + markup;
  }
  if (matches.length) {
    markup += '<section class="inbox-group"><h2>Чаты без проекта <span>' + matches.length + '</span></h2>'
      + (state.sync.aiRouting ? '<p class="help">Codex сравнивает названия чатов с проектами, их темами и примерами чатов. Перенос подтверждаешь ты.</p>' : '')
      + matches.map(unassignedRow).join('') + '</section>';
  }
  for (const [project, rows] of groups) {
    markup += '<section class="inbox-group"><h2>' + projectMark(project.id) + html(project.name)
      + '<span>' + rows.length + '</span></h2>' + rows.join('') + '</section>';
  }
  if (!groups.size && !matches.length) {
    const title = !proposals.length && !waiting.length ? 'Всё разобрано на сегодня' : search ? 'По этому запросу ничего не найдено' : 'В выбранных проектах всё разобрано';
    const sleeping = state.proposals.some(p => projectVisible(p.projectId) && returnDate(p) > localDay());
    if (!readyDrafts || search) {
      markup += '<div class="agenda-empty">' + icon('list-checks') + '<h2>' + (readyDrafts ? 'Поиск по новым задачам: ничего не найдено' : title) + '</h2>'
        + (sleeping ? '<a href="#snoozed">Посмотреть отложенные</a>' : '') + '</div>';
    } else if (sleeping) markup += '<a href="#snoozed">Посмотреть отложенные</a>';
  }
  if (lastInboxMarkup !== markup || !content.classList.contains('inbox-list')) content.innerHTML = markup;
  lastInboxMarkup = markup;
  content.classList.add('inbox-list');
}

function drawSnoozed(cards, proposals, today, search) {
  const groups = [];
  for (const project of activeProjects()) {
    const paused = project.snoozedUntil > today;
    const items = [...cards, ...proposals].filter(item => item.projectId === project.id && returnDate(item) > today);
    const matches = items.filter(item => (project.name + ' ' + item.title).toLocaleLowerCase('ru').includes(search));
    if (!matches.length && (!paused || !project.name.toLocaleLowerCase('ru').includes(search))) continue;
    const rows = matches.map(item => {
      const kind = item.kind ? 'proposal' : 'card';
      const attr = item.kind ? 'data-preview' : 'data-open';
      const own = item.snoozedUntil > today;
      return '<article class="agenda-row"><div class="agenda-task"><button type="button" class="card-title" ' + attr + '="' + html(item.id) + '">'
        + html(item.title) + '</button><small>' + (item.kind ? 'Предложение' : 'Карточка') + ' · До ' + html(showDate(returnDate(item))) + '</small></div>'
        + (!paused && own ? wakeButton(kind, item.id) : '') + '</article>';
    }).join('');
    groups.push('<section class="agenda-group"><h2>' + html(project.name) + '</h2>' + (paused ? '<div class="pause-project"><span>Весь проект до '
      + html(showDate(project.snoozedUntil)) + '</span>' + wakeButton('project', project.id) + '</div>' : '') + rows + '</section>');
  }
  content.innerHTML = groups.join('') || '<p class="empty-page">' + (search ? 'Нет совпадений.' : 'Отложенных задач и проектов пока нет.') + '</p>';
}

function wakeButton(kind, id) {
  return '<button class="ghost" type="button" data-wake="' + html(id) + '" data-kind="' + kind + '">' + (kind === 'project' ? 'Вернуть проект' : 'Вернуть сейчас') + '</button>';
}

function drawWaiting(today) {
  const panel = byId('waiting-list');
  const visible = id => projectVisible(id) && !(projectFor(id)?.snoozedUntil > today);
  const questions = (state.answerRequests ?? []).filter(q => visible(q.projectId));
  const native = state.chats.filter(chat => chat.waitingFor && visible(chat.projectId)
    && !questions.some(q => q.provider === 'codex' && q.session === chat.id));
  panel.hidden = filters.view !== 'board' || !(questions.length + native.length);
  if (panel.hidden) return;
  const rows = [...questions, ...native].map(item => {
    const chatId = item.waitingFor ? item.id : item.provider === 'codex' ? item.session : null;
    const title = item.question || (item.waitingFor === 'approval' ? 'Нужно разрешение' : 'Нужен ваш ответ');
    const label = [projectFor(item.projectId)?.name, item.provider || 'Codex', item.title || (chatId && findChat(chatId)?.title) || item.session].join(' · ');
    return '<div class="waiting-row"><div><strong>' + html(title) + '</strong><small>' + html(label) + '</small></div>'
      + (chatId ? '<a class="ghost" href="codex://threads/' + encodeURIComponent(chatId) + '">Открыть чат ↗</a>' : '')
      + (item.event ? '<button class="ghost" type="button" title="Снять отметку на доске. Сам ответ отправляется в исходном чате." data-answered="' + html(item.id) + '">Уже ответил</button>' : '') + '</div>';
  }).join('');
  const markup = '<h2>Ждут вашего ответа</h2>' + rows;
  if (panel.dataset.markup !== markup) { panel.innerHTML = markup; panel.dataset.markup = markup; }
}

function render() {
  const focusedButton = document.activeElement?.closest('button');
  const focusAttribute = focusedButton?.getAttributeNames().find(name =>
    ['data-open', 'data-project', 'data-hide-project', 'data-focus', 'data-add', 'data-import', 'data-restore', 'data-review-project', 'data-deadline-card'].includes(name));

  renderMinute = Math.floor(Date.now() / 60_000);
  const today = localDay();
  const selectedProjects = activeProjects();
  const project = selectedProjects.length === 1 ? selectedProjects[0] : null;
  if (filters.topic && !project?.topics.includes(filters.topic)) filters.topic = '';
  const allCards = state.cards.filter(card => !card.deletedAt && projectVisible(card.projectId));
  const projectCards = allCards.filter(card => returnDate(card) <= today);
  const proposals = state.proposals.filter(p => returnDate(p) <= today);
  const trash = [...state.cards.filter(card => card.deletedAt), ...(state.trashedChats ?? [])].filter(item => projectVisible(item.projectId));
  for (const p of state.trashedProjects ?? []) trash.push({ id: p.id, title: p.name, deletedAt: p.deletedAt, kind: 'project' });
  const unassigned = state.unassignedChats ?? [];
  for (const chat of unassigned) if (chat.deletedAt) trash.push({ ...chat, kind: 'unassigned' });
  const projectChats = state.chats.filter(chat => projectVisible(chat.projectId));
  const due = dueProjects();
  const attentionCount = projectCards.filter(card => needsAttention(card, today)).length + due.length;
  drawProjectFilters(state.projects, selectedProjects);
  if (filters.view !== 'inbox') {
    content.classList.remove('inbox-list');
    byId('inbox-help').hidden = true;
  }
  const readyDrafts = Object.values(state.descriptionDrafts ?? {}).filter(d => d.state === 'ready').length;
  byId('draft-queue').hidden = filters.view !== 'board' && !(filters.view === 'inbox' && !readyDrafts);
  byId('draft-count').textContent = readyDrafts || '';
  const inboxCount = byId('inbox-count');
  const pendingCount = readyDrafts + proposals.length + unassigned.filter(chat => !chat.deletedAt).length;
  inboxCount.textContent = String(pendingCount);
  inboxCount.classList.toggle('has-pending', pendingCount > 0);
  byId('snoozed-count').textContent = allCards.length - projectCards.length + state.proposals.filter(p => projectVisible(p.projectId) && returnDate(p) > today).length || '';
  byId('quick-task').hidden = ['inbox', 'snoozed'].includes(filters.view);
  drawWaiting(today);
  drawNamingOffers();
  const discovery = byId('project-discovery');
  discovery.hidden = !project || allCards.length > 0 || project.snoozedUntil > today || filters.view !== 'board';
  if (!discovery.hidden) {
    const read = projectChats.filter(c => c.historyReview?.status === 'read').length;
    const pending = proposals.filter(p => p.projectId === project.id).length;
    discovery.textContent = projectChats.length ? 'Чаты с проверенной историей: ' + read + ' из ' + projectChats.length
      + '. Предложений ждут решения: ' + pending + '.' : 'В этом проекте пока нет обнаруженных чатов.';
  }
  const tagNames = new Map();
  for (const card of projectCards) for (const tag of card.tags ?? []) tagNames.set(tag.toLowerCase(), tag);
  const tagFilter = byId('tag-filter');
  if (!tagNames.has(filters.tag)) filters.tag = '';
  tagFilter.hidden = filters.view !== 'board' || !tagNames.size;
  const tagOptions = '<option value="">Все теги</option>' + [...tagNames].sort((a, b) => a[1].localeCompare(b[1], 'ru')).map(([key, name]) =>
    '<option value="' + html(key) + '">' + html(name) + '</option>').join('');
  if (tagFilter.dataset.markup !== tagOptions) {
    tagFilter.innerHTML = tagOptions;
    tagFilter.dataset.markup = tagOptions;
  }
  tagFilter.value = filters.tag;

  const scopeCards = state.cards.filter(card => !card.deletedAt && card.status !== 'done'
    && projectVisible(card.projectId));
  const deadlines = scopeCards.filter(card => card.dueOn).sort((a, b) =>
    a.dueOn.localeCompare(b.dueOn) || a.number - b.number);
  const focus = scopeCards.filter(card => card.focusOn === today && returnDate(card) <= today);
  byId('page-title').textContent = viewNames[filters.view];
  const stats = [['Всего задач', projectCards.length], ['Начато', projectCards.filter(card => ['active', 'review'].includes(card.status)).length],
    ['Готово', projectCards.filter(card => card.status === 'done').length]];
  byId('overview').hidden = filters.view !== 'board';
  byId('overview').innerHTML = stats.filter(([, value], index) => index === 0 || value > 0).map(([name, value]) => '<span>' + name + ' <b>' + value + '</b></span>').join('');
  const nearest = byId('nearest');
  const first = deadlines.find(card => returnDate(card) <= today);
  nearest.hidden = filters.view !== 'board' || !first;
  if (!nearest.hidden) {
    nearest.innerHTML = '<button type="button" data-deadline-card="' + html(first.id) + '"><strong>Ближайший срок</strong>'
      + dueBadge(first, today) + '<span>' + html(first.title) + '</span></button>';
  }
  byId('chat-count').textContent = projectChats.length || '';
  byId('trash-count').textContent = trash.length || '';
  byId('focus-count').textContent = focus.length || '';
  byId('dates-count').textContent = deadlines.length || '';
  byId('attention-count').textContent = attentionCount;
  byId('attention').hidden = filters.view !== 'board';
  byId('attention').setAttribute('aria-pressed', String(filters.attention));
  for (const view of Object.keys(viewNames)) {
    byId(view + '-view').setAttribute('aria-pressed', String(filters.view === view));
  }
  placeHighlight();
  byId('add').disabled = !state.projects.length;
  byId('rename-project').disabled = !state.projects.length;
  byId('settings').disabled = !state.projects.length;
  const topicFilter = byId('topic-filter');
  topicFilter.hidden = !project || filters.view !== 'board';
  if (!topicFilter.hidden) {
    const options = '<option value="">Все темы</option>' + project.topics.map(topic =>
      '<option value="' + html(topic) + '">' + html(topic) + '</option>').join('');
    if (topicFilter.innerHTML !== options) topicFilter.innerHTML = options;
    topicFilter.value = filters.topic;
  }

  paintCheck();

  const search = filters.search.toLocaleLowerCase('ru').trim();
  if (filters.view === 'inbox') {
    drawInbox(search, proposals, readyDrafts);
  } else if (filters.view === 'trash') {
    drawTrash(trash.filter(item => item.title.toLocaleLowerCase('ru').includes(search)));
  } else if (!selectedProjects.length) {
    content.innerHTML = '<p class="empty-page">' + (state.projects.length ? 'Выберите проект, чтобы увидеть его задачи.' : 'Создайте проект или восстановите его из корзины.') + '</p>';
  } else if (filters.view === 'snoozed') {
    drawSnoozed(allCards, state.proposals, today, search);
  } else if (filters.view === 'dates' || filters.view === 'focus') {
    const items = filters.view === 'dates' ? deadlines : focus;
    drawAgenda(items.filter(card => [card.title, card.topic, card.next, ...(card.tags ?? []), card.customValue, projectFor(card.projectId)?.name]
      .join(' ').toLocaleLowerCase('ru').includes(search)), today, filters.view);
  } else if (filters.view === 'chats') {
    drawChats(projectChats.filter(chat => chat.title.toLocaleLowerCase('ru').includes(search)));
  } else {
    const cards = projectCards.filter(card => (!filters.topic || card.topic === filters.topic)
      && (!filters.tag || (card.tags ?? []).some(tag => tag.toLowerCase() === filters.tag))
      && (!filters.attention || needsAttention(card, today))
      && [card.title, card.next, card.description, card.topic, ...(card.tags ?? []), card.customValue].join(' ').toLocaleLowerCase('ru').includes(search));
    drawBoard(cards, due, today);
  }
  if (focusAttribute && !focusedButton.isConnected && document.activeElement === document.body) {
    const value = CSS.escape(focusedButton.getAttribute(focusAttribute));
    const replacement = document.querySelector('button[' + focusAttribute + '="' + value + '"]');
    (replacement ?? byId(focusAttribute === 'data-hide-project' ? 'project-filter-toggle' : 'search')).focus({ preventScroll: true });
  }
  if (dialogCard && modal.open) updateRelated();
}

function drawBoard(cards, due, today) {
  const scrollLeft = content.querySelector('.board')?.scrollLeft ?? 0;
  const laneScroll = new Map([...content.querySelectorAll('.cards')].map(lane => [lane.parentElement.dataset.column, lane.scrollTop]));
  const reviews = due.length ? '<div class="project-reviews">'
    + due.map(project => '<button type="button" class="ghost" data-review-project="' + html(project.id) + '"><span class="signal"></span> Пересмотреть ' + html(project.name) + '</button>').join('')
    + '</div>' : '';
  const showProject = activeProjects().length > 1;
  const markup = reviews + '<div class="board" aria-label="Kanban">'
    + state.columns.map(column => {
      const items = cards.filter(card => card.status === column.id);
      return '<section class="column" data-column="' + column.id + '" aria-labelledby="column-' + column.id + '">'
        + '<header class="column-head"><span class="column-dot" aria-hidden="true"></span><h2 id="column-' + column.id + '">'
        + html(column.name) + '</h2><span class="count">' + items.length + '</span>'
        + '<button data-add="' + column.id + '" title="Создать задачу в этой колонке" aria-label="Добавить в «' + html(column.name) + '»" type="button">' + icon('plus') + '</button>'
        + '</header><div class="cards">' + items.map(card => cardHtml(card, showProject, today)).join('')
        + '</div></section>';
    }).join('') + '</div>';
  if (content.firstElementChild && content.querySelector('.board') && lastBoardMarkup === markup) return;
  const counters = new Map([...content.querySelectorAll('.column number-flow')].map(counter => [counter.closest('.column').dataset.column, counter]));
  content.innerHTML = markup;
  for (const label of content.querySelectorAll('.column-head .count')) {
    const counter = counters.get(label.closest('.column').dataset.column) ?? document.createElement('number-flow');
    const value = Number(label.textContent);
    label.replaceChildren(counter);
    if (counter.value !== value) counter.update(value);
  }
  lastBoardMarkup = markup;
  content.querySelector('.board').scrollLeft = scrollLeft;
  for (const lane of content.querySelectorAll('.cards')) lane.scrollTop = laneScroll.get(lane.parentElement.dataset.column) ?? 0;
}

function dueBadge(card, today) {
  if (!card.dueOn) return '';
  const days = daysUntilDue(card, today);
  const date = card.dueOn;
  const absolute = dateFormat.format(new Date(date + 'T12:00:00Z'))
    + (date.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + date.slice(0, 4));
  const level = days < 0 ? 'late' : days <= 7 ? 'soon' : '';
  let label = absolute;
  if (days < 0) label = 'Просрочено · ' + absolute;
  else if (days === 0) label = 'Срок сегодня';
  else if (days === 1) label = 'Завтра · ' + absolute;
  else if (days <= 7) label = 'Через ' + days + (days < 5 ? ' дня' : ' дней') + ' · ' + absolute;
  return '<time class="due ' + level + '" datetime="' + html(date) + '" title="Срок — ' + html(absolute) + '">'
    + icon('calendar-days') + html(label) + '</time>';
}

function focusButton(card) {
  if (card.status === 'done') return '';
  const on = card.focusOn === localDay();
  const label = on ? 'Убрать из фокуса дня' : 'В фокус на сегодня';
  return '<button class="focus-toggle" type="button" data-focus="' + html(card.id) + '" aria-pressed="' + on
    + '" aria-label="' + label + '" title="' + label + '. В полночь по Москве начнётся новый список. Карточка останется в своей колонке.">' + icon('star') + '</button>';
}

function drawAgenda(cards, today, view) {
  if (!cards.length) {
    const message = filters.search ? 'По этому запросу задач нет.' : view === 'dates'
      ? 'Сроки пока не назначены' : 'Выбери задачи на сегодня';
    const detail = filters.search ? '' : view === 'dates'
      ? 'Укажи дату в поле «Срок» любой карточки.' : 'Нажми звезду на карточке, чтобы добавить её в фокус дня.';
    content.innerHTML = '<div class="agenda-empty">' + icon(view === 'dates' ? 'calendar-days' : 'star') + '<h2>' + message + '</h2><p>' + detail + '</p></div>';
    return;
  }
  const groups = new Map();
  for (const card of cards) {
    const days = daysUntilDue(card, today);
    const group = view === 'focus' ? 'На сегодня' : days < 0 ? 'Просрочено' : days === 0 ? 'Сегодня'
      : days <= 7 ? 'В ближайшие 7 дней' : 'Позже';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(card);
  }
  content.innerHTML = [...groups].map(([label, items]) =>
    '<section class="agenda-group"><h2>' + label + ' <small>' + items.length + '</small></h2>' + items.map(card => {
      const column = state.columns.find(item => item.id === card.status);
      return '<article class="agenda-row">' + focusButton(card) + '<div class="agenda-task"><button class="card-title" data-open="'
        + html(card.id) + '">' + html(card.title) + '</button><small>' + html(projectFor(card.projectId)?.name)
        + (card.topic ? ' · ' + html(card.topic) : '') + ' · ' + html(column?.name) + '</small></div>'
        + (returnDate(card) > today ? '<small>Отложено до ' + html(showDate(returnDate(card))) + '</small>' : '') + dueBadge(card, today) + '</article>';
    }).join('') + '</section>').join('');
}

function hasDescriptionSource(card) {
  return card && (cardChats(card).some(id => findChat(id)) || card.source?.provider && card.source.provider !== 'codex');
}

function cardHtml(card, showProject, today) {
  const flags = [];
  if (hasNewReply(card)) flags.push('<span class="tag notice">Новый ответ</span>');
  if (card.block) flags.push('<span class="tag problem">Блокер</span>');
  if (card.run && ['starting', 'inProgress'].includes(card.run.state)) flags.push('<span class="tag running">Чат работает</span>');
  const meta = [];
  if (showProject) {
    meta.push('<span class="tag project">' + projectMark(card.projectId) + html(projectFor(card.projectId)?.name) + '</span>');
  }
  if (card.topic) meta.push('<span class="tag">' + html(card.topic) + '</span>');
  for (const tag of card.tags ?? []) meta.push('<span class="task-tag">#' + html(tag) + '</span>');
  const detail = card.description || card.next;
  return '<article class="card" draggable="true" data-card="' + html(card.id) + '">'
    + '<div class="card-heading"><button class="card-title" type="button" data-open="' + html(card.id) + '">' + html(card.title) + '</button>'
    + focusButton(card) + '</div>'
    + (detail ? '<p class="card-next">' + html(detail) + '</p>' : '')
    + (!card.description && hasDescriptionSource(card) ? '<button type="button" class="card-pull" data-pull-description="' + html(card.id)
      + '" title="Открыть черновик описания для проверки">' + icon('messages-square') + 'Подтянуть из чата</button>' : '')
    + (card.next && card.description && card.next !== card.description ? '<p class="card-field"><span>Следующий шаг</span> ' + html(card.next) + '</p>' : '')
    + (card.customValue ? '<p class="card-field"><span>' + html(projectFor(card.projectId)?.customFieldName || 'Дополнительное поле') + '</span> ' + html(card.customValue) + '</p>' : '')
    + (meta.length || flags.length ? '<div class="chips">' + [...meta, ...flags].join('') + '</div>' : '')
    + '<footer class="card-foot">' + ageLabel(card)
    + dueBadge(card, today) + snoozeButton('card', card.id, true)
    + (card.chatId ? '<span class="linked" aria-label="Привязан чат" title="Связанные чаты Codex: ' + cardChats(card).length + '">' + icon('messages-square') + (cardChats(card).length > 1 ? ' ' + cardChats(card).length : '') + '</span>' : '')
    + '</footer></article>';
}

function drawChats(chats) {
  if (!chats.length) {
    content.innerHTML = '<p class="empty-page">Нет чатов для выбранного фильтра.</p>';
    return;
  }

  content.innerHTML = '<div class="chat-list">' + chats.toSorted((a, b) => b.updatedAt - a.updatedAt).map(chat => {
    const cards = state.cards.filter(card => cardChats(card).includes(chat.id));
    const button = cards.length ? cards.map(card => card.deletedAt
      ? '<button class="ghost" data-restore="' + html(card.id) + '" type="button">Восстановить #' + card.number + '</button>'
      : '<button class="ghost" data-open="' + html(card.id) + '" type="button">Карточка #' + card.number + '</button>').join('') + '<button class="ghost" data-chat-task="' + html(chat.id) + '" type="button">Новая задача</button>'
      : '<button class="primary" data-import="' + html(chat.id) + '" type="button">Создать карточку</button>';
    return '<article class="chat-row"><div><h2>' + html(chat.title) + '</h2><small>'
      + html(projectFor(chat.projectId)?.name) + (chat.updatedAt ? ' · ' + dateFormat.format(new Date(chat.updatedAt * 1000)) : '')
      + '</small></div><div class="chat-actions"><button class="ghost" data-move-chat="' + html(chat.id) + '" type="button">Перенести чат</button>' + button + '</div></article>';
  }).join('') + '</div>';
}

function drawTrash(items) {
  if (!items.length) {
    content.innerHTML = '<p class="empty-page">Корзина пуста.</p>';
    return;
  }
  content.innerHTML = '<div class="chat-list">' + items.toSorted((a, b) => b.deletedAt.localeCompare(a.deletedAt)).map(item => {
    const isCard = item.number !== undefined;
    const isProject = item.kind === 'project';
    const unassigned = item.kind === 'unassigned';
    const label = unassigned ? 'Чат без проекта · ' + item.sourceName : isProject ? 'Проект' : (isCard ? 'Карточка #' + item.number : 'Чат') + ' · ' + projectFor(item.projectId)?.name;
    const action = unassigned ? 'data-restore-unassigned' : isProject ? 'data-restore-project' : isCard ? 'data-restore' : 'data-restore-chat';
    return '<article class="chat-row"><div><h2>' + html(item.title) + '</h2><small>'
      + html(label) + '</small></div><button class="ghost" type="button" ' + action + '="' + html(item.id) + '">Восстановить</button></article>';
  }).join('') + '</div>';
}

function showDialog(title, inner, dialog = modal) {
  const titleId = dialog.id + '-title';
  dialog.innerHTML = '<div class="modal-head"><h2 id="' + titleId + '">' + html(title)
    + '</h2><button class="icon ghost" data-close aria-label="Закрыть" type="button">' + icon('x') + '</button></div>' + inner;
  dialog.setAttribute('aria-labelledby', titleId);
  if (!dialog.open) dialog.showModal();
}

for (const dialog of [modal, byId('snooze-modal')]) {
  let startedOutside = false;
  function outside(event) {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX >= rect.right
      || event.clientY < rect.top || event.clientY >= rect.bottom);
  }
  dialog.addEventListener('pointerdown', event => { startedOutside = event.button === 0 && outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('click', event => {
    if (startedOutside && outside(event)) dialog.close();
    startedOutside = false;
  });
}

function previewProposal(id) {
  const p = state.proposals.find(item => item.id === id);
  if (!p) return;
  dialogCard = null;
  const chat = p.source.provider === 'codex' && findChat(p.source.session);
  showDialog(p.title, '<div class="modal-inner"><p>' + html(projectFor(p.projectId)?.name) + ' · ' + html(p.source.provider) + '</p>'
    + (p.description ? '<p class="offer-description">' + html(p.description) + '</p>' : '')
    + (p.next ? '<p>' + html(p.next) + '</p>' : '')
    + (chat ? '<a href="codex://threads/' + encodeURIComponent(chat.id) + '">' + html(chat.title) + ' ↗</a>' : '<p>' + html(p.source.session) + '</p>')
    + (p.source.at ? '<small>' + html(historyDateFormat.format(p.source.at * 1000)) + '</small>' : '')
    + snoozeButton('proposal', p.id) + '</div>');
}

function snoozeDialog(kind, id) {
  const item = kind === 'card' ? state.cards.find(c => c.id === id) : state.proposals.find(p => p.id === id);
  if (!item) return;
  const project = projectFor(item.projectId);
  const today = localDay();
  const tomorrow = new Date(Date.parse(today) + dayMs).toISOString().slice(0, 10);
  const week = new Date(Date.parse(today) + 7 * dayMs).toISOString().slice(0, 10);
  const dialog = byId('snooze-modal');
  showDialog('Отложить до…', '<form id="snooze-form" class="modal-inner"><p>' + html(item.title) + '</p>'
    + '<label>Что отложить<select name="scope"><option value="item">Только эту задачу</option><option value="project">Все задачи проекта «'
    + html(project.name) + '»</option></select></label><p class="help" id="scope-help"></p>'
    + '<label>Дата возврата<input type="date" name="until" min="' + tomorrow + '" max="9999-12-31" value="' + (item.snoozedUntil > today ? html(item.snoozedUntil) : tomorrow) + '" required></label>'
    + '<div class="pause-presets"><button type="button" class="ghost" data-date="' + tomorrow + '">Завтра</button>'
    + '<button type="button" class="ghost" data-date="' + week + '">Через неделю</button></div>'
    + '<p class="form-error" role="alert" hidden></p><div class="modal-buttons"><button type="button" class="ghost" data-close>Отмена</button>'
    + '<button type="submit" class="primary">Отложить</button></div></form>', dialog);
  const form = byId('snooze-form');
  function describe() {
    byId('scope-help').textContent = form.elements.scope.value === 'project'
      ? 'До этой даты в «Отложенных» будут и текущие задачи проекта, и новые предложения. Дедлайны останутся в разделе «Сроки».'
      : 'В выбранный день задача вернётся на прежнее место. Дата считается по Москве.';
  }
  describe();
  form.elements.scope.onchange = describe;
  for (const button of form.querySelectorAll('[data-date]')) button.onclick = () => { form.elements.until.value = button.dataset.date; };
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    if (button.disabled) return;
    button.disabled = true;
    const whole = form.elements.scope.value === 'project';
    const until = form.elements.until.value;
    try {
      accept(await api('snooze', 'POST', { kind: whole ? 'project' : kind, id: whole ? project.id : id, until }));
      if (dialog.open && dialog.contains(form)) {
        dialog.close();
        if (modal.open && !modal.querySelector('#card-form')) modal.close();
      }
      notify((whole ? 'Проект отложен до ' : 'Задача отложена до ') + showDate(until));
    } catch (error) {
      const feedback = form.querySelector('[role=alert]');
      feedback.textContent = error.message;
      feedback.hidden = false;
    } finally { button.disabled = false; }
  };
}

byId('snooze-modal').onclick = event => {
  if (event.target.closest('[data-close]')) byId('snooze-modal').close();
};

byId('draft-queue').onclick = openDraftQueue;
function openDraftQueue() {
  dialogCard = null;
  showDialog('Черновики описаний', '<div class="modal-inner" id="draft-review"><p>Для карточек с пустым описанием во всех проектах. Проверь текст и сохрани нужные описания.</p>'
    + '<button type="button" class="ghost" data-prepare>Подтянуть для всех</button>'
    + '<p class="help" role="status" data-summary></p><div data-draft-list></div></div>');
  const panel = byId('draft-review');
  const list = panel.querySelector('[data-draft-list]');
  const prepare = panel.querySelector('[data-prepare]');
  const summary = panel.querySelector('[data-summary]');

  function draw() {
    const drafts = state.descriptionDrafts ?? {};
    const cards = state.cards.filter(card => drafts[card.id]).sort((a,b) => a.number - b.number);
    const ready = cards.filter(card => drafts[card.id].state === 'ready').length;
    summary.textContent = cards.length ? 'Готово к проверке: ' + ready + (cards.length > ready ? ' · Без текста: ' + (cards.length - ready) : '') : 'Черновиков для проверки пока нет.';
    for (const node of [...list.children]) {
      const entry = drafts[node.dataset.id];
      const field = node.querySelector('textarea');
      if (!entry || entry.version !== node.dataset.version && field.value === field.defaultValue) node.remove();
      else if (entry.version !== node.dataset.version) node.querySelector('[role=status]').textContent = 'Черновик изменился в другом окне. Скопируй правку перед повторным открытием.';
    }
    for (const card of cards) {
      if ([...list.children].some(node => node.dataset.id === card.id)) continue;
      const draft = drafts[card.id];
      const row = document.createElement('section');
      row.className = 'draft-review-row';
      row.dataset.id = card.id;
      row.dataset.version = draft.version;
      const linked = cardChats(card).map(findChat).filter(Boolean);
      const chat = draft.chatId ? findChat(draft.chatId) : linked.length === 1 ? linked[0] : null;
      row.innerHTML = '<small>' + html(projectFor(card.projectId)?.name) + (chat ? ' · <a href="codex://threads/' + encodeURIComponent(chat.id) + '">Связанный чат</a>' : '') + '</small>'
        + '<label>#' + card.number + ' · ' + html(card.title) + '<textarea rows="3" maxlength="4000">' + html(draft.description) + '</textarea></label>'
        + '<small role="status">' + (draft.state === 'missing' ? 'Не нашлось подробностей. Можно вписать текст вручную.' : draft.state === 'unavailable' ? 'История недоступна. Можно повторить подбор.' : '') + '</small>'
        + '<div class="draft-actions"><button type="button" class="primary" data-decision="save">Сохранить в карточку</button><button type="button" class="ghost" data-decision="edit">Оставить черновиком</button><button type="button" class="ghost" data-decision="skip">Пропустить</button></div>';
      list.append(row);
    }
  }

  prepare.onclick = async () => {
    prepare.disabled = true;
    summary.textContent = 'Читаю связанные чаты…';
    try { accept(await api('description-drafts/prepare', 'POST')); if (panel.isConnected) draw(); }
    catch (error) { summary.textContent = error.message; }
    finally { prepare.disabled = false; }
  };
  list.onclick = async event => {
    const decision = event.target.closest('[data-decision]')?.dataset.decision;
    if (!decision) return;
    const row = event.target.closest('[data-id]');
    const field = row.querySelector('textarea');
    const feedback = row.querySelector('[role=status]');
    if (decision !== 'skip' && !field.value.trim()) { feedback.textContent = 'Введи описание.'; field.focus(); return; }
    field.readOnly = true;
    const buttons = row.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      accept(await api('description-drafts/' + row.dataset.id + '/' + decision, 'POST', { version: row.dataset.version, description: field.value }));
      if (!panel.isConnected) return;
      if (decision === 'edit' && state.descriptionDrafts[row.dataset.id]) {
        row.dataset.version = state.descriptionDrafts[row.dataset.id].version;
        field.defaultValue = field.value = state.descriptionDrafts[row.dataset.id].description;
        feedback.textContent = 'Правки сохранены в черновике.';
      }
      draw();
    } catch (error) { feedback.textContent = error.message; }
    finally { field.readOnly = false; buttons.forEach(button => { button.disabled = false; }); }
  };
  draw();
}

function bindDescriptionDraft(form, card, projectId) {
  const box = form.querySelector('.chat-draft');
  const pull = box.querySelector('[data-pull]');
  const append = box.querySelector('[data-append]');
  const preview = box.querySelector('[data-preview-text]');
  const feedback = box.querySelector('[role=status]');
  const field = form.elements.description;
  let request = 0, edits = 0, automatic = null, previous = '';
  const hasSource = hasDescriptionSource(card);

  function insert(text) {
    field.value = text;
    field.rows = Math.max(field.rows, 4);
    preview.hidden = append.hidden = true;
    feedback.textContent = 'Черновик можно поправить. Запишется по кнопке «' + (card ? 'Сохранить' : 'Создать задачу') + '».';
  }
  field.addEventListener('input', () => { automatic = null; edits++; });
  append.onclick = () => {
    const value = [field.value.trimEnd(), preview.textContent].filter(Boolean).join('\n\n');
    if (value.length > field.maxLength) {
      feedback.textContent = 'Описание вмещает 4000 символов. Сократи текст или скопируй нужный фрагмент.';
      return;
    }
    insert(value);
  };

  async function load() {
    const ticket = ++request;
    const initialEdits = edits;
    const chatId = form.elements.chatId.value;
    const title = form.elements.title.value.trim();
    pull.disabled = true;
    preview.hidden = append.hidden = true;
    feedback.textContent = 'Ищу детали задачи в переписке…';
    try {
      const draft = card ? await api('cards/' + card.id + '/description-draft', 'POST')
        : await api('description-draft', 'POST', { chatId, projectId: projectId(), title });
      if (ticket !== request || !modal.open || !modal.contains(form)) return;
      if (!draft.description) { feedback.textContent = 'В переписке не нашлось подробностей для этой задачи.'; return; }
      if (!field.value.trim() && edits === initialEdits) {
        insert(draft.description);
        automatic = draft.description;
      } else if (field.value.includes(draft.description)) {
        feedback.textContent = 'Эти детали уже есть в описании.';
      } else {
        preview.textContent = draft.description;
        preview.hidden = append.hidden = false;
        feedback.textContent = 'Из переписки' + (draft.chatId && findChat(draft.chatId) ? ' · ' + findChat(draft.chatId).title : '');
      }
    } catch (error) {
      if (ticket === request) feedback.textContent = error.message;
    } finally { if (ticket === request) pull.disabled = false; }
  }
  let loading;
  pull.onclick = () => { loading = load(); };

  function refresh() {
    const chatId = form.elements.chatId.value;
    const title = form.elements.title.value.trim();
    if (card) {
      box.hidden = !hasSource;
      const links = [...form.querySelectorAll('[name=otherChatIds]:checked')].map(input => input.value);
      const changed = chatId !== (card.chatId ?? '') || links.length !== (card.otherChatIds?.length ?? 0)
        || links.some(id => !card.otherChatIds?.includes(id));
      if (changed || previous === 'changed') {
        request++;
        preview.hidden = append.hidden = true;
        pull.disabled = changed;
        feedback.textContent = changed ? 'Сохрани выбранные чаты, чтобы взять описание из новой переписки.' : '';
      }
      previous = changed ? 'changed' : 'saved';
      return;
    }
    const key = JSON.stringify([projectId(), chatId, title]);
    if (key === previous) return;
    previous = key;
    request++;
    if (automatic !== null && field.value === automatic) field.value = '';
    automatic = null;
    box.hidden = !chatId || !title;
    preview.hidden = append.hidden = true;
    feedback.textContent = '';
    pull.disabled = false;
    loading = box.hidden ? null : load();
  }
  refresh();
  return { refresh, ready: () => loading };
}

function cardForm(card, projectId, status = 'planned', draftTitle = '') {
  const project = projectFor(projectId);
  if (!project) return;
  dialogCard = card?.id ?? null;
  const linkedChats = new Set(cardChats(card));
  const linkedTrash = (state.trashedChats ?? []).filter(c => linkedChats.has(c.id)).map(c => ({ ...c, title: c.title + ' (в корзине)' }));
  const availableChats = state.chats.filter(chat => chat.projectId === projectId || linkedChats.has(chat.id)).concat(linkedTrash);
  const projectField = !card && state.projects.length > 1 ? '<label>Проект<select name="projectId">'
    + state.projects.map(item => '<option value="' + html(item.id) + '"' + selected(item.id === projectId) + '>' + html(item.name) + '</option>').join('')
    + '</select></label>' : '';
  const form = '<form id="card-form" class="modal-inner">' + projectField
    + '<label>Название<input name="title" required maxlength="200" value="' + html(card?.title ?? draftTitle) + '"></label>'
    + '<label>Описание<textarea name="description" maxlength="4000" rows="2">' + html(card?.description) + '</textarea></label>'
    + '<div class="chat-draft" id="chat-draft" hidden><button type="button" class="ghost" data-pull>Подтянуть из чата</button>'
    + '<small class="help" role="status"></small><div data-preview-text hidden></div>'
    + '<button type="button" class="ghost" data-append hidden>Добавить к описанию</button></div>'
    + '<div class="field-row"><label>Колонка<select name="status" aria-label="Колонка">'
    + state.columns.map(column => '<option value="' + column.id + '"' + selected(column.id === (card?.status ?? status)) + '>' + html(column.name) + '</option>').join('')
    + '</select></label><label>Тема<select name="topic" aria-label="Тема"><option value="">Без темы</option>'
    + project.topics.map(topic => '<option value="' + html(topic) + '"' + selected(topic === card?.topic) + '>' + html(topic) + '</option>').join('')
    + '</select></label></div>'
    + '<div class="field-row"><label>Теги через запятую<input name="tags" placeholder="видео, релиз" value="' + html((card?.tags ?? []).join(', ')) + '"></label>'
    + '<label><span id="custom-field-label">' + html(project.customFieldName || 'Дополнительное поле') + '</span><input name="customValue" maxlength="240" value="' + html(card?.customValue) + '"></label></div>'
    + (card?.source ? '<p class="help">Источник · ' + html(card.source.provider) + ' · ' + html(findChat(card.chatId)?.title || card.source.session) + '</p>' : '')
    + '<label>Следующий шаг<input name="next" maxlength="1000" value="' + html(card?.next) + '"></label>'
    + '<div class="field-row"><label>Срок (необязательно)<input name="dueOn" type="date" max="9999-12-31" aria-describedby="due-hint" value="' + html(card?.dueOn) + '"><small id="due-hint" class="help">За 7 дней до срока на доске появится оранжевая отметка.</small></label>'
    + '<label title="Звезда действует до полуночи по Москве. Завтра можно выбрать фокус заново." class="focus-field"><input name="focusToday" type="checkbox"' + ((card ? card.focusOn === localDay() : filters.view === 'focus') ? ' checked' : '') + '> В фокус на сегодня</label></div>'
    + (card ? '<div class="status-age">' + ageLabel(card) + (card.statusObserved ? ' · точная дата перехода неизвестна' : '') + '</div>' : '')
    + '<label>Что блокирует<input name="block" maxlength="400" value="' + html(card?.block) + '"></label>'
    + '<label>Основной чат Codex<select name="chatId" aria-label="Основной чат Codex"><option value="">Без чата</option>'
    + availableChats.map(chat => '<option value="' + html(chat.id) + '"' + selected(chat.id === card?.chatId) + '>' + html(chat.title) + '</option>').join('')
    + '</select></label>'
    + '<details id="other-chats" class="bridge-settings" hidden><summary>Другие чаты этой задачи <span id="other-count"></span></summary><div class="chat-choices" id="other-options"></div></details>'
    + '<div id="related" class="related" hidden><label id="reply-chat-field" hidden>Читать ответы из чата<select id="reply-chat"></select></label><div id="related-summary"></div><pre id="reply-preview" hidden></pre></div>'
    + '<p class="form-error" id="form-error" role="alert" hidden></p>'
    + '<div class="modal-buttons">'
    + (card ? snoozeButton('card', card.id) + '<button class="ghost danger-button" id="trash-card" type="button">Удалить</button>' : '')
    + (card ? '<button class="ghost" id="launch" type="button" hidden>Продолжить в чате</button>' : '')
    + '<button class="primary" type="submit">' + (card ? 'Сохранить' : 'Создать задачу') + '</button></div></form>';
  showDialog(card ? 'Задача #' + card.number + ' · ' + project.name : state.projects.length > 1 ? 'Новая задача' : 'Новая задача · ' + project.name, form);
  const node = byId('card-form');
  let primary = node.elements.chatId.value;
  const chosen = new Set(card?.otherChatIds ?? []);
  const { refresh: refreshDraft, ready: draftReady } = bindDescriptionDraft(node, card, () => projectId);
  if (!card) node.elements.title.addEventListener('change', refreshDraft);
  function drawOtherChats() {
    const chats = state.chats.filter(chat => chat.projectId === projectId || linkedChats.has(chat.id)).concat(linkedTrash).filter(chat => chat.id !== primary);
    byId('other-chats').hidden = !primary || !chats.length;
    byId('other-count').textContent = chosen.size ? '(' + chosen.size + ')' : '';
    byId('other-options').innerHTML = chats.map(chat => '<label><input type="checkbox" name="otherChatIds" value="' + html(chat.id)
      + '"' + (chosen.has(chat.id) ? ' checked' : '') + '> ' + html(chat.title) + '</label>').join('');
  }
  byId('other-options').onchange = event => {
    if (event.target.checked) chosen.add(event.target.value);
    else chosen.delete(event.target.value);
    byId('other-count').textContent = chosen.size ? '(' + chosen.size + ')' : '';
    refreshDraft();
  };
  node.elements.chatId.onchange = () => {
    const next = node.elements.chatId.value;
    if (!next) chosen.clear();
    else if (chosen.delete(next) && primary) chosen.add(primary);
    primary = next;
    drawOtherChats();
    refreshDraft();
    updateRelated();
  };
  byId('reply-chat').onchange = updateRelated;
  drawOtherChats();
  refreshDraft();
  if (node.elements.projectId) {
    node.elements.projectId.onchange = () => {
      projectId = node.elements.projectId.value;
      byId('custom-field-label').textContent = projectFor(projectId).customFieldName || 'Дополнительное поле';
      const topics = projectFor(projectId).topics;
      node.elements.topic.replaceChildren(new Option('Без темы', ''), ...topics.map(topic => new Option(topic, topic)));
      const chats = state.chats.filter(chat => chat.projectId === projectId);
      node.elements.chatId.replaceChildren(new Option('Без чата', ''), ...chats.map(chat => new Option(chat.title, chat.id)));
      chosen.clear();
      primary = '';
      refreshDraft();
      drawOtherChats();
    };
  }
  node.addEventListener('submit', async event => {
    event.preventDefault();
    if (!card) refreshDraft();
    await draftReady();
    if (modal.open && modal.contains(node)) saveCard(node, card, projectId);
  });
  if (card) {
    byId('trash-card').onclick = async () => {
      const button = byId('trash-card');
      button.disabled = true;
      try {
        accept(await api('cards/' + card.id + '/trash', 'POST'));
        if (modal.open && modal.contains(node)) modal.close();
        notify('Карточка в корзине.');
      } catch (error) {
        if (modal.open && modal.contains(node)) formError(error.message);
        button.disabled = false;
      }
    };
    byId('launch').onclick = () => {
      if (node.reportValidity()) saveCard(node, card, projectId, true);
    };
    updateRelated();
  }
  return node;
}

function updateRelated() {
  const card = state.cards.find(card => card.id === dialogCard);
  const node = byId('card-form');
  if (!node || !card) return;
  const primary = findChat(node.elements.chatId.value);
  const reader = byId('reply-chat');
  const ids = [...new Set([primary?.id, ...cardChats(card)].filter(id => findChat(id)))];
  const options = ids.map(id => '<option value="' + html(id) + '">' + html(findChat(id)?.title || id) + '</option>').join('');
  if (reader.dataset.markup !== options) {
    const previous = reader.value;
    reader.innerHTML = options;
    reader.dataset.markup = options;
    reader.value = ids.includes(previous) ? previous : ids[0] || '';
  }
  byId('reply-chat-field').hidden = ids.length < 2;
  const chat = findChat(reader.value);
  const summary = byId('related-summary');
  const related = byId('related');
  const launch = byId('launch');
  related.hidden = !chat;
  launch.hidden = !primary;
  const running = ['starting', 'inProgress'].includes(card.run?.state);
  launch.disabled = running || Boolean(primary?.historyIssue || primary?.historySource === 'journal') || node.dataset.saving === 'yes';
  launch.textContent = running ? 'Чат работает…' : ids.length > 1 ? 'Продолжить в основном чате' : 'Продолжить в чате';
  if (!chat) return;
  const savedLink = cardChats(card).includes(chat.id);
  const unread = savedLink && chat.reply && chat.reply.id !== seenIn(card, chat.id);
  const status = running ? '<span class="tag running">Чат работает</span>'
    : card.run?.state === 'completed' ? '<span class="tag">Запуск завершён</span>' : '';
  const markup = '<p class="related-title"><strong>' + html(chat.title) + '</strong>'
    + (unread ? '<span class="tag notice">Новый ответ</span>' : '') + (card.chatId === chat.id ? status : '') + '</p>'
    + '<a class="ghost" href="codex://threads/' + encodeURIComponent(chat.id) + '">Открыть в Codex ↗</a>'
    + (savedLink && chat.reply ? '<button class="ghost" data-reply type="button">Показать ответ</button>' : '')
    + (unread ? '<button class="ghost" data-seen="' + html(chat.reply.id) + '" type="button">Прочитано</button>' : '')
    + (card.chatId === chat.id && card.run?.error ? '<p class="form-error">' + html(card.run.error) + '</p>' : '')
    + (chat.id !== primary?.id ? '<p class="help">Ответы этого чата доступны здесь. Для запуска задачи выбран основной чат.</p>' : chat.historySource === 'journal' && !chat.historyIssue ? '<p class="help">Ответ читается из локального журнала. Для продолжения открой чат в Codex.</p>'
      : chat.historyIssue ? '<p class="form-error">Codex не смог прочитать историю этого чата.</p>'
      : '<p class="help">«Продолжить в чате» отправит следующий шаг в фоновый режим чтения.</p>');
  if (summary.dataset.markup !== markup) {
    const active = summary.contains(document.activeElement) ? document.activeElement : null;
    summary.innerHTML = markup;
    summary.dataset.markup = markup;
    if (active) {
      const next = active.matches('a') ? summary.querySelector('a') : summary.querySelector(active.hasAttribute('data-reply') ? '[data-reply]' : '[data-seen]');
      (next ?? summary.querySelector('a'))?.focus({ preventScroll: true });
    }
  }
  const preview = byId('reply-preview');
  if (preview.dataset.thread !== chat.id || preview.dataset.replyId !== chat.reply?.id) preview.hidden = true;
}

async function saveCard(form, card, projectId, launch = false) {
  const inline = form.hasAttribute('data-inline-draft');
  if (form.dataset.saving === 'yes' || (inline && composer.hasAttribute('data-saving'))) return;
  const data = new FormData(form);
  const values = Object.fromEntries(data);
  if (form.elements.chatId) values.otherChatIds = data.getAll('otherChatIds');
  const today = localDay();
  const focus = form.elements.focusToday;
  values.focusOn = card && focus.checked === focus.defaultChecked ? card.focusOn ?? '' : (focus.checked ? today : '');
  delete values.focusToday;
  if (typeof values.tags === 'string') values.tags = values.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  if (launch && !values.next.trim()) {
    formError('Запиши следующий шаг, чтобы продолжить в чате.');
    form.elements.next.focus();
    return;
  }
  form.dataset.saving = 'yes';
  if (inline) setComposerBusy(true);
  formError('');
  for (const button of form.querySelectorAll('.modal-buttons button')) button.disabled = true;
  try {
    if (card) {
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => ['tags', 'otherChatIds'].includes(key) ? JSON.stringify(value) !== JSON.stringify(card[key] ?? []) : value !== (card[key] ?? '')));
      if ('description' in changed) changed.previousDescription = card.description ?? '';
      if (Object.keys(changed).length) accept(await api('cards/' + card.id, 'PATCH', changed));
      if (launch) {
        accept(await api('cards/' + card.id + '/launch', 'POST'));
        notify('Следующий шаг отправлен в чат.');
        return;
      }
    } else {
      accept(await api('cards', 'POST', { ...values, projectId }));
      if (form.dataset.inlineDraft === quickTitle.value) quickTitle.value = '';
    }
    if (modal.open && modal.contains(form)) modal.close();
    notify(card ? 'Карточка сохранена.' : projectVisible(projectId) ? 'Задача на доске.' : 'Задача создана. Проект скрыт фильтром.');
  } catch (error) {
    if (modal.open && modal.contains(form)) formError(error.message);
    else if (inline) notify(error.message);
    if (launch) refresh();
  } finally {
    delete form.dataset.saving;
    if (inline) setComposerBusy(false);
    for (const button of form.querySelectorAll('.modal-buttons button')) button.disabled = false;
    if (dialogCard) updateRelated();
  }
}

function formError(message) {
  const error = byId('form-error');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function removeProjectButton(project) {
  return project.canRemove ? '<button type="button" class="ghost danger-button" data-trash-project="' + html(project.id)
    + '" title="Переместить пустой проект в корзину доски">Убрать проект с доски</button>' : '';
}

async function removeProject(button) {
  button.disabled = true;
  try {
    accept(await api('projects/' + button.dataset.trashProject + '/trash', 'POST'));
    if (modal.contains(button) && modal.open) modal.close();
    notify('Проект перемещён в корзину.');
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

function assignChatDialog(chat) {
  dialogCard = null;
  const options = state.projects.map(p => '<option value="' + html(p.id) + '">' + html(p.name) + '</option>').join('');
  showDialog('Выбрать проект', '<form class="modal-inner" id="assign-chat-form"><strong>' + html(chat.title) + '</strong>'
    + '<label>Куда перенести<select name="target" required>'
    + (options ? '<option value="">Выбери проект</option>' + options : '')
    + '<option value="@new">Создать новый проект</option></select></label>'
    + '<label>Название нового проекта<input name="name" maxlength="100" required></label>'
    + '<p class="form-error" role="alert" hidden></p><div class="modal-buttons"><button type="button" data-close class="ghost">Отмена</button>'
    + '<button type="submit" class="primary">Перенести чат</button></div></form>');
  const form = byId('assign-chat-form');
  const { target, name } = form.elements;
  function updateFields() {
    name.disabled = target.value !== '@new';
    name.closest('label').hidden = name.disabled;
  }
  updateFields();
  target.onchange = updateFields;
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const creating = target.value === '@new';
    const destination = creating ? name.value.trim() : target.selectedOptions[0].text;
    try {
      const body = creating ? { name: destination } : { toProjectId: target.value };
      accept(await api('unassigned/assign', 'POST', { chatId: chat.id, ...body }));
      if (modal.open && modal.contains(form)) modal.close();
      notify('Чат перенесён в «' + destination + '».');
    } catch (error) {
      const message = form.querySelector('.form-error');
      message.textContent = error.message;
      message.hidden = false;
      button.disabled = false;
    }
  };
}

function organizeProjects(from = null, selectedChat = '') {
  dialogCard = null;
  const chats = from ? state.chats.filter(chat => chat.projectId === from.id) : [];
  const destinations = from ? state.projects.filter(p => p.id !== from.id) : [];
  const choose = from ? '<fieldset class="move-chats"><legend>Чаты · ' + html(from.name) + '</legend>'
    + chats.map(chat => '<label><input type="checkbox" name="chats" value="' + html(chat.id) + '"' + (chat.id === selectedChat ? ' checked' : '') + '> ' + html(chat.title) + '</label>').join('')
    + '</fieldset><div><button type="button" class="ghost danger-button" id="trash-selected">' + icon('trash-2') + ' Удалить с доски</button>'
    + '<p class="help">Удалённые чаты можно вернуть из корзины. Переписка в Codex и созданные карточки сохранятся.</p></div>'
    + '<p class="help">При переносе предложения и карточки с выбранным основным чатом перейдут в другой проект.</p>'
    + '<label>Куда перенести<select name="target"><option value="">Создать новый проект</option>'
    + destinations.map(p => '<option value="' + html(p.id) + '">' + html(p.name) + '</option>').join('') + '</select></label>' : '';
  showDialog(from ? 'Распределить чаты' : 'Создать проект', '<form id="organize-form" class="modal-inner">' + choose
    + '<label id="new-name-label">Название нового проекта<input name="name" maxlength="100" required></label>'
    + '<p class="form-error" role="alert" hidden></p><div class="modal-buttons"><button class="ghost" type="button" data-close>Отмена</button>'
    + '<button type="submit" class="primary">' + (from ? 'Перенести' : 'Создать проект') + '</button></div></form>');
  const form = byId('organize-form');
  const submit = form.querySelector('[type="submit"]');
  const trash = form.querySelector('#trash-selected');
  function controls() {
    const creating = !form.elements.target?.value;
    byId('new-name-label').hidden = !creating;
    form.elements.name.disabled = !creating;
    submit.disabled = Boolean(form.dataset.saving || (from && !form.querySelector('input[name="chats"]:checked')));
    if (trash) trash.disabled = submit.disabled;
  }
  controls();
  form.onchange = controls;
  async function save(remove = false) {
    if (submit.disabled) return;
    const chatIds = new FormData(form).getAll('chats');
    const name = form.elements.name.value.trim();
    const toProjectId = form.elements.target?.value;
    const destName = toProjectId ? projectFor(toProjectId).name : name;
    form.dataset.saving = 'yes';
    controls();
    const errorBox = form.querySelector('.form-error');
    errorBox.hidden = true;
    try {
      let updated;
      if (remove) updated = await api('chats/trash', 'POST', { fromProjectId: from.id, chatIds });
      else if (from) updated = await api('chats/move', 'POST', { fromProjectId: from.id, toProjectId, name, chatIds });
      else updated = await api('projects', 'POST', { name });
      accept(updated);
      if (modal.open && modal.contains(form)) {
        if (from && state.chats.some(c => c.projectId === from.id)) organizeProjects(from);
        else if (from && projectFor(from.id)?.canRemove) {
          showDialog('«' + from.name + '» пуст', '<div class="modal-inner"><p>Распределённые чаты продолжат обновляться в своих проектах.</p>'
            + '<div class="modal-buttons"><button type="button" class="ghost" data-close>Оставить проект</button>'
            + removeProjectButton(projectFor(from.id)) + '</div></div>');
        } else modal.close();
      }
      if (remove) notify('В корзину перемещено чатов: ' + chatIds.length + '.');
      else notify(from ? 'Перенесено чатов в «' + destName + '» — ' + chatIds.length + '.' : 'Проект «' + name + '» создан.');
    } catch (error) {
      delete form.dataset.saving;
      if (modal.contains(form)) { errorBox.textContent = error.message; errorBox.hidden = false; controls(); }
    }
  }
  form.onsubmit = event => { event.preventDefault(); save(); };
  if (trash) trash.onclick = () => save(true);
}

function renameDialog(project) {
  if (!project) return;
  dialogCard = null;
  const chats = state.chats.filter(c => c.projectId === project.id);
  const offer = (state.naming ?? []).find(p => p.projectId === project.id);
  const chatList = items => items.length ? '<ul class="name-evidence">' + items.map(c =>
    '<li><a href="codex://threads/' + encodeURIComponent(c.id) + '">' + html(c.title) + '</a></li>').join('') + '</ul>' : '<p class="help">Пока нет чатов.</p>';
  const history = (project.renames ?? []).slice().reverse();
  showDialog('Переименовать проект', '<form id="rename-form" class="modal-inner">'
    + '<label>Проект<select id="rename-target">' + state.projects.map(p => '<option value="' + html(p.id) + '"' + selected(project.id === p.id) + '>' + html(p.name) + '</option>').join('') + '</select></label>'
    + '<section><h3>Чаты проекта · ' + chats.length + '</h3>' + chatList(chats) + (chats.length ? '<button id="sort-project" type="button" class="ghost">Распределить чаты по проектам</button>' : '') + '</section>'
    + (!chats.length && !project.canRemove ? '<p class="help">Чтобы убрать проект с доски, разбери оставшиеся карточки, предложения и вопросы.</p>' : '')
    + removeProjectButton(project)
    + (offer?.suggestion ? '<p class="help">Вариант по названиям чатов можно отредактировать.</p>' : '')
    + '<label>Название на доске<input name="name" required maxlength="100" value="' + html(offer?.suggestion || project.name) + '"></label>'
    + (history.length ? '<details><summary>История названий</summary>' + history.map(h => '<p>' + html(h.from) + ' → ' + html(h.to) + ' · ' + html(checkedDate(h.at)) + '</p>' + chatList(h.chats)).join('') + '</details>' : '')
    + '<p class="form-error" id="form-error" role="alert" hidden></p><div class="modal-buttons">'
    + (offer ? '<button type="button" class="ghost" id="keep-project-name">Оставить название</button>' : '')
    + '<button class="primary" type="submit">Сохранить название</button></div></form>');
  const form = byId('rename-form');
  if (chats.length) byId('sort-project').onclick = () => organizeProjects(project);
  byId('rename-target').onchange = event => renameDialog(projectFor(event.target.value));
  const save = async update => {
    if (form.dataset.saving) return;
    form.dataset.saving = 'yes';
    try {
      accept(await api('projects/' + project.id, 'PATCH', { ...update, previousName: project.name }));
      if (modal.contains(form) && modal.open) modal.close();
      notify(update.keepName ? 'Название сохранено.' : 'Название проекта обновлено.');
    } catch (error) {
      if (modal.contains(form)) formError(error.message);
    } finally { delete form.dataset.saving; }
  };
  form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) save({ name: form.elements.name.value.trim(), basisChatIds: chats.map(c => c.id) }); };
  if (offer) byId('keep-project-name').onclick = () => save({ keepName: true });
}

function projectDialog(project) {
  if (!project) return;
  dialogCard = null;
  showDialog('Настройки · ' + project.name,
    '<div class="modal-inner">' + (state.projects.length > 1 ? '<label>Проект<select id="settings-project">'
      + state.projects.map(item => '<option value="' + html(item.id) + '"' + selected(item.id === project.id) + '>' + html(item.name) + '</option>').join('')
      + '</select></label>' : '')
    + '<div><label class="project-color-field">Цвет проекта<input type="color" id="project-color" value="' + html(project.color) + '"></label></div>'
    + '<div class="setting-row"><label><input id="project-auto" type="checkbox"' + (project.auto ? ' checked' : '') + '> Предлагать карточку для нового чата</label></div>'
    + '<div class="setting-row"><label><input id="project-visible" type="checkbox"' + (!project.hidden ? ' checked' : '') + '> Включать проект по умолчанию</label></div>'
    + '<div class="setting-row"><label><input id="project-suggest" type="checkbox"' + (project.suggestTasks !== false ? ' checked' : '') + '> Предлагать задачи из сообщений Codex</label></div>'
    + '<div class="setting-row"><label><input id="project-all-chats" type="checkbox"' + (project.projectTasks ? ' checked' : '') + '> Искать задачи во всех чатах проекта</label></div>'
    + '<details class="bridge-settings"><summary>Подключить другого ассистента</summary>'
    + '<label>Инструкция для чата<textarea id="bridge-instruction" readonly rows="4"></textarea></label>'
    + '<button type="button" class="ghost" id="copy-bridge">Скопировать инструкцию</button></details>'
    + '<form id="custom-name"><label>Название своего поля<span class="add-topic"><input name="fieldName" maxlength="55" placeholder="Дополнительное поле" value="' + html(project.customFieldName) + '"><button class="ghost" type="submit">Сохранить</button></span></label></form>'
    + '<label>Пересмотреть проект<input type="date" id="review-on" value="' + html(project.reviewOn) + '"></label>'
    + '<form id="new-topic"><label>Темы проекта<span class="chips" id="topic-chips">'
    + project.topics.map(topic => '<span class="tag">' + html(topic) + '</span>').join('') + '</span>'
    + '<span class="add-topic"><input name="topic" placeholder="Новая тема" required maxlength="55"><button class="ghost" type="submit">Добавить</button></span></label></form>'
    + removeProjectButton(project) + '<p class="form-error" id="form-error" role="alert" hidden></p></div>');
  const help = [
    ['#settings-project', 'Выберите проект, настройки которого хотите изменить.'],
    ['#project-color', 'Нажмите на образец, чтобы выбрать цвет точки. Он появится у названия проекта в фильтре и на карточках.'],
    ['#project-auto', 'Предлагает создать карточку с названием нового чата. Задачи из сообщений можно собирать отдельно.'],
    ['#project-all-chats', 'Проверяет новые сообщения во всех чатах проекта, в том числе ещё без карточек. При первом чтении сохраняется текущая позиция.'],
    ['#project-visible', 'Определяет начальный выбор проекта. Для текущего просмотра отметьте нужные проекты в списке «Проекты» на доске.'],
    ['#project-suggest', 'При обновлении доска ищет конкретные поручения и отмеченные следующие шаги в новых сообщениях отслеживаемых чатов. Распознавание работает локально. Прямая просьба добавить задачу при чтении истории тоже попадёт на рассмотрение.'],
    ['.bridge-settings summary', 'Передайте инструкцию ассистенту с доступом к локальной доске. Он сможет предлагать задачи и запрашивать состояние карточек.'],
    ['#custom-name input', 'Одно текстовое поле для всех карточек проекта, например «Площадка». При переименовании его значения сохраняются.'],
    ['#review-on', 'В выбранный день проект появится в блоке «Требует внимания». Это дата пересмотра всего проекта.'],
    ['#new-topic input', 'Темы группируют задачи внутри проекта. Для карточки можно выбрать одну тему, а тегов может быть несколько.'],
  ];
  for (const [selector, description] of help) {
    const control = modal.querySelector(selector);
    if (!control) continue;
    const label = control.closest('label') || control;
    const tip = document.createElement('p');
    tip.className = 'setting-help';
    tip.textContent = description;
    tip.id = 'hint-' + (control.id || control.name || 'bridge');
    control.setAttribute('aria-describedby', tip.id);
    label.title = description;
    label.after(tip);
  }
  const bridge = state.bridge;
  if (bridge) {
    const instruction = byId('bridge-instruction');
    instruction.value = 'В этом чате работаем с доской проекта ' + project.name + ' (ID ' + project.id + '). '
      + 'Прочитай ' + bridge.skill + '. Запускай ' + bridge.cli + ' через ' + (bridge.node || 'node') + '. Передавай --port ' + bridge.port
      + '. При возобновлении задачи сверь её статус через context. По прямой просьбе добавь карточку через add, '
      + 'для конкретного следующего шага используй suggest. Текст задачи сохраняй на языке разговора.';
    byId('copy-bridge').onclick = async () => {
      try { await navigator.clipboard.writeText(instruction.value); notify('Инструкция скопирована.'); }
      catch { instruction.select(); notify('Текст выделен. Скопируй его в чат ассистента.'); }
    };
  }
  if (byId('settings-project')) byId('settings-project').onchange = event => projectDialog(projectFor(event.target.value));
  const change = async update => {
    try {
      const updated = await api('projects/' + project.id, 'PATCH', update);
      if (update.hidden !== undefined) {
        projectChoices.delete(project.id);
        saveProjectChoices();
      }
      accept(updated);
      if (!modal.open || byId('settings-project') && byId('settings-project').value !== project.id) return;
      const chips = byId('topic-chips');
      if (chips && update.topic !== undefined) {
        chips.innerHTML = projectFor(project.id).topics.map(topic => '<span class="tag">' + html(topic) + '</span>').join('');
        byId('new-topic').reset();
      }
      formError('');
    } catch (error) {
      formError(error.message);
    }
  };
  byId('project-color').onchange = async event => {
    const picker = event.target;
    picker.disabled = true;
    try {
      await change({ color: picker.value });
    } finally {
      picker.value = projectFor(project.id)?.color || project.color;
      picker.disabled = false;
    }
  };
  byId('project-all-chats').onchange = event => change({ projectTasks: event.target.checked });
  byId('project-auto').onchange = event => change({ auto: event.target.checked });
  byId('project-suggest').onchange = event => change({ suggestTasks: event.target.checked });
  byId('custom-name').onsubmit = event => {
    event.preventDefault();
    change({ customFieldName: new FormData(event.target).get('fieldName') });
  };
  byId('project-visible').onchange = event => change({ hidden: !event.target.checked });
  byId('review-on').onchange = event => change({ reviewOn: event.target.value });
  byId('new-topic').onsubmit = event => {
    event.preventDefault();
    change({ topic: new FormData(event.target).get('topic') });
  };
}

async function refresh() {
  try {
    accept(await api('state'));
  } catch {
    byId('sync-state').textContent = 'Доска недоступна';
    byId('sync-state').classList.add('problem');
  }
}

const projectPicker = byId('project-picker');
const projectToggle = byId('project-filter-toggle');
const projectOptions = byId('project-options');
function showProjectOptions(open) {
  projectOptions.hidden = !open;
  projectToggle.setAttribute('aria-expanded', String(open));
}
projectToggle.onclick = () => showProjectOptions(projectOptions.hidden);
projectPicker.onkeydown = event => {
  if (event.key === 'Escape' && !projectOptions.hidden) {
    event.preventDefault();
    showProjectOptions(false);
    projectToggle.focus();
  }
};
document.addEventListener('pointerdown', event => {
  if (!projectOptions.hidden && !projectPicker.contains(event.target)) showProjectOptions(false);
});
projectPicker.onfocusout = event => {
  if (event.relatedTarget && !projectPicker.contains(event.relatedTarget)) showProjectOptions(false);
};
projectOptions.onchange = event => {
  if (!state || !event.target.matches('input[type=checkbox]')) return;
  const input = event.target;
  setProjectFilter(input.id === 'all-projects' ? state.projects.map(p => p.id) : [input.value], input.checked);
};
byId('projects').onclick = event => {
  const button = event.target.closest('button');
  if (!button || !state) return;
  if (button.dataset.hideProject) setProjectFilter([button.dataset.hideProject], false);
  else if (button.dataset.project) projectDialog(projectFor(button.dataset.project));
};

byId('create-project').onclick = () => { if (state) organizeProjects(); };
byId('rename-project').onclick = () => {
  if (!state) return;
  const selected = activeProjects();
  const pending = (state.naming ?? []).find(p => projectVisible(p.projectId));
  renameDialog(selected.length === 1 ? selected[0] : projectFor(pending?.projectId) || selected[0] || state.projects[0]);
};
byId('naming-offers').onclick = event => {
  const remove = event.target.closest('[data-trash-project]');
  if (remove) return removeProject(remove);
  const sort = event.target.closest('[data-sort-project]');
  if (sort) return organizeProjects(projectFor(sort.dataset.sortProject));
  const button = event.target.closest('[data-name-review]');
  if (button) renameDialog(projectFor(button.dataset.nameReview));
};
byId('settings').onclick = () => state && projectDialog(activeProjects()[0] ?? state.projects[0]);
const quickTitle = byId('quick-title');
const composer = byId('quick-task');
function setComposerBusy(busy) {
  composer.toggleAttribute('data-saving', busy);
  quickTitle.readOnly = busy;
  composer.setAttribute('aria-busy', String(busy));
}
function expandDraft() {
  if (!state?.projects.length || composer.hasAttribute('data-saving')) return;
  const project = activeProjects()[0] ?? state.projects[0];
  cardForm(null, project.id, 'planned', quickTitle.value.trim());
  const form = byId('card-form');
  form.dataset.inlineDraft = quickTitle.value;
  (form.elements.projectId && activeProjects().length !== 1 ? form.elements.projectId : form.elements.title).focus();
}

byId('add').onclick = expandDraft;
composer.onsubmit = async event => {
  event.preventDefault();
  if (!state?.projects.length || composer.hasAttribute('data-saving')) return;
  const title = quickTitle.value.trim();
  if (!title) {
    quickTitle.focus();
    return;
  }
  const projects = activeProjects();
  if (projects.length !== 1) {
    expandDraft();
    return;
  }
  setComposerBusy(true);
  try {
    accept(await api('cards', 'POST', { title, projectId: projects[0].id, focusOn: filters.view === 'focus' ? localDay() : '' }));
    quickTitle.value = '';
    notify('Задача добавлена в «В планах».');
  } catch (error) {
    notify(error.message);
  } finally {
    setComposerBusy(false);
  }
};
function checkedDate(at) {
  return fullDate.format(new Date(at)) + ' МСК';
}

function savedDate() {
  return state?.syncedAt ? 'Последняя сверка каталога — ' + checkedDate(state.syncedAt) + '.' : 'Сверка каталога ещё не завершалась.';
}

function checkSummary(check) {
  if (!check) return state?.syncedAt ? savedDate() : 'Открыта сохранённая доска';
  if (check.failed) return 'Codex недоступен. ' + savedDate();
  if (check.localOnly) return 'Обновлено · ' + checkedDate(check.at);
  const parts = ['Codex · ' + checkedDate(check.at)];
  if (check.newChats) parts.push('Новых чатов: ' + check.newChats);
  if (check.replies) parts.push('Чатов с новым ответом: ' + check.replies);
  if (check.newOffers) parts.push('Новых предложений: ' + check.newOffers);
  if (check.issues?.length) parts.push('Недоступная история: ' + check.issues.length);
  if (parts.length === 1) parts.push('Изменений не найдено');
  return parts.join(' · ');
}

function paintCheck() {
  const note = byId('sync-state');
  note.textContent = checkProblem || (checking ? (state?.sync.offline ? 'Обновляем локальную доску…' : 'Проверяем чаты Codex и новые задачи…') : checkSummary(state?.sync.lastCheck));
  note.classList.toggle('problem', Boolean(checkProblem || state?.sync.error));
  byId('sync').disabled = checking;
  byId('sync').setAttribute('aria-busy', String(checking));
}

function sourcesDialog() {
  if (!state) return;
  dialogCard = null;
  const { offline, providers = [], lastCheck: check } = state.sync;
  const detail = offline ? 'Чтение истории Codex отключено для этой доски.'
    : check?.failed ? 'Проверка не завершилась. ' + check.error
    : check && !check.localOnly ? 'Чатов в каталоге: ' + check.listed + '. Проверена история: ' + check.inspected + '.'
    : 'Проверка выполняется при открытии доски и по кнопке «Обновить доску».';
  const issues = check?.issues?.length ? '<p class="help">Недоступна история</p><ul>' + check.issues.map(name => '<li>' + html(name) + '</li>').join('') + '</ul>' : '';
  const journalChats = state.chats.filter(chat => chat.historySource === 'journal' && !chat.historyIssue);
  const journalInfo = journalChats.length ? '<p class="help">Из локального журнала Codex читаются новые завершённые сообщения следующих чатов. Предыстория родительской ветки недоступна.</p><ul>'
    + journalChats.map(chat => '<li>' + html(chat.title) + '</li>').join('') + '</ul>' : '';
  const gaps = state.chats.filter(chat => chat.historyGapAt);
  const gapInfo = gaps.length ? '<p class="help">Codex изменил историю. Для этих чатов доска сохранила новую позицию. В промежутке могли остаться предложения.</p><ul>'
    + gaps.map(chat => '<li>' + html(chat.title) + ' · ' + html(checkedDate(chat.historyGapAt)) + '</li>').join('') + '</ul>' : '';
  const historical = state.chats.filter(chat => chat.historyReview?.status === 'read');
  const missingHistory = state.chats.filter(chat => chat.historyReview?.status === 'unavailable');
  const historyNote = '<p class="help">Разобрана прежняя переписка: ' + historical.length + ' чатов. Предложений из истории ждут решения: '
    + state.proposals.filter(p => p.source.history).length + '.</p>' + (missingHistory.length ? '<p class="help">Не удалось разобрать историю: '
    + missingHistory.map(c => html(c.title)).join(', ') + '.</p>' : '');
  const rows = providers.map(p => '<li><strong>' + html(p.name) + '</strong> · '
    + [p.submitted && 'передавал задачи', p.requested && 'запрашивал состояние карточек'].filter(Boolean).join(' · ') + '</li>').join('');
  showDialog('Источники доски', '<div id="source-report" class="modal-inner"><section><h3>Чаты → доска</h3><p>Codex · '
    + html(detail) + '</p><p class="help">' + html(savedDate()) + '</p>' + issues + journalInfo + gapInfo + historyNote + '</section><section><h3>Обмен по команде</h3>'
    + (rows ? '<ul>' + rows + '</ul>' : '<p>Обращений от других ассистентов пока нет.</p>')
    + '<p class="help">Claude Code, Kimi и другие клиенты появляются здесь после первой команды к доске. Инструкция находится в настройках проекта.</p></section>'
    + '<section><h3>Доска → чат</h3><p>Ассистент получает текущую колонку и следующий шаг, когда запрашивает карточку. «Продолжить в чате» передаёт эти данные в Codex и запускает работу по вашей кнопке.</p></section>'
    + '<section><h3>Перенос доски</h3><p>Сохраните базу и настройки папок проектов для другого компьютера.</p><button class="ghost" id="board-backup">Сохранить копию</button><p id="backup-location" role="status"></p></section></div>');
  byId('board-backup').onclick = async event => {
    const button = event.currentTarget;
    const location = byId('backup-location');
    button.disabled = true;
    try { location.textContent = 'Копия сохранена в ' + (await api('backup', 'POST')).folder; }
    catch (error) { location.textContent = error.message; }
    finally { button.disabled = false; }
  };
}

async function checkBoard(full = false) {
  if (checking) return;
  checking = true;
  checkProblem = '';
  paintCheck();
  try {
    const next = await api('sync', 'POST', { full });
    accept(next);
    if (modal.open && byId('source-report')) sourcesDialog();
  } catch (error) {
    checkProblem = 'Не удалось обновить доску. ' + (state ? savedDate() : error.message);
  } finally {
    checkedInTab = Date.now();
    checking = false;
    paintCheck();
  }
}
byId('sources').onclick = sourcesDialog;
byId('sync').onclick = () => checkBoard(true);
const views = document.querySelector('.views');
const highlight = views.querySelector('.view-highlight');
let lastHighlighted;
let lastNavWidth;
function placeHighlight() {
  const button = views.querySelector('[aria-pressed="true"]');
  if (!button) return;
  if (lastHighlighted !== button || lastNavWidth !== views.clientWidth) {
    const right = button.offsetLeft + button.offsetWidth + 3;
    if (button.offsetLeft < views.scrollLeft) views.scrollLeft = button.offsetLeft - 3;
    else if (right > views.scrollLeft + views.clientWidth) views.scrollLeft = right - views.clientWidth;
    lastHighlighted = button;
    lastNavWidth = views.clientWidth;
  }
  highlight.style.width = button.offsetWidth + 'px';
  highlight.style.height = button.offsetHeight + 'px';
  highlight.style.transform = 'translate(' + button.offsetLeft + 'px, ' + button.offsetTop + 'px)';
  views.classList.add('positioned');
}
const viewResize = new ResizeObserver(placeHighlight);
viewResize.observe(views);
for (const button of views.querySelectorAll('button')) viewResize.observe(button);
document.fonts.ready.then(placeHighlight);

for (const view of Object.keys(viewNames)) {
  byId(view + '-view').onclick = () => { if (filters.view !== view) location.hash = view; };
}
window.addEventListener('hashchange', () => {
  const view = currentView();
  if (filters.view === view) return;
  if (view === 'inbox' || filters.view === 'inbox') byId('search').value = filters.search = '';
  filters.view = view;
  if (!state) return;
  render();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    content.animate([{ opacity: .65, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: 170, easing: 'ease-out' });
  }
});
byId('nearest').onclick = event => {
  const id = event.target.closest('[data-deadline-card]')?.dataset.deadlineCard;
  const card = state?.cards.find(card => card.id === id);
  if (card) cardForm(card, card.projectId);
};
byId('attention').onclick = () => { filters.attention = !filters.attention; if (state) render(); };
content.onchange = event => {
  if (event.target.dataset.offerColumn) offerColumns.set(event.target.dataset.offerColumn, event.target.value);
};
async function decideSuggestion(button) {
  if (button.disabled) return;
  const controls = [...button.parentElement.querySelectorAll('button')];
  const id = button.dataset.accept || button.dataset.dismiss;
  const column = offerColumns.get(id) || 'planned';
  const keyboard = button.matches(':focus-visible');
  const rowIndex = [...content.querySelectorAll('.suggestion-row')].indexOf(button.closest('.suggestion-row'));
  controls.forEach(control => { control.disabled = true; });
  try {
    accept(await api('proposals/' + id + '/' + (button.dataset.accept ? 'add' : 'dismiss'), 'POST',
      button.dataset.accept ? { status: column } : {}));
    offerColumns.delete(id);
    notify(button.dataset.accept ? 'Задача добавлена на доску.' : 'Предложение пропущено.');
    if (keyboard && filters.view === 'inbox' && document.activeElement === document.body) {
      const remaining = content.querySelectorAll('[data-accept]');
      (remaining[Math.min(rowIndex, remaining.length - 1)] ?? byId('inbox-view')).focus({ preventScroll: true });
    }
  } catch (error) {
    notify(error.message);
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}
byId('tag-filter').onchange = event => { filters.tag = event.target.value; if (state) render(); };
byId('topic-filter').onchange = event => { filters.topic = event.target.value; if (state) render(); };
byId('search').oninput = event => { filters.search = event.target.value; if (state) render(); };

content.onclick = async event => {
  const button = event.target.closest('button') ?? event.target.closest('.card')?.querySelector('.card-title');
  if (!button || !state) return;
  const action = button.dataset;
  if (button.hasAttribute('data-review-drafts')) return openDraftQueue();
  if (action.confirmChat) {
    button.disabled = true;
    const name = projectFor(action.destination)?.name;
    try {
      accept(await api('unassigned/assign', 'POST', { chatId: action.confirmChat, toProjectId: action.destination, confirmRecommendation: true }));
      notify('Чат перенесён в «' + name + '».');
    } catch (error) { notify(error.message); button.disabled = false; }
    return;
  }
  if (action.assignChat) {
    const chat = state.unassignedChats.find(c => c.id === action.assignChat && !c.deletedAt);
    if (chat) assignChatDialog(chat);
    return;
  }
  if (action.skipUnassigned || action.restoreUnassigned) {
    button.disabled = true;
    try {
      const restore = Boolean(action.restoreUnassigned);
      accept(await api('unassigned/' + (restore ? 'restore' : 'dismiss'), 'POST', { chatId: action.restoreUnassigned || action.skipUnassigned }));
      notify(restore ? 'Чат возвращён в «Неразобранные задачи».' : 'Чат пропущен. Его можно вернуть из корзины.');
    } catch (error) { notify(error.message); button.disabled = false; }
    return;
  }
  if (action.moveChat) {
    const chat = findChat(action.moveChat);
    if (chat) organizeProjects(projectFor(chat.projectId), chat.id);
    return;
  }
  if (action.snooze) return snoozeDialog(action.kind, action.snooze);
  if (action.preview) return previewProposal(action.preview);
  if (action.wake) {
    button.disabled = true;
    try {
      accept(await api('snooze', 'POST', { kind: action.kind, id: action.wake, until: '' }));
      notify(action.kind === 'project' ? 'Проект возвращён.' : 'Задача возвращена.');
    } catch (error) { notify(error.message); button.disabled = false; }
    return;
  }
  if (action.accept || action.dismiss) return decideSuggestion(button);
  if (button.hasAttribute('data-show-projects')) {
    setProjectFilter(state.projects.map(p => p.id), true);
    return;
  }
  if (action.focus) {
    const card = state.cards.find(card => card.id === action.focus);
    if (!card) return;
    button.disabled = true;
    try {
      const today = localDay();
      const focusOn = card.focusOn === today ? '' : today;
      accept(await api('cards/' + card.id, 'PATCH', { focusOn }));
      notify(focusOn ? 'Задача в фокусе на сегодня.' : 'Задача убрана из фокуса.');
    } catch (error) {
      notify(error.message);
      button.disabled = false;
    }
  }
  if (action.open || action.pullDescription) {
    const card = state.cards.find(card => card.id === (action.open || action.pullDescription));
    if (!card) return;
    const form = cardForm(card, card.projectId);
    if (form && action.pullDescription) {
      form.elements.description.focus();
      form.querySelector('[data-pull]').click();
    }
    return;
  }
  if (action.add) cardForm(null, (activeProjects()[0] ?? state.projects[0])?.id, action.add);
  if (action.reviewProject) projectDialog(projectFor(action.reviewProject));
  if (action.restoreProject || action.restore || action.restoreChat) {
    button.disabled = true;
    try {
      if (action.restoreProject) {
        accept(await api('projects/' + action.restoreProject + '/restore', 'POST'));
        setProjectFilter([action.restoreProject], true);
        notify('Проект возвращён на доску.');
      } else if (action.restoreChat) {
        const chat = state.trashedChats.find(c => c.id === action.restoreChat);
        accept(await api('chats/restore', 'POST', { fromProjectId: chat.projectId, chatIds: [chat.id] }));
        notify('Чат возвращён в свой проект.');
      } else {
        accept(await api('cards/' + action.restore + '/restore', 'POST'));
        notify('Карточка возвращена на доску.');
      }
    } catch (error) {
      notify(error.message);
      button.disabled = false;
    }
  }
  if (action.chatTask) {
    const chat = findChat(action.chatTask);
    if (chat) {
      cardForm(null, chat.projectId);
      const form = byId('card-form');
      form.elements.chatId.value = chat.id;
      form.elements.chatId.dispatchEvent(new Event('change'));
    }
  }
  if (action.import) {
    const chat = findChat(action.import);
    button.disabled = true;
    try {
      accept(await api('cards', 'POST', { projectId: chat.projectId, chatId: chat.id }));
      const card = state.cards.find(card => card.chatId === chat.id);
      if (card) cardForm(card, card.projectId);
    } catch (error) {
      notify(error.message);
      button.disabled = false;
    }
  }
};

modal.onclick = async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.trashProject) return removeProject(button);
  if (button.dataset.snooze) return snoozeDialog(button.dataset.kind, button.dataset.snooze);
  if ('close' in button.dataset) modal.close();
  if ('reply' in button.dataset) {
    const activeCard = dialogCard;
    const chatId = byId('reply-chat').value;
    button.disabled = true;
    formError('');
    try {
      const answer = await api('cards/' + activeCard + '/reply?chat=' + encodeURIComponent(chatId));
      if (activeCard !== dialogCard || byId('reply-chat')?.value !== chatId) return;
      const preview = byId('reply-preview');
      preview.textContent = answer.text;
      preview.dataset.replyId = answer.id;
      preview.dataset.thread = chatId;
      preview.hidden = false;
    } catch (error) {
      formError(error.message);
    } finally {
      button.disabled = false;
    }
  }
  if (button.dataset.seen) {
    try {
      accept(await api('cards/' + dialogCard, 'PATCH', { seen: button.dataset.seen, seenChatId: byId('reply-chat').value }));
    } catch (error) {
      formError(error.message);
    }
  }
};
modal.addEventListener('close', () => {
  const id = dialogCard;
  dialogCard = null;
  if (id && document.activeElement === document.body) {
    (content.querySelector('[data-open="' + CSS.escape(id) + '"]') ?? byId('add')).focus({ preventScroll: true });
  }
});

content.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-card]');
  if (!card) return;
  dragged = card.dataset.card;
  byId('snooze-drop').hidden = false;
  event.dataTransfer.setData('text/plain', dragged);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
content.addEventListener('dragover', event => {
  const column = event.target.closest('[data-column]');
  if (!dragged || !column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const previous = content.querySelector('.column.over');
  if (previous !== column) previous?.classList.remove('over');
  column.classList.add('over');
});
content.addEventListener('dragend', () => {
  dragged = null;
  byId('snooze-drop').hidden = true;
  content.querySelector('.column.over')?.classList.remove('over');
  content.querySelector('.card.dragging')?.classList.remove('dragging');
});
content.addEventListener('drop', async event => {
  const column = event.target.closest('[data-column]');
  if (!dragged || !column) return;
  event.preventDefault();
  const id = dragged;
  const status = column.dataset.column;
  dragged = null;
  byId('snooze-drop').hidden = true;
  column.classList.remove('over');
  content.querySelector('.card.dragging')?.classList.remove('dragging');
  try {
    accept(await api('cards/' + id, 'PATCH', { status }));
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      content.querySelector('[data-card="' + CSS.escape(id) + '"]')?.animate(
        [{ transform: 'translateY(-5px)', opacity: .75 }, { transform: 'translateY(0)', opacity: 1 }],
        { duration: 200, easing: 'ease-out' });
    }
  } catch (error) {
    notify(error.message);
  }
});

for (const target of [byId('snooze-drop'), byId('snoozed-view')]) {
  target.addEventListener('dragover', event => {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  target.addEventListener('drop', event => {
    if (!dragged) return;
    event.preventDefault();
    const id = dragged;
    dragged = null;
    byId('snooze-drop').hidden = true;
    snoozeDialog('card', id);
  });
}

byId('waiting-list').onclick = async event => {
  const button = event.target.closest('[data-answered]');
  const question = button && state.answerRequests.find(q => q.id === button.dataset.answered);
  if (!question) return;
  button.disabled = true;
  try {
    const { projectId, provider, session, event: questionId } = question;
    await api('bridge/questions', 'POST', { projectId, action: 'answered', source: { provider, session, event: questionId } });
    await refresh();
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
};

async function openBoard() {
  if (openCheckStarted || document.visibilityState === 'hidden') return;
  openCheckStarted = true;
  await refresh();
  await checkBoard();
}
function markAway() { awaySince ??= Date.now(); }
function resumeBoard() {
  if (document.hidden) return;
  const away = awaySince;
  awaySince = null;
  if (!openCheckStarted) openBoard();
  else if (away !== null && Date.now() - Math.max(away, checkedInTab) >= resumeDelay) checkBoard();
  else if (state && away !== null) refresh();
  else if (state) render();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) markAway(); else resumeBoard(); });
window.addEventListener('blur', markAway);
window.addEventListener('focus', resumeBoard);
window.addEventListener('pageshow', event => { if (event.persisted) checkBoard(); });
openBoard();
// Keep local dates and elapsed-time labels accurate while the page stays open.
setInterval(() => { if (!document.hidden && !dragged && state) render(); }, 60_000);
