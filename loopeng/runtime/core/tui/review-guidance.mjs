// Shared wording for the OpenCode reader and its exported editor snapshot.
export function reviewGuidance(review) {
  if (review.status === 'accepted') return {
    status: 'Принято',
    reason: 'Результат уже принят. Повторная приёмка не требуется.',
    next: 'Результат уже принят. Можно закрыть просмотр: q / Esc.',
    editor: ':q → OpenCode. Результат уже принят; повторная приёмка не нужна.',
    statusline: ' :q -> OpenCode | Результат уже принят ',
  };
  if (review.canAccept) return {
    status: 'Ждёт твоей приёмки',
    next: 'Всё устраивает: a · Принять результат. Нужны исправления: f · Замечания.',
    editor: ':q → OpenCode, затем a → Принять результат или f → Замечания. Приёмка — всей задачи.',
    statusline: ' :q -> OpenCode | затем a: принять задачу / f: замечания ',
  };
  const reason = review.acceptReason ?? (review.complete === false
    ? 'Diff показан не полностью. Приёмка недоступна.'
    : 'Приёмка недоступна. Проверь состояние задачи и результаты проверок.');
  return {
    status: 'Приёмка недоступна', reason,
    next: reason + (review.canFeedback ? ' f · Вернуть с замечаниями.' : ''),
    editor: ':q → OpenCode. ' + reason + (review.canFeedback ? ' f → Замечания.' : ''),
    statusline: ' :q -> OpenCode | Приёмка недоступна ',
  };
}
