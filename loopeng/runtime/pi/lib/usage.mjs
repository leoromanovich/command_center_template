import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validTask = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const modelName = (provider, model) => typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : undefined;

export function pricing(profile) {
  if (profile.pi?.pricingFile != null && typeof profile.pi.pricingFile !== 'string') return { currency: 'USD', models: {}, filename: null, error: 'Тарифы недоступны: pi.pricingFile должен быть строкой.' };
  const filename = profile.pi?.pricingFile && path.resolve(profile.commandCenter, profile.pi.pricingFile);
  if (!filename) return { currency: 'USD', models: {}, filename: null };
  try {
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!object(raw) || !/^[A-Z]{3}$/.test(raw.currency) || !object(raw.models)) throw new Error('currency: three uppercase letters; models: object');
    for (const [model, rates] of Object.entries(raw.models)) {
      if (!model.includes('/') || !object(rates)) throw new Error(`Invalid model: ${model}`);
      for (const [kind, value] of Object.entries(rates)) {
        if (!TOKEN_KINDS.includes(kind) || (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
          throw new Error(`${model}.${kind}: use a non-negative price per million tokens or null`);
        }
      }
    }
    return { ...raw, filename };
  } catch (error) {
    return { currency: 'USD', models: {}, filename, error: `Тарифы недоступны: ${error.message}` };
  }
}

// Retain only accounting fields, never prompts, answers or tool output. Entry IDs
// and timestamps survive Pi forks; parentId deliberately isn't part of the key.
function project(entry) {
  if (!object(entry)) return undefined;
  if (entry.type === 'session') return { type: 'session', id: entry.id };
  const row = { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
  if (entry.type === 'custom' && entry.customType === 'cc-state') {
    row.state = { role: entry.data?.role, taskID: entry.data?.taskID, claimPlanning: entry.data?.claimPlanning === true };
  }
  if (entry.type === 'model_change') row.model = modelName(entry.provider, entry.modelId);
  const assistant = entry.type === 'message' && entry.message?.role === 'assistant';
  const auxiliary = ['compaction', 'branch_summary'].includes(entry.type);
  if (assistant || auxiliary) {
    const message = assistant ? entry.message : entry;
    row.accounting = true;
    row.kind = assistant ? 'assistant' : entry.type;
    row.model = assistant ? modelName(message.provider, message.model) : undefined;
    row.unknownModel = auxiliary && entry.fromHook === true;
    row.stopReason = message.stopReason;
    row.usage = object(message.usage) ? Object.fromEntries(TOKEN_KINDS.map(key => [key, validCount(message.usage[key]) ? message.usage[key] : null])) : null;
    row.key = hash([row.id, row.timestamp, row.kind, row.model, message.timestamp, row.usage]);
  }
  return row;
}

// Append-only JSONL is read incrementally. A rewrite/truncation invalidates the
// cache; an incomplete final line is retried on the next refresh.
function readSession(file, cache) {
  const stat = fs.statSync(file);
  let saved = cache.get(file);
  if (!saved || saved.ino !== stat.ino || saved.dev !== stat.dev || stat.size < saved.offset || (stat.size === saved.offset && stat.mtimeMs !== saved.mtime)) {
    saved = { ino: stat.ino, dev: stat.dev, offset: 0, carry: Buffer.alloc(0), rows: [], invalid: 0 };
  }
  const fd = fs.openSync(file, 'r');
  try {
    if (saved.anchor && stat.mtimeMs !== saved.mtime) {
      const probe = Buffer.alloc(saved.anchor.length);
      const read = fs.readSync(fd, probe, 0, probe.length, saved.offset - probe.length);
      if (read !== probe.length || !probe.equals(saved.anchor)) saved = { ino: stat.ino, dev: stat.dev, offset: 0, carry: Buffer.alloc(0), rows: [], invalid: 0 };
    }
    while (saved.offset < stat.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - saved.offset));
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, saved.offset);
      if (!bytes) break;
      saved.offset += bytes;
      const data = Buffer.concat([saved.carry, chunk.subarray(0, bytes)]);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) >= 0) {
        const line = data.subarray(start, end).toString('utf8'); start = end + 1;
        if (!line.trim()) continue;
        try { const row = project(JSON.parse(line)); if (row) saved.rows.push(row); }
        catch { saved.invalid++; }
      }
      saved.carry = data.subarray(start);
    }
    saved.anchor = Buffer.alloc(Math.min(saved.offset, 256));
    fs.readSync(fd, saved.anchor, 0, saved.anchor.length, saved.offset - saved.anchor.length);
  } finally { fs.closeSync(fd); }
  saved.mtime = stat.mtimeMs; cache.set(file, saved);
  let final;
  if (saved.carry.length) { try { final = project(JSON.parse(saved.carry.toString('utf8'))); } catch {} }
  return { rows: final ? [...saved.rows, final] : saved.rows, invalid: saved.invalid, incomplete: saved.carry.length > 0 && !final };
}

