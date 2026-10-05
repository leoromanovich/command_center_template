import { commandAudit } from './audit.mjs';

export function bashAuditor(context) {
  const calls = new Map();
  const key = input => `${input.sessionID}/${input.callID}`;
  return {
    before(input, args, actor, requested) {
      if (input.tool !== 'bash') return;
      const data = { id: key(input), kind: 'bash', session: input.sessionID, actor,
        command: args.command, cwd: args.workdir ?? context.cwd, requested: Date.now(),
        ...(requested && requested.command !== args.command ? { requested_command: requested.command,
          requested_cwd: requested.workdir ?? context.cwd } : {}) };
      calls.set(data.id, data);
      commandAudit(context, { ...data, phase: 'requested' });
    },
    started(input) {
      const data = calls.get(key(input));
      if (!data || data.started) return;
      data.started = Date.now(); data.cwd = input.cwd;
      commandAudit(context, { ...data, phase: 'started' });
    },
    finish(input, output, error) {
      const data = calls.get(key(input));
      if (!data) return;
      calls.delete(data.id);
      commandAudit(context, { ...data, phase: 'finished', duration_ms: data.started ? Date.now() - data.started : null,
        exit_code: output?.metadata?.exit ?? null, status: error ? (data.started ? 'error' : 'rejected') : 'completed', error });
    },
    event(event) {
      if (event.type !== 'message.part.updated') return;
      const part = event.properties?.part;
      if (part?.type !== 'tool' || part.tool !== 'bash') return;
      if (part.state?.status === 'error') this.finish({ sessionID: part.sessionID, callID: part.callID }, undefined, part.state.error);
    },
  };
}
