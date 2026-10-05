import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, status, fingerprint } from './controller.mjs';
import { jobStatus } from './background.mjs';
import { assertNoWorkers } from './recovery.mjs';
import { execute } from './process.mjs';
import { canonical, inside } from './policy.mjs';

const defaults = { maxFiles: 1000, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024 };
const names = { A: 'Добавлен', M: 'Изменён', D: 'Удалён', T: 'Изменён тип' };

async function readGit(repo, args, maxOutputBytes = 4 * 1024 * 1024) {
  const result = await execute(['git', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.quotePath=false', ...args], { cwd: repo.root, timeout: 30, maxOutputBytes });
  if (result.limited) return { limited: true };
  if (result.code !== 0 || result.timedOut || result.cancelled) throw new Error(`Не удалось прочитать ${repo.id}: ${result.err.trim() || 'Git прерван'}`);
  return { text: result.out };
}

function newFile(repo, name, limit) {
  const file = path.join(repo.root, name);
  if (!inside(repo.root, file) || !inside(repo.root, canonical(path.dirname(file)))) throw new Error('Путь нового файла выходит за пределы worktree');
  const info = fs.lstatSync(file);
  if (!info.isFile() && !info.isSymbolicLink()) return { message: 'Особый тип файла: просмотр содержимого недоступен.', limited: true };
  if (info.size > limit) return { message: 'Файл превышает лимит просмотра.', limited: true };
  // A symlink is reviewed as its target name, never as the target's contents.
  let bytes;
  if (info.isSymbolicLink()) bytes = Buffer.from(fs.readlinkSync(file));
  else {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(limit + 1), length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (length > limit) return { message: 'Файл вырос сверх лимита просмотра.', limited: true };
      bytes = buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
  }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary or another encoding. */ }
  if (content === undefined || bytes.includes(0)) return { message: `Двоичный файл / другая кодировка · ${bytes.length} байт. Текстовый diff недоступен.`, binary: true };
  const lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
  const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644';
  const header = `diff --git ${JSON.stringify(`a/${name}`)} ${JSON.stringify(`b/${name}`)}\nnew file mode ${mode}\n--- /dev/null\n+++ ${JSON.stringify(`b/${name}`)}\n`;
  const patch = lines.length ? `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}` : header;
  return { patch, message: lines.length ? '' : 'Новый пустой файл.', additions: lines.length, deletions: 0 };
}

function patchCounts(patch) {
  let additions = 0, deletions = 0, hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) hunk = true;
    else if (hunk && line.startsWith('+')) additions++;
    else if (hunk && line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

// The preview holds bounded, immutable patches from the task's original base,
// including staged, unstaged, published and untracked changes. Never uses HEAD
// as the comparison base, never stages files and never launches a model.
export async function loadHumanReview(profilePath, id, options = {}) {
  const limits = { ...defaults, ...options };
  const profile = loadProfile(profilePath), state = status(profilePath, id), dir = path.join(profile.stateRoot, id);
  if (!['ready_for_user', 'accepted', 'blocked'].includes(state.status)) throw new Error('Ревью доступно после завершения цикла.');
  if (jobStatus(profilePath, id)?.alive) throw new Error('Дождись завершения текущего этапа.');
  assertNoWorkers(dir);
  const warnings = [], files = [];
  const before = await fingerprint(state.snapshot);
  let used = 0, complete = true;
  for (const repo of state.snapshot.repos) {
    if (canonical(repo.root) !== repo.root) throw new Error(`Изменился путь worktree ${repo.id}`);
    const tracked = await readGit(repo, ['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', repo.base, '--']);
    const untracked = await readGit(repo, ['ls-files', '-z', '--others', '--exclude-standard']);
    if (tracked.limited || untracked.limited) throw new Error(`Список файлов ${repo.id} превышает лимит просмотра.`);
    const fields = tracked.text.split('\0').filter(Boolean), entries = new Map();
    for (let i = 0; i < fields.length; i += 2) entries.set(fields[i + 1], { status: fields[i] });
    for (const name of untracked.text.split('\0').filter(Boolean)) if (!entries.has(name)) entries.set(name, { status: 'A', untracked: true });
    for (const [name, entry] of entries) {
      if (files.length >= limits.maxFiles) { complete = false; break; }
      const item = { repo: repo.id, path: name, root: repo.root, status: entry.status, label: names[entry.status] ?? entry.status, additions: 0, deletions: 0 };
      const available = Math.min(limits.fileBytes, limits.totalBytes - used);
      if (available < 1) Object.assign(item, { message: 'Достигнут общий лимит просмотра.', limited: true });
      else try {
        if (entry.untracked) Object.assign(item, newFile(repo, name, available));
        else {
          const diff = await readGit(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=5', repo.base, '--', name], available);
          if (diff.limited) Object.assign(item, { message: 'Diff превышает лимит просмотра.', limited: true });
          else if (/^Binary files /m.test(diff.text)) Object.assign(item, { message: 'Двоичный файл. Текстовый diff недоступен.', binary: true });
          else Object.assign(item, { patch: diff.text, ...patchCounts(diff.text), message: /^@@ /m.test(diff.text) ? '' : 'Изменение метаданных файла.' });
        }
      } catch (error) { Object.assign(item, { message: error.message, limited: true }); }
      if (Buffer.byteLength(item.patch ?? '') > available) {
        delete item.patch; item.message = 'Diff превышает лимит просмотра.'; item.limited = true;
      }
      used += Buffer.byteLength(item.patch ?? '');
      if (item.limited) complete = false;
      files.push(item);
    }
  }
  const after = await fingerprint(state.snapshot), current = status(profilePath, id);
  const matches = before === after && after === state.reviewedFingerprint
    && current.digest === state.digest && current.reviewedFingerprint === state.reviewedFingerprint && current.status === state.status;
  if (!matches) warnings.push('Файлы или результат изменились после ревью. Приёмка отключена; верни задачу Builder для нового прохода.');
  if (!complete) warnings.push('Часть изменений недоступна для просмотра. Приёмка в этом экране отключена.');
  const acceptReason = state.status === 'accepted' ? 'Результат уже принят. Повторная приёмка не требуется.'
    : state.status !== 'ready_for_user' ? 'Цикл ещё не завершён успешно. Верни задачу на исправление.'
    : !matches ? 'Файлы или результат изменились после ревью. Нужен новый проход проверок.'
    : !complete ? 'Diff показан не полностью. Приёмка недоступна.' : undefined;
  return { id, digest: state.digest, fingerprint: state.reviewedFingerprint, status: state.status, round: state.round,
    acceptReason, acceptedAt: state.acceptedAt,
    files, warnings, complete, canAccept: state.status === 'ready_for_user' && matches && complete,
    canFeedback: ['ready_for_user', 'blocked'].includes(state.status),
    summary: state.review?.summary ?? 'Заключения Reviewer пока нет.', findings: state.review?.findings ?? [],
    checks: state.checkResults ?? [], repositories: state.snapshot.repos.map(repo => ({ id: repo.id, branch: repo.branch, base: repo.base })),
    jiraUpdate: state.snapshot.publication.jiraUpdate };
}