function directoryEntries(directory, warnings) {
  try {
    if (!fs.existsSync(directory)) return [];
    if (fs.lstatSync(directory).isSymbolicLink()) { warnings.add('Каталог сессий через symlink пропущен.'); return []; }
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) { warnings.add(`Каталог сессий недоступен: ${error.message}`); return []; }
}
function sessionFiles(directory, context, result, warnings) {
  for (const entry of directoryEntries(directory, warnings)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) sessionFiles(file, context.foreground ? context : { ...context, role: context.role ?? entry.name }, result, warnings);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push({ file, ...context });
  }
}

function recordsFrom(rows, descriptor) {
  const contexts = new Map(), ancestors = new Map(), records = new Map();
  const session = rows.find(x => x.type === 'session')?.id ?? descriptor.file;
  const fallback = { role: descriptor.role ?? (descriptor.foreground ? 'planner' : 'worker'), taskID: descriptor.taskID };
  let ordinal = 0;
  for (const row of rows) {
    if (row.type === 'session') continue;
    const parent = contexts.get(row.parentId) ?? fallback;
    const context = { ...parent };
    if (row.model) context.model = row.model;
    if (descriptor.foreground && row.state) {
      context.role = ['planner', 'orchestrator'].includes(row.state.role) ? row.state.role : 'planner';
      context.taskID = validTask(row.state.taskID) ? row.state.taskID : undefined;
      context.assignedAt = context.taskID ? row.timestamp : undefined;
      // Only successful cc_prepare claims earlier planning. Merely opening a task
      // or discussing it with Orchestrator must not reassign unrelated spending.
      if (row.state.claimPlanning && context.taskID) {
        let id = row.parentId; const seen = new Set();
        while (id && !seen.has(id)) {
          seen.add(id);
          if (contexts.get(id)?.taskID) break;
          const record = records.get(id);
          if (record && !record.taskID && record.role === 'planner') { record.taskID = context.taskID; record.assignedAt = row.timestamp; }
          id = ancestors.get(id);
        }
      }
    }
    contexts.set(row.id, context); ancestors.set(row.id, row.parentId);
    if (row.accounting) {
      const key = row.id && row.timestamp ? row.key : `${session}:${++ordinal}:${row.key}`;
      records.set(row.id ?? key, { key, taskID: context.taskID, assignedAt: context.assignedAt, role: descriptor.stage === 'knowledge' ? `${context.role} · KB` : context.role,
        model: row.unknownModel ? 'unknown' : context.model ?? 'unknown', kind: row.kind, usage: row.usage,
        stopReason: row.stopReason, session });
    }
  }
  return [...records.values()];
}

