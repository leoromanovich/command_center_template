#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import * as loop from './lib/controller.mjs';
import { open, installLauncher } from './lib/launcher.mjs';
import { listTasks, startRun } from './lib/background.mjs';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Value required: ${name}`);
  return args.splice(i, 2)[1];
}

try {
  const profile = option('--profile') ?? process.env.CC_PROFILE;
  const command = args.shift();
  if (!command || command === 'help' || command === '--help') {
    console.log(`Command Center example (Node.js 22+, macOS/Linux)
  node cli.mjs doctor --profile <profile.json>
  node cli.mjs open --profile <profile.json>
  node cli.mjs install-launcher --profile <profile.json>
  node cli.mjs list --profile <profile.json>
  node cli.mjs start <feature-id> --profile <profile.json>
  node cli.mjs resume <feature-id> --profile <profile.json> [--acknowledge-unknown] [--run]
  node cli.mjs prepare <task.json> --profile <profile.json> [--replace]
  node cli.mjs approve <feature-id> <digest> --profile <profile.json>
  node cli.mjs run <feature-id> --profile <profile.json>
  node cli.mjs status <feature-id> --profile <profile.json>
  node cli.mjs resolve-action <feature-id> <request-id> <response.json> --profile <profile.json> [--run]
  node cli.mjs feedback <feature-id> <feedback.txt> --profile <profile.json>
  node cli.mjs accept <feature-id> --profile <profile.json>
  node cli.mjs commit-reviewed <feature-id> <digest> <fingerprint> --profile <profile.json>
  node cli.mjs preview-base <feature-id> --profile <profile.json>
  node cli.mjs refresh-base <feature-id> <preview.json> --profile <profile.json>
  node cli.mjs resolve-hook <feature-id> <mergeRequest|jiraUpdate> <resolution.json> --profile <profile.json>

The /cc menu in OpenCode handles human approvals and responses. These CLI commands are the recovery fallback.
resolve-action records completed/failed/declined; it never executes the proposed command.
OpenCode tools cannot approve their own plan or accept their own result.`);
    process.exit(0);
  }
  if (!profile) throw new Error('--profile or CC_PROFILE is required');
  const p = loop.loadProfile(profile);
  let state;
  if (command === 'doctor') {
    console.log(JSON.stringify({ node: process.version, config: loop.CONFIG_DIR, commandCenter: p.commandCenter,
      worktreeParent: p.worktreeParent, stateRoot: p.stateRoot, draftsRoot: p.draftsRoot,
      repositories: Object.keys(p.repositories), opencode: p.opencode,
      devRun: p.devRun, devCommands: Object.fromEntries(Object.entries(p.repositories).map(([id, repo]) => [id, Object.keys(repo.devCommands ?? {})])),
      note: 'No agents, checks, worktree creation or external services were started.' }, null, 2));
  } else if (command === 'open') {
    await open(p.filename, { check: args.includes('--check'), fresh: args.includes('--new') });
  } else if (command === 'install-launcher') {
    console.log(installLauncher(p.filename));
  } else if (command === 'list') {
    console.log(JSON.stringify(listTasks(p.filename), null, 2));
  } else if (command === 'start') {
    console.log(JSON.stringify(await startRun(p.filename, args[0]), null, 2));
  } else if (command === 'preview-base') {
    console.log(JSON.stringify(await loop.previewBase(p.filename, args[0]), null, 2));
  } else {
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());
    if (command === 'prepare') state = await loop.prepare(p.filename, args[0], { replace: args.includes('--replace') });
    else if (command === 'approve') state = await loop.approve(p.filename, args[0], args[1]);
    else if (command === 'status') state = loop.status(p.filename, args[0]);
    else if (command === 'resume') {
      state = await loop.resume(p.filename, args[0], { acknowledgeUnknown: args.includes('--acknowledge-unknown') });
      if (args.includes('--run')) state = await loop.run(p.filename, args[0], { signal: abort.signal });
    }
    else if (command === 'resolve-action') {
      state = await loop.resolveUserAction(p.filename, args[0], args[1], JSON.parse(fs.readFileSync(path.resolve(args[2]), 'utf8')));
      if (args.includes('--run')) state = await loop.run(p.filename, args[0], { signal: abort.signal });
    }
    else if (command === 'run') state = await loop.run(p.filename, args[0], { signal: abort.signal });
    else if (command === 'feedback') state = await loop.feedback(p.filename, args[0], fs.readFileSync(path.resolve(args[1]), 'utf8'));
    else if (command === 'accept') state = await loop.accept(p.filename, args[0], { signal: abort.signal });
    else if (command === 'commit-reviewed') state = await loop.commitReviewed(p.filename, args[0], {
      signal: abort.signal, expectedDigest: args[1], expectedFingerprint: args[2] });
    else if (command === 'refresh-base') {
      const preview = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
      state = await loop.refreshBase(p.filename, args[0], { signal: abort.signal, expectedDigest: preview.digest, expectedTargets: preview.targets });
    }
    else if (command === 'resolve-hook') state = await loop.resolveHook(p.filename, args[0], args[1], JSON.parse(fs.readFileSync(path.resolve(args[2]), 'utf8')));
    else throw new Error(`Unknown command: ${command}`);
    console.log(JSON.stringify(loop.summary(state), null, 2));
    if (state.status === 'blocked') process.exitCode = 2;
    if (state.status === 'waiting_for_user_action') process.exitCode = 3;
    if (['paused_interrupted', 'committing_reviewed', 'refreshing_base'].includes(state.status)) process.exitCode = 4;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
