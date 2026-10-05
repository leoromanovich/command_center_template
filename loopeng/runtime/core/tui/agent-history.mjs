import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, status } from '../lib/controller.mjs';
import { codeBlock } from './documents.mjs';

const roles = { builder: 'Builder', reviewer: 'Reviewer', 'execution-reviewer': 'Execution Reviewer' };
const phases = { building: 'Builder работает', checking: 'Линтеры, форматтеры и тесты', reviewing: 'Reviewer работает',
  ready_for_user: 'Ждёт твоего ревью', accepted: 'Принято', blocked: 'Нужна помощь', waiting_for_user_action: 'Builder ждёт твоего ответа — q, затем /cc-action',
  paused_interrupted: 'Выполнение прервано', prepared: 'План ждёт одобрения', publishing: 'Публикация результата' };
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const sessionId = value => typeof value === 'string' && /^[\w-]+$/.test(value) ? value : undefined;
function read(file, limit, tail = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd); if (!stat.isFile()) return '';
    const offset = tail ? Math.max(0, stat.size - limit) : 0;
    const bytes = Buffer.alloc(Math.min(stat.size, limit)); fs.readSync(fd, bytes, 0, bytes.length, offset);
    const text = bytes.toString('utf8'); return offset ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code)) return ''; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const lines = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

export function agentHistory(profilePath, id) {
  const profile = loadProfile(profilePath), state = status(profilePath, id), dir = path.join(profile.stateRoot, state.id);
  const entries = [];
  const add = (file, role, round, savedSession) => {
    const info = fs.lstatSync(file); if (!info.isFile()) return;
    const events = lines(read(file, 65536));
    entries.push({ role, round, file, session: sessionId(savedSession) ?? events.map(event => sessionId(event?.sessionID)).find(Boolean), updated: info.mtimeMs });
  };
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d+)-(builder|reviewer)(?:-resume-\d+)?(?:-attempt-\d+)?\.log$/.exec(name);
    if (match) add(path.join(dir, name), match[2], Number(match[1]));
  }
  const dev = path.join(dir, 'dev-run');
  if (fs.existsSync(dev) && !fs.lstatSync(dev).isSymbolicLink()) for (const child of fs.readdirSync(dev, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const root = path.join(dev, child.name), round = Number(/^round-(\d+)/.exec(child.name)?.[1] ?? 0);
    for (const name of fs.readdirSync(root)) {
      const match = /^reviewer(?:-attempt-(\d+))?\.log$/.exec(name); if (!match) continue;
      let saved; try { saved = JSON.parse(read(path.join(root, `session-${match[1] ?? 1}.json`), 8192)).session; } catch { /* Pending session. */ }
      add(path.join(root, name), 'execution-reviewer', round, saved);
    }
  }
  const grouped = new Map();
  for (const entry of entries.sort((a, b) => a.updated - b.updated)) {
    const key = `${entry.role}:${entry.session ?? entry.file}`, previous = grouped.get(key);
    grouped.set(key, { ...entry, key, label: roles[entry.role], rounds: [...new Set([...(previous?.rounds ?? []), entry.round])],
      files: [...(previous?.files ?? []), entry.file] });
  }
  return { state, dir, entries: [...grouped.values()].sort((a, b) => b.updated - a.updated) };
}

