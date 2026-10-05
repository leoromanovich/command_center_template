import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJSON } from '../demo/fixture.mjs';
import { prepare } from '../lib/controller.mjs';
import { agentHistory, agentDocument, transcript } from '../tui/agent-history.mjs';

async function setup(t) {
  const f = await fixture({ scenario: 'pass' });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await prepare(f.profile, f.task); return f;
}
const event = (sessionID, text) => JSON.stringify({sessionID, part: {id: text, type: 'text', text}}) + '\n';
const message = text => ({info: {role: 'assistant'}, parts: [{type: 'text', text}]});

test('history groups continued Builder rounds and keeps reviewer attempts separate; reads no symlinks', async t => {
  const f = await setup(t);
  fs.writeFileSync(path.join(f.stateDir, '1-builder.log'), event('ses_builder', 'one'));
  fs.writeFileSync(path.join(f.stateDir, '2-builder-resume-1.log'), event('ses_builder', 'two'));
  fs.writeFileSync(path.join(f.stateDir, '2-reviewer.log'), event('ses_review', 'review'));
  fs.writeFileSync(path.join(f.stateDir, '2-reviewer-attempt-2.log'), event('ses_retry', 'retry'));
  fs.symlinkSync(path.join(f.stateDir, '1-builder.log'), path.join(f.stateDir, '3-reviewer.log'));
  const dev = path.join(f.stateDir, 'dev-run/round-2-test');fs.mkdirSync(dev, {recursive:true});
  fs.writeFileSync(path.join(dev, 'reviewer.log'), event('ses_execution', 'safe'));
  const h = agentHistory(f.profile, f.id);
  assert.equal(h.entries.length, 4);
  assert.deepEqual(h.entries.find(e => e.session === 'ses_builder').rounds, [1,2]);
  assert.equal(h.entries.find(e => e.session === 'ses_execution').role, 'execution-reviewer');
});

test('transcript retains chronological tools/reasoning, hides prompts, and explicitly bounds large output', () => {
  const messages = [{info:{role:'user'},parts:[{type:'text',text:'private prompt'}]},
    {info:{role:'assistant'},parts:[{type:'reasoning',text:'reasoned explanation'}, {type:'tool',tool:'bash',state:{status:'completed',input:{command:'echo ok'},output:'ok'}}]},message('done')];
  const full=transcript(messages).content;assert(!full.includes('private prompt'));assert(full.includes('reasoned explanation'));
  assert(full.indexOf('reasoned explanation') < full.indexOf('bash'));assert(full.indexOf('bash') < full.indexOf('done'));
  assert(!transcript(messages,{thinking:false}).content.includes('reasoned explanation'));
  assert(transcript(messages,{prompts:true}).content.includes('private prompt'));
  const bounded=transcript([message('x'.repeat(400000))]);assert(bounded.clipped);assert(bounded.content.length < 17000);
});

test('native history is read-only, refreshes partial output, changes filters and requests older messages', async t => {
  const f=await setup(t); fs.writeFileSync(path.join(f.stateDir,'1-builder.log'),event('ses_builder','fallback'));
  let output='initial';const calls=[];
  const api={client:{session:{messages:async args=>{calls.push(args);return {data:[message(output)]};}}}};
  const doc=await agentDocument(api,f.profile,f.id,{live:true});assert(doc.content.includes('initial'));assert.equal(doc.intervalMs,2000);
  output='updated';assert((await doc.refresh()).content.includes('updated'));
  assert.equal(calls[0].directory,f.feature);assert.equal(calls[0].sessionID,'ses_builder');
  doc.controls.find(x=>x.key==='o').run();await doc.refresh();assert.equal(calls.at(-1).limit,200);
  doc.controls.find(x=>x.key==='t').run();assert((await doc.refresh()).source.includes('рассуждения: выкл'));
  const abort=new AbortController();abort.abort();
  api.client.session.messages=async (_,options)=>{assert(options.signal.aborted);throw new Error('aborted');};
  await assert.rejects(doc.refresh({signal:abort.signal}),/aborted/);
});

test('live follows new agent while selected history stays pinned; missing API shows bounded log fallback', async t => {
  const f=await setup(t);const first=path.join(f.stateDir,'1-builder.log');fs.writeFileSync(first,event('ses_builder','builder-log'));
  const selected=agentHistory(f.profile,f.id).entries[0];const calls=[];
  const api={client:{session:{messages:async args=>{calls.push(args.sessionID);return {data:[message(args.sessionID)]};}}}};
  const live=await agentDocument(api,f.profile,f.id,{live:true});const history=await agentDocument(api,f.profile,f.id,{selected});
  const next=path.join(f.stateDir,'1-reviewer.log');fs.writeFileSync(next,event('ses_reviewer','reviewer-log'));fs.utimesSync(next,new Date(),new Date(Date.now()+1000));
  assert((await live.refresh()).content.includes('ses_reviewer'));assert((await history.refresh()).content.includes('ses_builder'));
  api.client.session.messages=async()=>({error:'offline'});
  const fallback=await live.refresh();assert(fallback.content.includes('reviewer-log'));assert(fallback.content.includes('хвост файлов логов'));
  fs.appendFileSync(next,'{unfinished');assert((await live.refresh()).content.includes('reviewer-log'));
});
