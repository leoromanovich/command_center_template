import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, status, approve, resume, feedback, resolveUserAction, fingerprint, prepare, previewBase } from '../lib/controller.mjs';
import { listTasks, startRun, stopRun, jobStatus } from '../lib/background.mjs';
import { unfinishedCommands } from '../lib/audit.mjs';
import { atomicJSON } from '../lib/recovery.mjs';
import { codeBlock, planDocument, commandDocument } from './documents.mjs';
import { previewUserCommand, runUserCommand, userCommandRuns, completedUserCommands } from '../lib/user-terminal.mjs';
import { runInTerminal } from './terminal.mjs';
import { createWorkspaceMonitor } from '../lib/workspace-status.mjs';
import { loadHumanReview } from '../lib/human-review.mjs';
import { openReviewEditor } from './review-editor.mjs';
import { agentHistory, agentDocument } from './agent-history.mjs';

// These callbacks run in the human TUI. They are never registered as LLM tools.
export async function createControls(api, { openDocument, openReview, runTerminal = runInTerminal, runReviewEditor = openReviewEditor, autoOpen = true } = {}) {
  const filename = process.env.CC_PROFILE;
  if (!filename || process.env.CC_WORKER_ROLE) return;
  const profile = loadProfile(filename);
  const reader = openDocument ?? (await import('./document-view.tsx')).createDocumentReader(api);
  let reviewReader = openReview;
  const show = (title, content, options = {}) => reader({ title, content: String(content), ...options });
  const help = () => show('Справка · Command Center', fs.readFileSync(new URL('../CC-HELP.md', import.meta.url), 'utf8'), { source: '/cc-help · Процесс, команды и действия пользователя' });
  const toast = message => api.ui.toast({ title: 'Command Center', message, variant: 'info', duration: 6000 });
  const confirm = async (title, message) => {
    if (String(message).length > 240 || String(message).split('\n').length > 5) {
      if (!await show(title, message, { continueLabel: 'К подтверждению' })) return false;
      message = 'Подтвердить действие с просмотренными данными?';
    }
    return new Promise(resolve => api.ui.dialog.replace(() => api.ui.DialogConfirm({ title, message,
      onConfirm: () => resolve(true), onCancel: () => resolve(false) }), () => resolve(false)));
  };
  const prompt = (title, placeholder, value = '') => new Promise(resolve => api.ui.dialog.replace(() => api.ui.DialogPrompt({ title, placeholder, value,
    onConfirm: text => { resolve(text); api.ui.dialog.clear(); }, onCancel: () => { resolve(null); api.ui.dialog.clear(); } }), () => resolve(null)));
  const select = (title, options) => new Promise(resolve => api.ui.dialog.replace(() => api.ui.DialogSelect({ title, options,
    onSelect: option => { resolve(option.value); api.ui.dialog.clear(); } }), () => resolve(undefined)));
  const launch = async id => { const job = await startRun(filename, id); toast(`Задача ${id}: ${job.alive ? 'выполняется в фоне; /cc — состояние' : job.status}`); };
  const taskDir = id => path.join(profile.stateRoot, id);
  let terminalActive = false;
  const runLabel = run => run.status === 'running' ? 'исход неизвестен; проверь перед повтором'
    : run.error ? `ошибка: ${run.error}` : run.signal ? `сигнал ${run.signal}` : `код ${run.exit_code}`;

  let actionOpen = false;
  const seenRequests = new Set();

  async function respond(id, request) {
    if (actionOpen || terminalActive) return;
    actionOpen = true; seenRequests.add(request.id);
    const reply = async (outcome, summary) => {
      await resolveUserAction(filename, id, request.id, { outcome, summary: summary.slice(-4000), output: '' },
        { expectedRequest: request.request });
      return launch(id);
    };
    const brief = text => text.length > 220 ? text.slice(0, 220) + '… (d — подробности)' : text;
    try { for (;;) {
      const runs = userCommandRuns(filename, id, request.id);
      const completed = completedUserCommands(request, runs);
      const next = completed.findIndex(done => !done);
      const allDone = next === -1;
      const last = runs.findLast(run => run.index === next);
      let preview, error;
      if (!allDone) {
        try { preview = previewUserCommand(filename, id, request.id, next); }
        catch (cause) { error = cause.message; }
      }
      const recorded = runs.map(run => `Команда ${run.index + 1}: ${runLabel(run)}`).join('\n');
      const summary = () => recorded || 'Команды ещё не запускались.';
      const command = allDone ? undefined : request.request.commands[next];
      const actions = [
        ...(preview ? [{ label: last ? 'Повторить и продолжить' : 'Выполнить и продолжить', value: 'execute', key: 'ctrl+r', shortcut: 'Ctrl+R', primary: true }] : []),
        ...(allDone ? [{ label: 'Продолжить Builder', value: 'completed', key: 'ctrl+r', shortcut: 'Ctrl+R', primary: true }] : []),
        ...(last || error ? [{ label: 'Вернуть Builder', value: 'failed', key: 'f', shortcut: 'f' }] : []),
        { label: 'Отказать', value: 'declined', key: 'ctrl+d', shortcut: 'Ctrl+D' },
        { label: 'Уже выполнено', value: 'manual', key: 'ctrl+y', shortcut: 'Ctrl+Y' },
        { label: 'Позже', value: 'later', shortcut: 'Esc' },
      ];
      const content = [`# ${request.request.title}`, '', brief(request.request.reason), '',
        ...(command ? [`**Команда ${next + 1} из ${completed.length}**`, '', codeBlock(command.command, 'sh'),
          '**Каталог:**', '', codeBlock(preview?.resolvedCwd ?? command.cwd)] : ['Все команды завершились с кодом 0.']),
        ...(preview && preview.cwd !== preview.resolvedCwd ? ['', 'Путь из запроса:', '', codeBlock(preview.cwd)] : []),
        ...(last ? ['', `**Предыдущая попытка:** ${runLabel(last)}. Повтор может повторить изменения.`] : []),
        ...(error ? ['', `**Запуск недоступен:** ${error}`] : []),
        '', `**Риски:** ${brief(request.request.risks)}`, '',
        allDone ? 'Результат сохранён. Можно продолжить Builder без повторного запуска.'
          : 'После кода 0 — следующая команда или автоматическое продолжение Builder. При ошибке цикл останется на паузе.',
      ].join('\n');
      const action = await show(`Builder · ${id}`, content, { actions,
        details: `## Зачем\n\n${request.request.reason}\n\n## Ограничение агента\n\n${request.request.why_agent_cannot}\n\n## Риски\n\n${request.request.risks}\n\n## Ожидаемый результат\n\n${request.request.expected_result}\n\n## История\n\n${codeBlock(summary())}\n\nShell: /bin/sh; окружение от ./start. Команда и исход сохраняются в журнале. Ввод и вывод терминала не копируются в контекст модели.` });
      if (!action || action === 'later') return;
      if (action === 'declined') return reply('declined', 'Пользователь отказался от выполнения запроса.\n' + summary());
      if (action === 'manual') return reply('completed', 'Пользователь сообщил, что выполнил действие самостоятельно. Builder должен проверить результат.\n' + summary());
      if (action === 'failed') return reply('failed', (error ?? 'Команда не завершилась успешно.') + '\n' + summary());
      if (action === 'completed' && allDone) return reply('completed', 'Все команды завершились с кодом 0. Builder должен проверить ожидаемый результат.\n' + summary());
      if (action !== 'execute' || !preview) continue;
      terminalActive = true;
      let result;
      try { result = await runUserCommand(filename, id, preview, (command, hooks) => runTerminal(api.renderer, command, hooks)); }
      finally { terminalActive = false; }
      if (result.status !== 'finished' || result.exit_code !== 0) continue;
      const updated = userCommandRuns(filename, id, request.id);
      if (completedUserCommands(request, updated).every(Boolean)) {
        return reply('completed', 'Все команды завершились с кодом 0. Builder должен проверить ожидаемый результат.\n'
          + updated.map(run => `Команда ${run.index + 1}: ${runLabel(run)}`).join('\n'));
      }
    } } finally { actionOpen = false; }
  }

  async function reviewTask(id) {
    reviewReader ??= (await import('./human-review-view.tsx')).createHumanReviewReader(api);
    const review = await loadHumanReview(filename, id);
    let position;
    for (;;) {
      const selected = await reviewReader(review, position);
      if (!selected) return;
      position = selected.position;
      if (['editor', 'editor-all'].includes(selected.action)) {
        terminalActive = true;
        try { await runReviewEditor(api.renderer, review, { file: selected.action === 'editor' ? selected.file : undefined, editor: profile.reviewEditor }); }
        catch (error) { api.ui.toast({ title: 'Редактор', message: error.message, variant: 'error', duration: 8000 }); }
        finally { terminalActive = false; }
        continue;
      }
      if (selected.action === 'accept' && review.canAccept) {
        if (!await confirm(`Принять ${id}?`, `Подтвердить, что результат тебя устраивает?${review.jiraUpdate ? '\nПосле приёмки будет обновлена связанная задача Jira.' : ''}`)) continue;
        const current = status(filename, id);
        if (current.digest !== review.digest || current.reviewedFingerprint !== review.fingerprint
          || await fingerprint(current.snapshot) !== review.fingerprint) throw new Error('Изменения обновились после открытия ревью. Открой их снова.');
        await startRun(filename, id, { action: 'accept', expectedFingerprint: review.fingerprint, expectedDigest: review.digest });
        toast(`Приёмка ${id} запущена.`); return;
      }
      if (selected.action === 'feedback' && review.canFeedback) {
        const file = selected.file ? `${selected.file.repo}/${selected.file.path}` : '';
        const text = await prompt(file ? `Замечания · ${file}` : `Замечания · ${id}`,
          'Опиши исправления. Отправка вернёт задачу Builder и запустит проверки и ревью.');
        if (!text?.trim()) continue;
        await feedback(filename, id, file ? `${file}\n\n${text}` : text,
          { expectedDigest: review.digest, expectedFingerprint: review.fingerprint });
        return launch(id);
      }
    }
  }

  async function taskMenu(id, directAction) {
    const state = status(filename, id), job = jobStatus(filename, id);
    if (state.pendingUserAction && !job?.alive && !['history', 'watch'].includes(directAction)) return respond(id, state.pendingUserAction);
    const options = [{ title: 'Показать состояние', value: 'status', description: state.status },
      { title: 'Показать план', value: 'plan' }, { title: 'Журнал команд', value: 'commands' },
      { title: 'История агентов', value: 'history', description: 'Сессии, проходы, рассуждения и инструменты' },
      { title: 'Наблюдать', value: 'watch', description: 'Текущая фаза и сообщения · обновление каждые 2 с' }];
    if (job?.alive) options.push({ title: 'Приостановить цикл', value: 'pause' });
    if (!job?.alive) {
      if (state.status === 'prepared') options.push({ title: 'Утвердить план и запустить', value: 'approve' });
      if (state.status === 'approved') options.push({ title: 'Запустить', value: 'run' });
      if (['paused_interrupted', 'building', 'checking', 'reviewing', 'publishing'].includes(state.status)) options.push({ title: 'Восстановить и продолжить', value: 'resume' });
      if (state.status === 'waiting_for_user_action') options.push({ title: 'Ответить на запрос Builder', value: 'respond' });
      if (['ready_for_user', 'accepted'].includes(state.status)) options.push({ title: 'Ревью изменений', value: 'review', description: 'Файлы, diff, замечания и приёмка' });
      if (state.status === 'committing_reviewed' || (['ready_for_user', 'accepted'].includes(state.status)
        && state.reviewedCommit?.fingerprint !== state.reviewedFingerprint)) options.push({
        title: state.status === 'committing_reviewed' ? 'Продолжить коммит проверенного результата' : 'Закоммитить проверенный результат', value: 'commit-reviewed' });
      if (state.status === 'refreshing_base' || (['prepared', 'approved'].includes(state.status) && state.round === 0)) options.push({
        title: state.status === 'refreshing_base' ? 'Продолжить обновление базы' : 'Обновить базу worktree', value: 'refresh-base' });
      if (['ready_for_user', 'blocked'].includes(state.status)) options.push({ title: 'Передать замечания и продолжить', value: 'feedback' });
    }
    options.push({ title: 'Обновить', value: 'refresh' });
    // Re-read current state before following a dashboard shortcut. A stale row
    // cannot authorize an action that is no longer available.
    const action = directAction && options.some(option => option.value === directAction) ? directAction
      : await select(`${id}: ${state.status}${job?.alive ? ' · работает' : ''}`, options);
    if (!action) return;
    if (action === 'refresh') return taskMenu(id);
    if (action === 'review') return reviewTask(id);
    if (action === 'watch') return reader(await agentDocument(api, filename, id, { live: true }));
    if (action === 'history') {
      for (;;) {
        const history = agentHistory(filename, id);
        if (!history.entries.length) return show(`История · ${id}`, 'Агенты ещё не запускались.');
        const entry = await select(`История агентов · ${id}`, history.entries.map(item => ({
          title: `${item.label} · проходы ${item.rounds.join(', ')}`,
          description: item.session ?? 'Ожидает ID сессии', value: item,
        })));
        if (!entry) return;
        await reader(await agentDocument(api, filename, id, { selected: entry }));
      }
    }
    if (action === 'status') return show(id, codeBlock(JSON.stringify({ status: state.status, round: state.round, phase: state.interruption?.phase,
      error: state.error, retry: state.nextRetryAt, job, reviewedCommit: state.reviewedCommit, baseRefresh: state.baseRefresh,
      publishedHeads: state.publishedHeads, state: path.join(taskDir(id), 'state.json') }, null, 2), 'json'));
    if (action === 'plan') return show(`План ${id}`, planDocument(state), { source: path.join(taskDir(id), 'plan.md') });
    if (action === 'commands') {
      const document = commandDocument(taskDir(id));
      return show(`Команды · ${id}`, document.content, { source: document.source, refresh: () => commandDocument(taskDir(id)) });
    }
    if (action === 'approve') {
      if (!await show(`План ${id}`, planDocument(state), { source: path.join(taskDir(id), 'plan.md'), continueLabel: 'К подтверждению' })) return;
      if (!await confirm(`Утвердить и запустить ${id}?`, `План и Git-действия просмотрены.
Digest: ${state.digest}`)) return;
      await approve(filename, id, state.digest); return launch(id);
    }
    if (action === 'run') return launch(id);
    if (action === 'commit-reviewed') {
      const token = state.reviewedFingerprint;
      if (await fingerprint(state.snapshot) !== token) throw new Error('Файлы изменились после ревью. Нужен новый проход проверок.');
      if (!await confirm(`Коммит ${id}`, `Будет создан локальный коммит проверенных файлов. Push отключён. Статус приёмки сохранится.\n\n${state.snapshot.repos.map(r => `## ${r.id}\n\nВетка:\n\n${codeBlock(r.branch)}\n\nКаталог:\n\n${codeBlock(r.root)}`).join('\n\n')}\n\n## Digest\n\n${codeBlock(state.digest)}\n\n## Fingerprint\n\n${codeBlock(token)}`)) return;
      await startRun(filename, id, { action, expectedDigest: state.digest, expectedFingerprint: token });
      toast(`Коммит ${id} запущен; /cc — состояние.`); return;
    }
    if (action === 'refresh-base') {
      const preview = await previewBase(filename, id);
      if (!preview.changed) return show('База актуальна', 'Worktree уже находится на выбранном базовом коммите.');
      if (!await confirm(`Обновить базу ${id}?`, `${preview.targets.map(x => `## ${x.repo}\n\nВетка:\n\n${codeBlock(x.branch)}\n\nБаза:\n\n${codeBlock(x.baseRef)}\n\nПереход:\n\n${codeBlock(`${x.from}\n→ ${x.to}`)}`).join('\n\n')}\n\nТолько fast-forward чистого worktree. Одобрение будет сброшено; новый план останется в prepared.\n\nDigest:\n\n${codeBlock(preview.digest)}`)) return;
      await startRun(filename, id, { action, expectedDigest: preview.digest, expectedTargets: preview.targets });
      toast(`Обновление базы ${id} запущено; /cc — состояние.`); return;
    }
    if (action === 'pause') {
      if (await confirm(`Приостановить ${id}?`, 'Текущий процесс будет прерван. Состояние и файлы сохранятся; исход выполнявшихся команд нужно будет проверить.')) {
        stopRun(filename, id); toast('Приостановка запрошена. Обнови состояние через /cc.');
      }
      return;
    }
    if (action === 'resume') {
      const unknown = unfinishedCommands(taskDir(id));
      const details = unknown.map(x => codeBlock(x.command ?? x.argv?.join(' '))).join('\n\n');
      if (!await confirm(`Продолжить ${id}`, `${state.error ?? 'Предыдущий процесс остановился.'}\n\n${unknown.length ? `Исход этих команд неизвестен. Проверь результат перед продолжением:\n${details}\n\nПодтверждаешь, что проверил их?` : 'Продолжить сохранённый этап?'}`)) return;
      await resume(filename, id, { acknowledgeUnknown: unknown.length > 0 }); return launch(id);
    }
    if (action === 'respond') {
      const request = state.pendingUserAction;
      if (!request) throw new Error('Запрос уже закрыт; обнови состояние.');
      return respond(id, request);
    }
    if (action === 'feedback') {
      const text = await prompt('Замечания в рамках согласованного плана', 'Новые требования требуют нового плана и одобрения.');
      if (!text?.trim()) return;
      if (!await confirm('Передать Builder и запустить полный цикл?', text)) return;
      await feedback(filename, id, text); return launch(id);
    }
  }

  async function menu() {
    if (terminalActive) return;
    const tasks = listTasks(filename);
    const route = api.route.current;
    const currentSession = route.name === 'session' ? route.params.sessionID : undefined;
    const options = [{ title: 'Новая задача', description: 'Planner в новой сессии', value: { type: 'new-plan' } },
      ...(currentSession ? [{ title: 'Продолжить планирование', description: 'В текущем диалоге', value: { type: 'continue-plan' } }] : []),
      { title: 'Подготовить существующий черновик task.json', value: { type: 'prepare' } },
      { title: 'Справка по процессу CC', description: '/cc-help', value: { type: 'help' } },
      ...tasks.map(task => ({ title: task.id, description: `${task.status}${task.job?.alive ? ' · работает' : ''}`, value: { type: 'task', id: task.id } }))];
    const selected = await select('Command Center', options);
    if (selected?.type === 'task') return taskMenu(selected.id);
    if (['new-plan', 'continue-plan'].includes(selected?.type)) {
      const fresh = selected.type === 'new-plan';
      const text = await prompt(fresh ? 'Новая задача для Planner' : 'Продолжить планирование', fresh ? 'Опиши локальную фичу или укажи Jira-тикет' : 'Что уточнить в текущей задаче?');
      if (!text?.trim()) return;
      let sessionID = fresh ? undefined : currentSession;
      if (fresh) {
        const session = await api.client.session.create({ title: text.trim().split('\n')[0].slice(0, 80) });
        sessionID = session.data?.id;
        if (!sessionID) throw new Error('OpenCode не создал сессию');
        api.route.navigate('session', { sessionID });
      }
      if (!sessionID) throw new Error('Открой нужную сессию для продолжения планирования.');
      atomicJSON(path.join(profile.stateRoot, 'interactive-session.json'), { session: sessionID, agent: 'planner', at: new Date().toISOString() });
      // Native slash command selects Planner; its response remains in this session.
      void api.client.session.command({ sessionID, command: 'cc-plan', arguments: text }).then(result => {
        if (result.error) toast(`Planner: ${JSON.stringify(result.error)}`);
      }).catch(error => toast(error.message));
    }
    if (selected?.type === 'help') return help();
    if (selected?.type === 'prepare') {
      const file = await prompt('Путь к task.json', 'Абсолютный путь к готовому черновику');
      if (!file) return;
      let state;
      try { state = await prepare(filename, file); }
      catch (error) {
        if (!error.message.startsWith('Prepared inputs changed.')) throw error;
        if (!await confirm('Заменить сохранённый план?', 'Текущий план будет архивирован. Новый план потребует отдельного одобрения перед запуском.')) return;
        state = await prepare(filename, file, { replace: true });
      }
      return taskMenu(state.id);
    }
  }
  let uiBusy = false;
  const safe = fn => async () => {
    if (uiBusy || terminalActive || actionOpen) return;
    uiBusy = true;
    try { await fn(); } catch (error) { api.ui.toast({ title: 'Command Center', message: error.message, variant: 'error', duration: 12000 }); }
    finally { uiBusy = false; }
  };
  const pending = () => listTasks(filename).filter(task => task.pendingUserAction && !task.job?.alive);
  const inbox = async () => {
    const tasks = pending();
    if (!tasks.length) return toast('Ожидающих запросов нет.');
    const id = tasks.length === 1 ? tasks[0].id : await select('Запросы Builder', tasks.map(task => ({
      title: task.id, description: task.pendingUserAction.request.title, value: task.id })));
    if (id) return respond(id, status(filename, id).pendingUserAction);
  };
  const monitor = createWorkspaceMonitor(filename, api);
  const openActivity = async row => {
    if (row.type === 'session') return api.route.navigate('session', { sessionID: row.id });
    if (row.status === 'invalid') return show(row.title, codeBlock(row.detail));
    return taskMenu(row.id, row.running && !row.attention ? 'watch' : ['approve', 'review', 'resume'].includes(row.target) ? row.target : undefined);
  };
  const activityList = async () => {
    await monitor.refresh();
    const snapshot = monitor.getSnapshot();
    const options = snapshot.active.map(row => ({ title: `${row.attention ? '◆' : '●'} ${row.title}`,
      description: `${row.activity}${row.attention && row.action !== row.activity ? ` → ${row.action}` : ''}`, value: row }));
    if (snapshot.warnings.length) options.push({ title: 'Часть статусов недоступна', description: 'Подробности ошибки', value: 'warnings' });
    if (!options.length) return toast('Активных агентов и ожидающих ответов нет. Все задачи доступны через /cc.');
    const row = await select(`CC · агентов: ${snapshot.agents} · ждут тебя: ${snapshot.attention}`, options);
    if (row === 'warnings') return show('Состояние монитора', codeBlock(snapshot.warnings.join('\n')));
    if (row) return openActivity(row);
  };
  const reviewList = async () => {
    const tasks = listTasks(filename).filter(task => ['ready_for_user', 'accepted'].includes(task.status) && !task.job?.alive);
    if (!tasks.length) return toast('Готовых результатов пока нет.');
    const id = tasks.length === 1 ? tasks[0].id : await select('Ревью изменений', tasks.map(task => ({
      title: task.id, description: `${task.status === 'accepted' ? 'Принято' : 'Ждёт твоего ревью'} · проход ${task.round}`, value: task.id })));
    if (id) return reviewTask(id);
  };
  const inspectAgents = async live => {
    const tasks = listTasks(filename).filter(task => task.status !== 'invalid');
    if (!tasks.length) return toast('Задач пока нет.');
    const id = tasks.length === 1 ? tasks[0].id : await select(live ? 'Наблюдать' : 'История агентов', tasks.map(task => ({
      title: task.id, description: task.status, value: task.id,
    })));
    if (id) return taskMenu(id, live ? 'watch' : 'history');
  };
  if (api.slots?.register) {
    const { mountWorkspacePanel } = await import('./workspace-panel.tsx');
    mountWorkspacePanel(api, monitor, { open: row => safe(() => openActivity(row))(), showAll: safe(activityList) });
  }
  void monitor.refresh();
  api.keymap.registerLayer({ commands: [
    { name: 'command-center.open', title: 'Command Center: задачи и подтверждения', category: 'Command Center', namespace: 'palette', slashName: 'cc', run: safe(menu) },
    { name: 'command-center.action', title: 'Builder: ожидающий запрос', category: 'Command Center', namespace: 'palette', slashName: 'cc-action', run: safe(inbox) },
    { name: 'command-center.agents', title: 'Command Center: агенты и ожидающие действия', category: 'Command Center', namespace: 'palette', slashName: 'cc-agents', run: safe(activityList) },
    { name: 'command-center.review', title: 'Command Center: ревью изменений', category: 'Command Center', namespace: 'palette', slashName: 'cc-review', run: safe(reviewList) },
    { name: 'command-center.history', title: 'Command Center: история агентов', category: 'Command Center', namespace: 'palette', slashName: 'cc-history', run: safe(() => inspectAgents(false)) },
    { name: 'command-center.watch', title: 'Command Center: наблюдать', category: 'Command Center', namespace: 'palette', slashName: 'cc-watch', run: safe(() => inspectAgents(true)) },
    { name: 'command-center.help', title: 'Command Center: справка по процессу', category: 'Command Center', namespace: 'palette', slashName: 'cc-help', run: safe(help) },
  ], bindings: [] });
  const canOpen = () => !uiBusy && !terminalActive && !actionOpen && !api.ui.dialog.open
    && ['home', 'session'].includes(api.route.current.name);
  const initial = setTimeout(() => { if (autoOpen && canOpen() && !seenRequests.size) void safe(pending().length ? inbox : menu)(); }, 1200);
  const known = new Map(listTasks(filename).map(task => [task.id, task.status]));
  const poll = setInterval(() => {
    if (terminalActive) return;
    try {
      const tasks = listTasks(filename);
      void monitor.refresh(tasks);
      for (const task of tasks) {
        if (known.get(task.id) !== task.status && ['prepared', 'committing_reviewed', 'refreshing_base', 'paused_interrupted', 'blocked', 'ready_for_user', 'accepted'].includes(task.status)) toast(`${task.id}: ${task.status}. Открой /cc.`);
        known.set(task.id, task.status);
      }
      const next = tasks.find(task => task.pendingUserAction && !task.job?.alive && !seenRequests.has(task.pendingUserAction.id));
      if (autoOpen && next && canOpen()) void safe(() => respond(next.id, next.pendingUserAction))();
    } catch { /* A partially written/corrupt task is shown in the menu. */ }
  }, 1000);
  api.lifecycle.onDispose(() => { clearTimeout(initial); clearInterval(poll); monitor.dispose(); });
}

export default { id: 'command-center.controls', tui: api => createControls(api) };
