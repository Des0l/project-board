import { newCard } from './model.mjs';

import { ingest } from './tasks.mjs';

export function seedDemo(board) {
  if (!board.demoSuggestionsSeeded) {
    ingest(board, { projectId: 'atlas', title: 'Уточнить часы работы музея', mode: 'suggest',
      description: 'Для субботнего маршрута нужно время последнего входа.',
      source: { provider: 'Чат редакции', session: 'Осенний выпуск', event: 'museum-hours' } });
    const atlas = board.projects.find(project => project.id === 'atlas');
    if (atlas) atlas.customFieldName ??= 'Выпуск';
    const cover = board.cards.find(card => card.projectId === 'atlas' && card.title === 'Согласовать обложку путеводителя');
    if (cover) {
      cover.tags ??= ['печать'];
      cover.customValue ??= '04 · Осень';
    }
    board.demoSuggestionsSeeded = true;
  }
  if (board.demoSeeded) return;
  const now = Date.now();
  const day = 86_400_000;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
  const samples = [
    ['atlas', 'planned', 'Собрать маршруты для осеннего выпуска', 'Отобрать три прогулки и проверить длительность каждой.', 'Редакция', 1, 5],
    ['studio', 'planned', 'Придумать заставку для интервью', 'Собрать короткие музыкальные фрагменты.', 'Звук', 2],
    ['studio', 'queued', 'Сверстать титры первого выпуска', 'Уточнить написание имён у редактора.', 'Видео', 1, 3],
    ['atlas', 'active', 'Проверить карту на телефоне', 'Проверить маршрут от набережной до музея.', 'Дизайн', 4, 1],
    ['studio', 'active', 'Свести звук интервью', 'Выровнять громкость двух микрофонов.', 'Звук', 1, 2],
    ['atlas', 'review', 'Согласовать обложку путеводителя', 'Выбрать один из двух вариантов для печати.', 'Дизайн', 8, -1],
    ['atlas', 'done', 'Подготовить фотографии маршрута', '', 'Редакция', 2],
  ];
  for (const [project, status, title, next, topic, age, due] of samples) {
    const card = newCard(board, project, title);
    Object.assign(card, { status, next, topic, statusSince: new Date(now - age * day).toISOString() });
    if (status === 'review') { card.tags = ['печать']; card.customValue = '04 · Осень'; }
    if (due !== undefined) card.dueOn = calendar.format(new Date(now + due * day));
    if (status === 'review') card.focusOn = calendar.format(new Date(now));
  }
  board.demoSeeded = true;
}
