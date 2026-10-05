export const knowledgeNames = { empty: 'предложений нет', awaiting_acceptance: 'после приёмки кода', proposed: 'предложения', approved: 'одобрено', rejected: 'отклонено',
  running: 'Builder обновляет базу', ready: 'готов diff', failed: 'прервано', capture_failed: 'ошибка снимка кода',
  publishing: 'публикация', publication_failed: 'публикация прервана', published: 'опубликовано' };
export const knowledgeLabel = k => k ? knowledgeNames[k.status] ?? k.status : 'предложения';
export function knowledgeDocument(k, selected) {
  return `# База знаний · ${knowledgeLabel(k)}\n\nОбновление базы необязательно. Приёмка и публикация кода выполняются независимо.\n\n` +
    (k.error || k.job?.error ? `**${k.error ?? k.job.error}**\n\n` : '') +
    (k.proposals?.length ? k.proposals.map((p, i) => `## ${i + 1}. ${selected.has(p.id) ? '[x]' : '[ ]'} ${p.title}\n\nФайлы: ${p.paths.join(', ')}\n\n${p.reason}\n\nОснование: ${p.evidence}`).join('\n\n') : 'Предложений для базы нет.') +
    (k.approval ? '\n\nВыбранные предложения одобрены. Builder пишет только эти файлы в отдельном worktree.' : '') +
    (k.summary ? `\n\n## Результат Builder\n\n${k.summary}` : '') +
    (k.checks ? `\n\n## Проверки базы\n\nПроверены разрешённые пути, обычные текстовые файлы и неизменность diff во время проверок.\n\n${k.checks.map(x => `- ${x.passed ? '✓' : '✗'} ${x.argv.join(' ')}`).join('\n')}` : '') +
    (k.diff ? `\n\n## Diff базы\n\n\`\`\`diff\n${k.diff}\n\`\`\`` : '') +
    (k.status === 'ready' && !k.files?.length ? '\n\nИзменений базы нет. Публикация не требуется.' : '');
}
export function knowledgePublicationDocument(p) {
  return `# ${p.done ? '✓ ' : ''}Публикация базы · ${p.mode === 'push' ? 'коммит и push' : 'локальный коммит'}\n\n` +
    p.targets.map(t => `## ${t.kind === 'kb' ? 'База знаний' : 'Ссылка на сабмодуль в CC'}\n\nВетка: ${t.branch}\n\nБаза: ${t.base}\n\nСообщение: ${t.message}\n\n${t.url ? 'Push: ' + t.url : 'Только локальный коммит.'}\n\n${p.records?.[t.kind]?.head ?? ''}`).join('\n\n') +
    '\n\nКонтроллер сначала публикует базу, затем коммит CC с обновлённым gitlink. Основные checkout сохраняются.\n\n' +
    `Gitlink ${p.submodule}: ${p.oldPin} → ${p.records?.kb?.head ?? 'коммит показанного diff (SHA появится после создания)'}\n` +
    `\n\n\`\`\`diff\n${p.diff}\n\`\`\``;
}
