import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical } from './policy.mjs';

export const PENDING_ACTION = 'pending-user-action.json';
const required = (ok, message) => { if (!ok) throw new Error(message); };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const atomic = (file, value) => {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};

export function parseUserAction(input, state) {
  const fields = ['repo', 'title', 'reason', 'why_agent_cannot', 'commands', 'expected_result', 'risks'];
  required(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === fields.length && Object.keys(input).every(key => fields.includes(key)), 'Invalid user action fields');
  required(state.snapshot.repos.some(repo => repo.id === input.repo), 'Choose a repository from the approved task');
  for (const name of ['title', 'reason', 'why_agent_cannot', 'expected_result', 'risks']) required(text(input[name], name === 'title' ? 200 : 4000), `Missing or invalid ${name}`);
  required(Array.isArray(input.commands) && input.commands.length >= 1 && input.commands.length <= 5, 'Request 1..5 explicit commands');
  for (const command of input.commands) {
    required(command && Object.keys(command).length === 2 && Object.keys(command).every(key => ['command', 'cwd'].includes(key)), 'Each command requires command and cwd');
    required(text(command.command) && text(command.cwd, 2048) && path.isAbsolute(command.cwd), 'Use a literal command and an absolute cwd');
  }
  return structuredClone(input);
}

export function parseUserActionResponse(value) {
  const fields = ['outcome', 'summary', 'output'];
  required(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key)), 'Response requires outcome, summary and output');
  required(['completed', 'failed', 'declined'].includes(value.outcome), 'outcome must be completed, failed or declined');
  required(text(value.summary), 'Response summary is required');
  required(typeof value.output === 'string' && value.output.length <= 65536 && !value.output.includes('\0'), 'output must be text, at most 65536 characters; remove secrets');
  return structuredClone(value);
}

export function pendingUserAction(stateDir, state) {
  const file = path.join(stateDir, PENDING_ACTION);
  if (!fs.existsSync(file)) return undefined;
  const request = readJSON(file);
  state ??= readJSON(path.join(stateDir, 'state.json'));
  if (state.userActions?.some(item => item.id === request.id && item.response)) return undefined;
  required(typeof request.id === 'string' && /^[0-9a-f-]{36}$/.test(request.id), 'Invalid persisted user action id');
  required(request.feature_id === state.id && text(request.session_id, 200), 'Invalid user action feature/session');
  required(request.plan_digest === state.digest && request.round === state.round, 'Pending user action differs from the active plan/round; inspect controller state');
  parseUserAction(request.request, state);
  return request;
}

export function assertNoPendingUserAction(stateDir) {
  const request = pendingUserAction(stateDir);
  required(!request, `Waiting for user action ${request?.id}; stop tools and return control to the user`);
}

const fence = value => {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}\n${value}\n${marker}`;
};

function requestMarkdown(packet) {
  const r = packet.request;
  return [`# ${r.title}`, '', `Request: ${packet.id}`, '',
    'Команды предложены Builder для проверки пользователем. В карточке /cc-action можно выбрать «Выполнить и продолжить»: это разрешает показанную команду и автоматическую передачу её успешного исхода Builder.', '',
    `Причина: ${r.reason}`, '', `Почему агент не может выполнить: ${r.why_agent_cannot}`, '',
    `Риски и изменения: ${r.risks}`, '',
    ...r.commands.flatMap((command, index) => [`## Команда ${index + 1}`, '', `Рабочий каталог: ${command.cwd}`, '', fence(command.command), '']),
    `Ожидаемый результат: ${r.expected_result}`, '',
    `После проверки: /cc-action → «Выполнить и продолжить». При ошибке выберите повтор или возврат Builder. Доступны «Отказать», «Уже выполнено» и «Позже». Пароли вводите только в терминале.`, '',
    'Запасной CLI-интерфейс описан в USER-ACTIONS.md.', '',
  ].join('\n');
}

// Persists a proposal only. This module never spawns, evaluates or executes a requested command.
export function requestUserAction(input, { stateDir, featureRoot, round, sessionID }) {
  required(canonical(stateDir) === path.resolve(stateDir), 'Symlinked state directories are unsupported');
  const state = readJSON(path.join(stateDir, 'state.json'));
  required(state.status === 'building' && state.round === round, 'User actions can only be requested by the active Builder round');
  required(state.approved?.digest === state.digest && hash(state.snapshot) === state.digest, 'Approved snapshot changed');
  required(canonical(featureRoot) === state.snapshot.featureRoot, 'Worker feature differs from the approved plan');
  required(text(sessionID, 200), 'Builder session ID is required');
  const request = parseUserAction(input, state);
  const existing = pendingUserAction(stateDir, state);
  if (existing) {
    required(hash(existing.request) === hash(request), `User action ${existing.id} is already pending; finish your response`);
    return existing;
  }
  required(!fs.existsSync(path.join(stateDir, 'dev-run/.lock')), 'Wait for the current dev_run to finish before requesting user action');
  const id = crypto.randomUUID();
  const dir = path.join(stateDir, 'user-actions', id);
  required(canonical(dir) === dir, 'Symlinked user action directories are unsupported');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const packet = { id, feature_id: state.id, plan_digest: state.digest, round, session_id: sessionID,
    created: new Date().toISOString(), request, file: path.join(dir, 'request.md') };
  atomic(path.join(dir, 'request.json'), packet);
  fs.writeFileSync(packet.file, requestMarkdown(packet), { mode: 0o600 });
  atomic(path.join(stateDir, PENDING_ACTION), packet);
  fs.appendFileSync(path.join(stateDir, 'events.jsonl'), JSON.stringify({ at: packet.created, type: 'user_action_requested', round, request_id: id, file: packet.file }) + '\n');
  return packet;
}
