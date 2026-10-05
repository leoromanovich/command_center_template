import fs from 'node:fs';
import path from 'node:path';

export function codeBlock(value, language = '') {
  const text = String(value ?? '');
  const length = Math.max(3, ...[...text.matchAll(/`+/g)].map(x => x[0].length + 1));
  const fence = '`'.repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}
const inline = value => String(value ?? '').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const yesNo = value => value ? 'да' : 'нет';

export function planDocument(state) {
  return `${state.snapshot.plan}\n\n---\n\n## Рабочие репозитории\n\n${state.snapshot.repos.map(repo =>
    `### ${inline(repo.id)}\n\nВетка: **${inline(repo.branch)}**\n\n${codeBlock(repo.root)}\n\nБазовый commit:\n\n${codeBlock(repo.base)}`).join('\n\n')}\n\n## Согласованные действия\n\n- Commit: **${yesNo(state.snapshot.publication.git?.commit)}**\n- Push: **${yesNo(state.snapshot.publication.git?.push)}**\n- Merge request: **${yesNo(state.snapshot.publication.mergeRequest)}**\n- Jira: **${yesNo(state.snapshot.publication.jiraUpdate)}**\n\n${state.snapshot.publication.git?.push ? codeBlock(JSON.stringify(state.snapshot.publication.git.targets, null, 2), 'json') + '\n\n' : ''}Digest этого плана:\n\n${codeBlock(state.digest)}`;
}

export function resultDocument(state, dir) {
  return `# Результат ${inline(state.id)}\n\n${state.review?.summary ?? ''}\n\n## Замечания Reviewer\n\n${state.review?.findings?.length ? state.review.findings.map(x =>
    `### ${inline(x.severity)} · ${inline(x.repository)} / ${inline(x.path)}\n\n${x.reason}\n\n**Исправление:** ${x.fix}`).join('\n\n') : 'Замечаний нет.'}\n\n## Файлы результата\n\n${codeBlock(path.join(dir, 'changes.diff'))}\n\nПроверенный fingerprint:\n\n${codeBlock(state.reviewedFingerprint)}`;
}

// Read complete records from a bounded tail, rather than slicing a UTF-8 command mid-line.
function tail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, offset = Math.max(0, size - maxBytes);
    const data = Buffer.alloc(size - offset); fs.readSync(fd, data, 0, data.length, offset);
    const text = data.toString('utf8');
    return { text: offset ? text.slice(text.indexOf('\n') + 1) : text, clipped: offset > 0 };
  } finally { fs.closeSync(fd); }
}

export function commandDocument(dir, { limit = 200, maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = path.join(dir, 'commands.jsonl');
  if (!fs.existsSync(file)) {
    const legacy = path.join(dir, 'commands.log');
    if (!fs.existsSync(legacy)) return { content: '# Журнал команд\n\nКоманд пока нет.', source: file };
    const data = tail(legacy, maxBytes);
    return { content: `# Журнал команд\n\nИсторический текстовый журнал${data.clipped ? ' (ограниченный хвост)' : ''}.\n\n${codeBlock(data.text)}`, source: legacy };
  }
  const data = tail(file, maxBytes), entries = new Map(); let malformed = 0;
  for (const line of data.text.split('\n').filter(Boolean)) {
    let item; try { item = JSON.parse(line); } catch { malformed++; continue; }
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') { malformed++; continue; }
    const previous = entries.get(item.id) ?? {};
    entries.set(item.id, { ...previous, ...item, firstAt: previous.firstAt ?? item.at,
      wasStarted: previous.wasStarted || item.phase === 'started' });
  }
  const selected = [...entries.values()].slice(-limit).reverse();
  const count = `Команд: ${selected.length} · новые сверху · одна запись на вызов.`;
  const notes = [data.clipped || entries.size > limit ? 'Показан хвост журнала. Полная история сохранена в файле ниже.' : '',
    malformed ? `Неполных/повреждённых записей пропущено: ${malformed}.` : ''].filter(Boolean).join('\n\n');
  const content = selected.map(item => {
    const outcome = item.phase === 'finished' ? (item.status === 'rejected' ? 'ОТКЛОНЕНО' :
      ['cancelled', 'timeout', 'output_limit', 'spawn_error', 'error'].includes(item.status) ? `ПРЕРВАНО · ${item.status}` :
      item.exit_code === 0 ? 'OK' : item.exit_code != null ? `ОШИБКА · exit ${item.exit_code}` : item.status ?? 'исход неизвестен')
      : item.phase === 'reconciled' ? 'ИСХОД ПРОВЕРЕН' : item.wasStarted ? 'ЗАПУЩЕНО · исход пока неизвестен' : 'ЗАПРОШЕНО';
    const duration = item.duration_ms == null ? '' : ` · ${(item.duration_ms / 1000).toFixed(2)} с`;
    const time = item.firstAt?.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') ?? '';
    const command = item.command ?? item.argv?.map(String).map(arg => /^[A-Za-z0-9_./:@=+-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ') ?? '(команда не записана)';
    return `## ${inline(outcome)} · ${inline(item.actor ?? 'controller')}${duration}\n\n${inline(time)}${item.round ? ` · проход ${item.round}` : ''} · ${inline(item.kind ?? '')}\n\n${codeBlock(command, item.command ? 'bash' : '')}\n\n**Каталог:** ${inline(item.container_cwd ?? item.cwd ?? '')}${item.error ? `\n\n**Причина:**\n\n${codeBlock(item.error)}` : ''}${item.log ? `\n\n**Вывод:** ${inline(item.log)}` : ''}`;
  }).join('\n\n---\n\n');
  return { content: `# Журнал команд\n\n${count}\n\n${notes}\n\n${content || 'Команд пока нет.'}`, source: file };
}
