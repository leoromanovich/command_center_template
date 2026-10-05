import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, status } from './lib/controller.mjs';
import { atomicJSON, delay } from './lib/recovery.mjs';
import { runKnowledge, publishKnowledge } from './lib/knowledge.mjs';

const [profilePath, id, token] = process.argv.slice(2);
const profile = loadProfile(profilePath), main = status(profilePath, id);
const file = path.join(profile.stateRoot, main.id, 'knowledge-update/job.json');
for (let i = 0; i < 100; i++) {
  const job = JSON.parse(fs.readFileSync(file));
  if (job.token !== token) throw new Error('Superseded knowledge runner');
  if (job.owner.pid === process.pid) break;
  if (i === 99) throw new Error('Knowledge launch handshake failed');
  await delay(20);
}
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
try {
  const job = JSON.parse(fs.readFileSync(file));
  const result = await (job.action === 'update' ? runKnowledge : publishKnowledge)(profilePath, id, { ...job, signal: abort.signal });
  atomicJSON(file, { ...job, status: 'finished', result: result.status, ended: new Date().toISOString() });
} catch (error) {
  const job = JSON.parse(fs.readFileSync(file));
  atomicJSON(file, { ...job, status: 'failed', error: error.message, ended: new Date().toISOString() });
  process.exitCode = 1;
}