function empty() {
  return { tokens: Object.fromEntries(TOKEN_KINDS.map(key => [key, 0])), total: 0, responses: 0, auxiliary: 0, failed: 0,
    missingUsage: 0, unknownPriceTokens: 0, knownCost: 0, cost: 0,
    costs: Object.fromEntries(TOKEN_KINDS.map(key => [key, 0])), unknownPrices: new Set(), sessions: new Set() };
}
function add(total, record, prices) {
  total.sessions.add(record.session);
  if (record.kind === 'assistant') total.responses++; else total.auxiliary++;
  if (['error', 'aborted'].includes(record.stopReason)) total.failed++;
  if (!record.usage || TOKEN_KINDS.some(key => record.usage[key] === null)) total.missingUsage++;
  for (const key of TOKEN_KINDS) {
    const count = record.usage?.[key] ?? 0;
    total.tokens[key] += count; total.total += count;
    const rate = prices.models[record.model]?.[key];
    if (count > 0 && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
      total.unknownPriceTokens += count; total.unknownPrices.add(`${record.model} · ${key}`);
    } else if (count > 0) { const cost = count * rate / 1_000_000; total.knownCost += cost; total.costs[key] += cost; }
  }
}
function finish(total) {
  return { ...total, cost: total.missingUsage || total.unknownPriceTokens ? null : total.knownCost,
    sessions: total.sessions.size, unknownPrices: [...total.unknownPrices].sort() };
}

export function summarizeUsage(records, prices, taskID) {
  const total = empty(), models = new Map(), roles = new Map(), tasks = new Map();
  for (const record of records) {
    if (taskID !== undefined && record.taskID !== taskID) continue;
    add(total, record, prices);
    for (const [groups, label] of [[models, record.model], [roles, record.role], [tasks, record.taskID ?? '']]) {
      if (!groups.has(label)) groups.set(label, empty());
      add(groups.get(label), record, prices);
    }
  }
  const groups = map => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, ...finish(value) }));
  return { ...finish(total), models: groups(models), roles: groups(roles), tasks: groups(tasks), taskID };
}

export function createUsageReader(profile) {
  const cache = new Map(); let lastRead = 0, snapshot;
  return ({ force = false } = {}) => {
    if (!force && snapshot && Date.now() - lastRead < 1000) return snapshot;
    const files = [], warnings = new Set(), tasks = new Set();
    sessionFiles(path.join(profile.commandCenter, '.pi/sessions'), { foreground: true }, files, warnings);
    for (const item of directoryEntries(profile.stateRoot, warnings)) {
      if (!item.isDirectory() || !validTask(item.name)) continue;
      const root = path.join(profile.stateRoot, item.name);
      if (fs.existsSync(path.join(root, 'state.json'))) tasks.add(item.name);
      sessionFiles(path.join(root, 'pi-sessions'), { taskID: item.name }, files, warnings);
      sessionFiles(path.join(root, 'knowledge-update/pi-sessions'), { taskID: item.name, stage: 'knowledge' }, files, warnings);
    }
    const unique = new Map(); let incomplete = 0, invalid = 0;
    for (const file of files) {
      try {
        const data = readSession(file.file, cache); invalid += data.invalid; incomplete += Number(data.incomplete);
        for (const record of recordsFrom(data.rows, file)) {
          const prior = unique.get(record.key);
          // The first successful attribution owns shared planning in a fork,
          // regardless of session filenames or filesystem enumeration order.
          if (!prior || (record.taskID && (!prior.taskID || (record.assignedAt && prior.assignedAt && record.assignedAt < prior.assignedAt)))) unique.set(record.key, record);
        }
      } catch (error) { warnings.add(`Не удалось прочитать ${path.basename(file.file)}: ${error.message}`); }
    }
    const present = new Set(files.map(x => x.file));
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
    if (invalid) warnings.add(`Повреждённых строк пропущено: ${invalid}. Итог может быть неполным.`);
    if (incomplete) warnings.add(`Незавершённых строк: ${incomplete}; обновятся после записи.`);
    const records = [...unique.values()], prices = pricing(profile);
    if (prices.error) warnings.add(prices.error);
    if (records.some(x => x.model === 'unknown')) warnings.add('У части записей модель неизвестна; её тариф не применяется.');
    snapshot = { records, prices, taskIDs: [...tasks], warnings: [...warnings], files: files.length, at: new Date().toISOString() };
    lastRead = Date.now(); return snapshot;
  };
}