export function transcript(messages, { thinking = true, prompts = false, budget = 160000 } = {}) {
  const blocks = []; let used = 0, clipped = false;
  const add = value => {
    if (used >= budget) { clipped = true; return; }
    if (value.length > 16000) { value = codeBlock(value.slice(0, 16000)) + '\n\n[Блок сокращён до 16 000 символов]'; clipped = true; }
    if (used + value.length > budget) { clipped = true; return; }
    used += value.length; blocks.push(value);
  };
  // Keep the newest messages within the display budget, render chronologically.
  for (const message of [...messages].reverse()) {
    if (message.info?.role === 'user' && !prompts) continue;
    const chunks = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'text') chunks.push(`### ${message.info?.role === 'user' ? 'Запрос' : 'Сообщение'}\n\n${part.text ?? ''}`);
      if (part.type === 'reasoning' && thinking) chunks.push(`### Рассуждение\n\n${part.text ?? ''}`);
      if (part.type === 'tool') {
        const state = part.state ?? {};
        chunks.push(`### Инструмент: ${clean(part.tool)} · ${clean(state.status)}\n\n${codeBlock(JSON.stringify(state.input ?? {}, null, 2), 'json')}`
          + (state.output !== undefined ? `\n\n**Результат**\n\n${codeBlock(state.output)}` : '')
          + (state.error ? `\n\n**Ошибка**\n\n${codeBlock(state.error)}` : ''));
      }
    }
    for (const chunk of chunks.reverse()) add(chunk);
  }
  return { content: blocks.reverse().join('\n\n---\n\n') || 'Сообщений для выбранных фильтров пока нет.', clipped };
}

function logMessages(entry) {
  // A bounded fallback when the native session/API is unavailable.
  const messages = new Map();
  for (const file of entry.files.slice(-4)) for (const event of lines(read(file, 512 * 1024, true))) {
    if (!event?.part || !['text', 'reasoning', 'tool'].includes(event.part.type)) continue;
    const key = event.part.id ?? `${file}:${messages.size}`;
    messages.set(key, { info: { role: 'assistant' }, parts: [event.part] });
  }
  return [...messages.values()];
}

export async function agentDocument(api, profilePath, id, { selected, live = false } = {}) {
  let thinking = true, prompts = false, limit = 100;
  const refresh = async ({ signal } = {}) => {
    const history = agentHistory(profilePath, id);
    const entry = selected ? history.entries.find(item => item.key === selected.key || item.files.includes(selected.file)) ?? selected : history.entries[0];
    let messages = [], warning = '', source = 'Ожидание первого запуска агента';
    if (entry) {
      source = `${entry.label} · проходы ${entry.rounds.join(', ')} · ${entry.session ?? 'ожидает ID сессии'}`;
      try {
        if (!entry.session || !api.client.session.messages) throw new Error('Сессия пока недоступна');
        const result = await api.client.session.messages({ sessionID: entry.session, directory: history.state.snapshot.featureRoot, limit },
          { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
        if (result.error || !Array.isArray(result.data)) throw new Error('OpenCode не вернул сообщения');
        messages = result.data;
        if (messages.length >= limit) warning = `Показаны последние ${limit} сообщений. o — загрузить больше (максимум 1000).`;
      } catch (error) {
        if (signal?.aborted) throw error;
        messages = logMessages(entry);
        warning = `Читается ограниченный хвост файлов логов: ${clean(error.message)}. Рассуждения доступны только если записаны в лог.`;
      }
    }
    const rendered = transcript(messages, { thinking, prompts });
    return { title: `${live ? 'Наблюдать' : 'История агентов'} · ${id}`,
      content: `# ${clean(source)}\n\n**Состояние задачи:** ${phases[history.state.status] ?? clean(history.state.status)} · **проход:** ${history.state.round}\n\n`
        + (warning ? `> ${warning}\n\n` : '') + (rendered.clipped ? '> Вывод сокращён; полный текст сохранён в сессии OpenCode.\n\n' : '') + rendered.content,
      source: `${phases[history.state.status] ?? clean(history.state.status)} · ${source} · рассуждения: ${thinking ? 'вкл' : 'выкл'} · запросы: ${prompts ? 'вкл' : 'выкл'}`,
    };
  };
  return { ...await refresh(), refresh, live, intervalMs: live ? 2000 : undefined,
    controls: [
      { key: 't', label: 't · Рассуждения', run: () => { thinking = !thinking; } },
      { key: 'u', label: 'u · Запросы', run: () => { prompts = !prompts; } },
      { key: 'o', label: 'o · Больше истории', run: () => { limit = Math.min(1000, limit + 100); } },
    ] };
}
