// Detached supervisor entrypoint. No user-controlled shell strings are evaluated.
import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, run, accept, commitReviewed, refreshBase, summary } from './lib/controller.mjs';
import { atomicJSON, delay } from './lib/recovery.mjs';
import { publishAccepted, cleanupAccepted } from './lib/publication.mjs';

const [profilePath, id, token, action] = process.argv.slice(2);
const profile = loadProfile(profilePath);
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid feature');
const file = path.join(profile.stateRoot, id, 'job.json');
// Parent persists the worker identity after spawn before it releases the launch gate.
for (let i = 0; i < 100; i++) {
  const job = JSON.parse(fs.readFileSync(file));
  if (job.token !== token) throw new Error('Superseded runner');
  if (job.owner.pid === process.pid) break;
  if (i === 99) throw new Error('Launch handshake failed');
  await delay(20);
}
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
try {
  const approval = JSON.parse(fs.readFileSync(file));
  const perform = { run, accept, 'commit-reviewed': commitReviewed, 'refresh-base': refreshBase, 'publish-accepted': publishAccepted, 'cleanup-accepted': cleanupAccepted }[action];
  if (!perform) throw new Error('Invalid background action');
  const state = await perform(profile.filename, id, { signal: abort.signal,
    expectedFingerprint: approval.expectedFingerprint, expectedDigest: approval.expectedDigest, expectedTargets: approval.expectedTargets,
    expectedToken: approval.expectedToken, mode: approval.mode, message: approval.message });
  console.log(JSON.stringify(summary(state)));
  const job = JSON.parse(fs.readFileSync(file));
  if (job.token === token) atomicJSON(file, { ...job, status: 'finished', result: state.status, ended: new Date().toISOString() });
} catch (error) {
  console.error(error.stack);
  const job = JSON.parse(fs.readFileSync(file));
  if (job.token === token) atomicJSON(file, { ...job, status: 'failed', error: error.message, ended: new Date().toISOString() });
  process.exitCode = 1;
}
