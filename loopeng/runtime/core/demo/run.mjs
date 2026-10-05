import { fixture } from './fixture.mjs';
import { prepare, approve, run, summary } from '../lib/controller.mjs';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out')) throw new Error('Usage: node demo/run.mjs [--out /new/directory]');
const f = await fixture({ destination: args[1] });
console.log(`Demo workspace: ${f.base}\nAgents: local simulation. Network and external integrations: absent.`);
const plan = await prepare(f.profile, f.task);
console.log('Demo simulates user approval of the authored fixture plan. Real tasks require CLI approve.');
await approve(f.profile, f.id, plan.digest);
const state = await run(f.profile, f.id);
console.log(JSON.stringify(summary(state), null, 2));
console.log(`Inspect logs: ${f.stateDir}\nProfile for status/feedback/accept: ${f.profile}`);
if (state.status !== 'ready_for_user' || state.round !== 3) process.exitCode = 1;
