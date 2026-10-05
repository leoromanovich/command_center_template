import path from 'node:path';
import { loadProfile } from './controller.mjs';
import { listTasks } from './background.mjs';
import { activeProcesses } from './recovery.mjs';
import { canonical } from './policy.mjs';

const roles = { builder: 'Builder', reviewer: 'Reviewer', 'execution-reviewer': 'Execution Reviewer', planner: 'Planner', orchestrator: 'Orchestrator', jira: 'Jira' };
const phases = { building: 'Подготовка Builder', checking: 'Форматтеры / проверки', reviewing: 'Подготовка Reviewer',
  publishing: 'Публикация', accepting: 'Приёмка', committing_reviewed: 'Коммит результата', refreshing_base: 'Обновление базы' };
const awaiting = { prepared: 'Утвердить план', approved: 'Запустить задачу', ready_for_user: 'Ревью изменений',
  paused_interrupted: 'Восстановить после прерывания', blocked: 'Нужны замечания / решение', invalid: 'Ошибка состояния' };

export function taskActivity(task, processes = [], error) {
  const workers = processes.filter(item => item.kind === 'agent_launch' || item.kind === 'execution-reviewer');
  const agents = workers.map(item => ({ role: item.actor, label: roles[item.actor] ?? item.actor, pid: item.pid, started: item.started }));
  const running = Boolean(task.job?.alive || processes.length);
  const stalled = !running && Boolean(phases[task.status]);
  const needsInput = Boolean(task.pendingUserAction || !running && (awaiting[task.status] || stalled) || error);
  const next = task.pendingUserAction ? 'Ответить Builder' : error ? 'Проверить состояние' : awaiting[task.status]
    ?? (stalled ? 'Восстановить выполнение' : undefined);
  const labels = [...new Set(agents.map(item => item.label))];
  if (processes.some(item => item.kind === 'dev_run')) labels.push('dev_run');
  if (processes.some(item => item.kind === 'check')) labels.push('Проверки');
  if (processes.some(item => item.kind === 'git')) labels.push('Git');
  if (processes.some(item => item.kind === 'user_command')) labels.push('Команда пользователя');
  const activity = task.pendingUserAction ? 'Ждёт ответа' : error ? 'Данные недоступны' : stalled ? 'Прервано'
    : running && task.nextRetryAt ? 'Ожидает повтор после ошибки сети'
    : labels.length ? labels.join(' + ') : running ? phases[task.status] ?? 'Контроллер' : next ?? (task.status === 'accepted' ? 'Принято' : task.status);
  return { key: `task:${task.id}`, type: 'task', id: task.id, title: task.id, status: task.status, round: task.round,
    activity, agents, running, attention: needsInput, action: next,
    detail: task.pendingUserAction?.request?.title ?? error ?? task.error ?? task.pauseNotice ?? task.job?.error ?? '',
    retryAt: task.nextRetryAt, target: task.pendingUserAction ? 'request' : task.status === 'prepared' ? 'approve'
      : task.status === 'ready_for_user' ? 'review'
        : (stalled && ['building', 'checking', 'reviewing', 'publishing'].includes(task.status)) || task.status === 'paused_interrupted' ? 'resume' : 'menu' };
}

export function readTaskActivity(profilePath, tasks = listTasks(profilePath)) {
  const profile = loadProfile(profilePath);
  return tasks.map(task => {
    try { return taskActivity(task, activeProcesses(path.join(profile.stateRoot, task.id))); }
    catch (error) { return taskActivity(task, [], error.message); }
  });
}

// Read only the local OpenCode server. No model calls, session creation or replies.
export async function readInteractiveActivity(api, directory) {
  if (!api.client?.session?.status) return [];
  const options = { signal: AbortSignal.timeout(2500) };
  const results = await Promise.allSettled([
    api.client.session.status({ directory }, options),
    api.client.question.list({ directory }, options),
    api.client.permission.list({ directory }, options),
  ]);
  const data = results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    if (result.value.error || !result.value.data) throw new Error('OpenCode session status unavailable');
    return result.value.data;
  });
  const [statuses, questions, permissions] = data;
  const ids = new Set([...Object.keys(statuses).filter(id => statuses[id].type !== 'idle'),
    ...questions.map(item => item.sessionID), ...permissions.map(item => item.sessionID)]);
  const entries = await Promise.all([...ids].map(async sessionID => {
    const session = api.state?.session?.get(sessionID) ?? (await api.client.session.get({ directory, sessionID }, options)).data;
    if (!session) throw new Error(`Session ${sessionID} unavailable`);
    if (canonical(session.directory) !== canonical(directory)) return undefined;
    const messages = api.state?.session?.messages(sessionID) ?? [];
    const agent = messages.findLast(item => item.role === 'assistant')?.agent ?? session.agent ?? 'Агент';
    const question = questions.filter(item => item.sessionID === sessionID).length;
    const permission = permissions.filter(item => item.sessionID === sessionID).length;
    const attention = question + permission > 0;
    const current = statuses[sessionID] ?? { type: 'idle' };
    const activity = [roles[agent] ?? agent, attention ? [question ? `вопросов: ${question}` : '', permission ? `разрешений: ${permission}` : ''].filter(Boolean).join(', ')
      : current.type === 'retry' ? 'повтор после ошибки сети' : 'работает'].join(' · ');
    return { key: `session:${sessionID}`, type: 'session', id: sessionID, title: session.title, status: current.type,
      activity, agents: [{ role: agent, label: roles[agent] ?? agent }], running: current.type !== 'idle', attention,
      action: attention ? 'Ответить в диалоге' : 'Открыть диалог', detail: current.type === 'retry' ? current.message : '', target: 'session' };
  }));
  return entries.filter(Boolean);
}

export function workspaceSummary(rows, warnings = []) {
  const sorted = [...rows].sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.running) - Number(a.running)
    || Number(b.agents.length > 0) - Number(a.agents.length > 0) || a.title.localeCompare(b.title));
  return { rows: sorted, active: sorted.filter(row => row.running || row.attention),
    agents: rows.reduce((sum, row) => sum + row.agents.length, 0), attention: rows.filter(row => row.attention).length,
    warnings, updated: Date.now() };
}

export function createWorkspaceMonitor(profilePath, api) {
  const directory = loadProfile(profilePath).commandCenter;
  const listeners = new Set();
  let snapshot = workspaceSummary([]), inflight, disposed = false;
  const publish = value => { if (disposed) return; snapshot = value; for (const listener of listeners) listener(snapshot); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
    refresh(tasks) {
      if (inflight || disposed) return inflight;
      inflight = (async () => {
        const warnings = [];
        let local = [], interactive = [];
        try { local = readTaskActivity(profilePath, tasks); }
        catch (error) { warnings.push(`Задачи: ${error.message}`); }
        try { interactive = await readInteractiveActivity(api, directory); }
        catch (error) { warnings.push(`Чаты: ${error.message}`); }
        publish(workspaceSummary([...local, ...interactive], warnings));
      })().finally(() => { inflight = undefined; });
      return inflight;
    },
    dispose() { disposed = true; listeners.clear(); },
  };
}