const number = value => new Intl.NumberFormat('ru-RU').format(value).replace(/\u00a0/g, ' ');
const money = value => value > 0 && value < 0.000001 ? '<0.000001' : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
const escaped = value => String(value).replace(/[|\\`*_<>\r\n\x00-\x1f\x7f]/g, ' ');
const labels = { input: 'Префилл · без кэша', output: 'Генерация', cacheRead: 'Кэш · чтение', cacheWrite: 'Кэш · запись' };
export const costLabel = (total, currency) => total.cost === null ? `неполная · известно ${money(total.knownCost)} ${currency}` : `${money(total.cost)} ${currency}`;

export function usageDocument(snapshot, taskID) {
  const stats = summarizeUsage(snapshot.records, snapshot.prices, taskID), currency = snapshot.prices.currency;
  const table = rows => '| Категория | Токены |\n|---|---:|\n' + rows.map(([name, value]) => `| ${name} | ${number(value)} |`).join('\n');
  let text = `# ${taskID ? `Задача ${escaped(taskID)}` : 'Весь Command Center'}\n\n**Учтено: ${number(stats.total)} токенов · ${costLabel(stats, currency)}**\n\n` +
    (snapshot.warnings.length ? '**Есть неполные данные; подробности в конце отчёта.**\n\n' : '') +
    table(TOKEN_KINDS.map(key => [labels[key], stats.tokens[key]])) +
    `\n\nВесь вход с кэшем: ${number(stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite)}. Генерация включает reasoning, если провайдер учитывает его в output.\n\n` +
    `Ответов модели: ${stats.responses}; компактаций/сводок: ${stats.auxiliary}; сессий: ${stats.sessions}; ошибок/отмен: ${stats.failed}.\n\n`;
  if (stats.missingUsage) text += `**Usage отсутствует или неполон у ${stats.missingUsage} записей. Показана известная часть токенов.**\n\n`;
  if (stats.unknownPriceTokens) text += `**Без тарифа: ${number(stats.unknownPriceTokens)} токенов. Полная стоимость неизвестна.**\n\n`;
  const breakdown = (title, rows) => rows.length ? `## ${title}\n\n` + rows.map(row =>
    `### ${escaped(row.name || 'CC · без привязки к задаче')}\n\n${number(row.total)} токенов · ${costLabel(row, currency)}\n\n` +
    `Префилл ${number(row.tokens.input)} · генерация ${number(row.tokens.output)} · кэш чтение ${number(row.tokens.cacheRead)} / запись ${number(row.tokens.cacheWrite)}\n`).join('\n') + '\n' : '';
  text += breakdown('По агентам', stats.roles) + breakdown('По моделям', stats.models);
  if (taskID === undefined) text += breakdown('По задачам', stats.tasks);
  text += '## Тарифы за 1 000 000 токенов\n\n';
  text += snapshot.prices.filename ? `Файл: ${escaped(snapshot.prices.filename)}\n\n` : 'Задайте pi.pricingFile в профиле CC.\n\n';
  const modelIDs = [...new Set([...Object.keys(snapshot.prices.models), ...stats.models.map(x => x.name)])].sort();
  for (const model of modelIDs) {
    const rates = snapshot.prices.models[model] ?? {};
    text += `**${escaped(model)}**\n\n${TOKEN_KINDS.map(key => `${labels[key]}: ${rates[key] == null ? 'не задано' : `${rates[key]} ${currency}`}`).join(' · ')}\n\n`;
  }
  text += 'Стоимость пересчитывается по текущим ручным тарифам. Это оценка по сохранённым usage, без налогов, скидок и списаний, которые провайдер не вернул.\n\n' +
    'Читается полная история всех веток, включая повторы; скопированная история fork учитывается один раз. Кэш и reasoning повторно к input/output не прибавляются.\n\n' +
    'Planner до успешного prepare входит в «CC · без привязки». После prepare текущая история планирования относится к задаче. Старые записи без такой привязки остаются в общей статистике.\n\n' +
    'Обновление примерно раз в секунду, после сохранения ответа. Оборванный запрос без usage оценить нельзя. Удалённые файлы сессий в статистику не входят.\n';
  if (snapshot.warnings.length) text += '\n## Неполные данные\n\n' + snapshot.warnings.map(x => `- ${escaped(x)}`).join('\n');
  return text;
}
