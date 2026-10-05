import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, writeJSON } from '../core/demo/fixture.mjs';
import { ROOT } from './lib/pi.mjs';
import { git } from '../core/lib/process.mjs';

export async function setupDemo(destination = path.join(ROOT, '.demo'), scenario = 'loop') {
  const f = await fixture({ destination, maxRounds: 6 });
  const profile = JSON.parse(fs.readFileSync(f.profile));
  profile.agentRuntime = { kind: 'pi', command: [process.execPath, path.join(ROOT, 'worker.mjs')] };
  profile.pi = { demo: true, scenario, model: 'cc-demo/scripted', explorerLimit: 4 };
  profile.timeoutSeconds = 120;
  profile.recovery = { maxAttempts: 1 };
  profile.git = { allowCommit: true, allowPush: false };
  for (const [id, repo] of Object.entries(profile.repositories)) {
    await git(path.join(f.feature, id), 'branch', '-m', `feature/${f.id}`);
    repo.baseRef = 'main';
  }
  writeJSON(f.profile, profile);
  fs.writeFileSync(path.join(f.commandCenter, '.gitignore'), '.opencode-loop-state/\n.opencode-plans/\n.pi/sessions/\nWorkTree/\n');
  return f;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = await setupDemo(process.argv[2]);
  console.log(`Created ${f.base}\nRun ./start --demo from ${ROOT}`);
}
