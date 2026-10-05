// Both adapters emit the same text/tool_use/step_finish/sessionID result envelope.
// OpenCode's existing CLI and persisted sessions remain the default.
export function agentCommand(profile, { directory, role, model, session }) {
  const runtime = profile.agentRuntime;
  if (runtime && runtime.kind !== 'pi') throw new Error(`Unsupported agent runtime: ${runtime.kind}`);
  const command = runtime?.command ?? profile.opencode;
  if (runtime?.kind === 'pi') model = profile.pi?.models?.[role] ?? profile.pi?.model ?? model;
  if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || !x || x.includes('\0'))) throw new Error('Agent runtime requires a literal argv array');
  return [...command, 'run', '--dir', directory, '--agent', role, '--format', 'json',
    ...(session ? ['--session', session] : []), ...(model ? ['--model', model] : [])];
}
