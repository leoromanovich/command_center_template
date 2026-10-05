import fs from 'node:fs';
import path from 'node:path';
import { requestUserAction } from '../lib/user-actions.mjs';
const scenario = process.argv[2];
const role = process.env.CC_WORKER_ROLE;
const round = Number(process.env.CC_ROUND);
const prompt = fs.readFileSync(0, 'utf8');
if (!prompt.includes('PLAN') || !prompt.includes('REPOSITORIES')) throw new Error('Missing worker context');
const resumed = process.argv.includes('--session');
const configuredEffort = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).agent?.[role]?.reasoningEffort;
fs.appendFileSync(path.join(process.env.CC_RUN_DIR, 'mock-agents.jsonl'), JSON.stringify({ role, round, resumed, cwd: process.cwd(), configuredEffort }) + '\n');
const history = fs.readFileSync(path.join(process.env.CC_RUN_DIR, 'mock-agents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const attempt = history.filter(item => item.role === role).length;
console.log(JSON.stringify({ type: 'step_start', sessionID: role === 'builder' ? 'demo-builder-session' : `demo-review-${round}-${attempt}` }));
if (scenario === 'hang-builder-once' && role === 'builder' && attempt === 1) {
  fs.writeFileSync('app/value.txt', 'partial write before interruption\n');
  await new Promise(resolve => setTimeout(resolve, 60000));
}
if ((scenario === 'network-builder-once' && role === 'builder' && attempt === 1) ||
    (scenario === 'network-reviewer-once' && role === 'reviewer' && attempt === 1) ||
    (scenario === 'network-builder-always' && role === 'builder')) {
  console.log(JSON.stringify({ type: 'error', error: { statusCode: 503, message: 'Simulated connection reset' } }));
  process.exit(1);
}
let text;
if (role === 'builder') {
  if (scenario.startsWith('user-action') && !prompt.includes('"source":"user_action"')) {
    const request = requestUserAction({ repo: 'app', title: 'Inspect host prerequisite',
      reason: 'Host prerequisite information is needed before continuing the fixture task',
      why_agent_cannot: 'Privileged or unconfigured commands must be performed by the user',
      commands: [{ command: 'sudo --version', cwd: process.cwd() }, { command: 'touch user-action-executed.txt', cwd: process.cwd() }],
      expected_result: 'Return the command result or explain why it cannot be performed', risks: 'First command inspects sudo; second creates a fixture marker if manually executed',
    }, { stateDir: process.env.CC_RUN_DIR, featureRoot: process.env.CC_WORKER_ROOT, round, sessionID: 'demo-builder-session' });
    console.log(JSON.stringify({ type: 'tool_use', sessionID: 'demo-builder-session', part: { tool: 'request_user_action', state: { status: 'completed', output: JSON.stringify(request) } } }));
    if (scenario === 'user-action-crash') throw new Error('Simulated crash after a persisted request');
    text = `Waiting for user action ${request.id}.`;
  } else {
  const lintFails = scenario === 'always-fail' || (scenario === 'loop' && round === 1);
  fs.writeFileSync('app/value.txt', lintFails ? 'lint-error  \n' : `valid app ${round}  \n`);
  fs.writeFileSync('library/value.txt', `valid library ${round}  \n`);
  fs.writeFileSync('library/new.txt', `New file in round ${round}\n`);
  text = `Demo Builder finished round ${round}.`;
  }
} else if (role === 'reviewer') {
  if (scenario === 'reviewer-write') fs.appendFileSync('app/value.txt', 'changed during review\n');
  const changes = scenario === 'loop' && round === 2;
  text = scenario === 'invalid-review' ? 'Looks good!' : JSON.stringify({
    verdict: changes ? 'changes_requested' : 'approved', summary: changes ? 'Fix library edge case' : 'Demo review passed',
    findings: changes ? [{ severity: 'blocking', repository: 'library', path: 'value.txt', reason: 'Demo edge case is incomplete', fix: 'Complete the library change' }] : [],
  });
} else throw new Error(`Unexpected worker role: ${role}`);
if (role === 'reviewer' && scenario !== 'invalid-review') console.log(JSON.stringify({ type: 'tool_use', part: { tool: 'review_submit', state: { status: 'completed', output: text } } }));
console.log(JSON.stringify({ type: 'text', sessionID: role === 'builder' ? 'demo-builder-session' : `demo-review-${round}`, part: { text } }));
