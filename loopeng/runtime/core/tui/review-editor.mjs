import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reviewGuidance } from './review-guidance.mjs';

function available(name, env) {
  return (env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

export function editorArgv(configured, file, env = process.env, review = {}) {
  const argv = configured ?? [available('nvim', env) ? 'nvim' : 'vim'];
  if (!Array.isArray(argv) || !argv.length || !argv[0] || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('reviewEditor должен быть массивом: ["nvim"] или ["code", "--wait"].');
  }
  const name = path.basename(argv[0]).replace(/\.exe$/i, '');
  if (['nvim', 'vim', 'vi', 'view', 'nview'].includes(name)) return [...argv, '-n', '-R', '-i', 'NONE',
    '--cmd', 'set nomodeline', '-c', 'setlocal buftype=nofile bufhidden=wipe noswapfile readonly nomodifiable filetype=diff',
    '-c', 'set laststatus=2', '-c', `let &l:statusline = '${reviewGuidance(review).statusline}'`, '--', file];
  if (['code', 'code-insiders', 'codium', 'cursor'].includes(name)) return [...argv, ...(argv.includes('--wait') ? [] : ['--wait']), file];
  return [...argv, file];
}

export function reviewPatch(review, selected) {
  const files = selected ? review.files.filter(file => file.repo === selected.repo && file.path === selected.path) : review.files;
  if (selected && files.length !== 1) throw new Error('Выбранный файл отсутствует в открытом ревью.');
  const line = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
  const guidance = reviewGuidance(review);
  return [`# Command Center: ${line(review.id)} — ${guidance.status}`, `# ${guidance.editor}`,
    '# Клавиши a/f работают после возврата в OpenCode. Закрытие редактора ничего не принимает.',
    '# Снимок diff. Worktree не изменяется.',
    `# План: ${line(review.digest)}`, ...review.warnings.map(warning => `# ${line(warning)}`), '',
    ...files.flatMap(file => [`# ${line(file.repo)}/${line(file.path)} — ${line(file.label)}`,
      `# База: ${line(review.repositories.find(repo => repo.id === file.repo)?.base)}`,
      ...(file.message ? [`# ${line(file.message)}`] : []), file.patch ?? '# Текстовый diff недоступен.', '']),
  ].join('\n');
}

export async function runEditorProcess(renderer, argv, cwd) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Открой ./start в интерактивном терминале.');
  if (!renderer?.suspend || !renderer?.resume) throw new Error('Версия OpenCode не поддерживает передачу терминала редактору.');
  const interrupt = () => {};
  renderer.suspend(); process.on('SIGINT', interrupt);
  try {
    renderer.currentRenderBuffer?.clear();
    await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: 'inherit', shell: false });
      child.once('error', error => reject(new Error(`Редактор ${argv[0]} не запустился: ${error.message}. Настрой reviewEditor в профиле.`)));
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Редактор завершился: ${signal ?? `код ${code}`}.`)));
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.stdin.pause();
    renderer.currentRenderBuffer?.clear(); renderer.resume(); renderer.requestRender?.();
  }
}

export async function openReviewEditor(renderer, review, { file, editor, run = runEditorProcess, env = process.env } = {}) {
  const content = reviewPatch(review, file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-'));
  try {
    fs.chmodSync(dir, 0o700);
    const patch = path.join(dir, 'review.diff');
    fs.writeFileSync(patch, content, { mode: 0o400 });
    await run(renderer, editorArgv(editor, patch, env, review), dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
