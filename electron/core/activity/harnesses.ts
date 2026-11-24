import type { HarnessId } from '../../../shared/contracts/activity';

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** App-owned inputs for attaching an agent CLI typed in a Stingray terminal. */
export type HarnessContext = {
  bin: string;        // the app-owned PATH wrapper directory (skipped when resolving the real CLI)
  extension: string;  // bundled Pi extension
  hookClient: string; // bundled hook-client.cjs
  execPath: string;   // Electron binary, run as plain Node for the hook client
  endpoint: string;   // activity socket
  claudeSettings: string; // app-owned Claude Code settings file (see claudeSettings)
};
/** How a harness reports: Pi streams from an in-process extension; Claude Code hooks and Codex notify
 * spawn the short-lived hook client per event. Each wrapper only adds per-invocation flags. */
export type HarnessAdapter = { id: HarnessId; command: string; name: string; wrapper(ctx: HarnessContext): string };

type WrapperSpec = {
  command: string; name: string;
  passCommands: string[]; // first-argument subcommands that run unattached (maintenance, non-interactive)
  passFlags: string[];    // any argument before `--` that runs unattached (help/version/non-interactive/explicit opt-out); `x*` globs allowed
  passConfig?: string[];  // `-c`/`--config` values that run unattached; `x*` globs allowed
  launch: string;         // shell that execs "$sr_real" with attachment
};
function wrapper(bin: string, spec: WrapperSpec) {
  return `#!/bin/sh
# Resolve the real command at invocation time, not at app startup. No eval.
sr_rest=$PATH
sr_clean=
sr_first=1
while :; do
  case "$sr_rest" in *:*) sr_part=\${sr_rest%%:*}; sr_rest=\${sr_rest#*:}; sr_more=1;; *) sr_part=$sr_rest; sr_more=0;; esac
  if [ "$sr_part" != ${shellQuote(bin)} ]; then
    if [ "$sr_first" = 1 ]; then sr_clean=$sr_part; sr_first=0; else sr_clean=$sr_clean:$sr_part; fi
  fi
  [ "$sr_more" = 1 ] || break
done
sr_real=$(PATH="$sr_clean" command -v ${spec.command}) || { printf '%s\\n' '${spec.name} is not installed on this terminal PATH.' >&2; exit 127; }
if [ "$sr_real" -ef "$0" ]; then printf '%s\\n' '${spec.name} wrapper loop refused. Use the real ${spec.name} executable.' >&2; exit 127; fi
# Preserve maintenance/help/explicitly disabled and non-interactive invocations.
if [ ! -t 0 ] || [ ! -t 1 ]; then exec "$sr_real" "$@"; fi
case "\${1-}" in ${spec.passCommands.join('|')}) exec "$sr_real" "$@";; esac
sr_prev=
for sr_arg in "$@"; do
  [ "$sr_arg" = -- ] && break
  case "$sr_arg" in ${spec.passFlags.join('|')}) exec "$sr_real" "$@";; esac
${spec.passConfig ? `  case "$sr_prev" in -c|--config) case "$sr_arg" in ${spec.passConfig.join('|')}) exec "$sr_real" "$@";; esac;; esac
  case "$sr_arg" in ${spec.passConfig.map(p => `--config=${p}`).join('|')}) exec "$sr_real" "$@";; esac
` : ''}  sr_prev=$sr_arg
done
${spec.launch}`;
}

// argv, not shell syntax: Codex runs notify without a shell. Terminals strip ELECTRON_* from the user environment.
const hookRunner = (ctx: HarnessContext, harness: string) => ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', ctx.execPath, ctx.hookClient, harness];

export const pi: HarnessAdapter = {
  id: 'pi', command: 'pi', name: 'Pi',
  wrapper: ctx => wrapper(ctx.bin, {
    command: 'pi', name: 'Pi',
    passCommands: ['install', 'remove', 'update', 'list', 'config', 'uninstall', 'auth', 'mcp'],
    passFlags: ['--help', '-h', '--version', '-v', '--no-extensions', '-ne', '--print', '-p', '--mode', '--mode=*', '--list-models', '--export'],
    launch: `unset STINGRAY_PI_RUN STINGRAY_PI_PID
exec "$sr_real" --extension ${shellQuote(ctx.extension)} "$@"
`,
  }),
};

/** Hook events Stingray registers; the hook client maps each to a phase (agents/hook-client.ts).
 * No PreToolUse: UserPromptSubmit already means Working; PostToolUse only resumes Working after a permission prompt. */
export const claudeHookEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const;
/** Per-tool hooks run in the background (`async`): a cold hook client start (~1.4 s) must not delay every tool call. */
const claudeAsyncHooks: readonly string[] = ['PostToolUse'];
/** Passed with `--settings <file>`: Claude Code merges it with user/project settings and runs hooks from every
 * source, so user hooks stay intact. Hooks print nothing and exit 0, so they never block or alter a decision. */
export const claudeSettings = (ctx: HarnessContext) => JSON.stringify({
  hooks: Object.fromEntries(claudeHookEvents.map(event => [event, [{ hooks: [{
    type: 'command', command: [...hookRunner(ctx, 'claude'), event].map(shellQuote).join(' '), timeout: 5, ...claudeAsyncHooks.includes(event) && { async: true },
  }] }]])),
}, null, 2) + '\n';

export const claude: HarnessAdapter = {
  id: 'claude', command: 'claude', name: 'Claude Code',
  wrapper: ctx => wrapper(ctx.bin, {
    command: 'claude', name: 'Claude Code',
    passCommands: ['config', 'mcp', 'plugin', 'plugins', 'install', 'update', 'upgrade', 'doctor', 'setup-token', 'migrate-installer', 'auth', 'agents'],
    // An explicit --settings is the user's own: do not guess how two flag files combine. --bare skips hooks.
    passFlags: ['--help', '-h', '--version', '-v', '--print', '-p', '--settings', '--settings=*', '--bare'],
    // exec keeps this pid: the hook client reports it so the service notices a crash without SessionEnd.
    launch: `STINGRAY_AGENT_PID=$$
export STINGRAY_AGENT_PID
exec "$sr_real" --settings ${shellQuote(ctx.claudeSettings)} "$@"
`,
  }),
};

/** Codex hooks need persisted user trust (no bypass is used), so only the legacy `notify` program is attached:
 * agent-turn-complete -> completion. A user-configured notify is never overridden: such invocations run unattached. */
export const codex: HarnessAdapter = {
  id: 'codex', command: 'codex', name: 'Codex',
  wrapper: ctx => {
    const runner = hookRunner(ctx, 'codex');
    // TOML array of JSON strings; the run nonce (hex) and pid (numeric) are shell values appended at invocation.
    const notify = `notify=[${[...runner, 'notify', ctx.endpoint].map(v => JSON.stringify(v)).join(',')},"`;
    return wrapper(ctx.bin, {
      command: 'codex', name: 'Codex',
      passCommands: ['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help', 'agents'],
      passFlags: ['--help', '-h', '--version', '-V', '--remote', '--remote=*'],
      passConfig: ['notify=*', "'notify '*"],
      launch: `sr_home=\${CODEX_HOME:-$HOME/.codex}
for sr_config in "$sr_home"/config.toml "$sr_home"/*.config.toml; do
  if [ -f "$sr_config" ] && grep -q '^[[:space:]]*notify[[:space:]]*=' "$sr_config"; then exec "$sr_real" "$@"; fi
done
sr_token=\${STINGRAY_ACTIVITY_TOKEN-}
case "$sr_token" in *[!a-f0-9]*|'') exec "$sr_real" "$@";; esac
[ \${#sr_token} = 64 ] || exec "$sr_real" "$@"
# argv is world-readable (ps): it gets a per-run nonce, never the terminal token, which start reads from the environment.
sr_run=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
case "$sr_run" in *[!a-f0-9]*|'') exec "$sr_real" "$@";; esac
[ \${#sr_run} = 64 ] || exec "$sr_real" "$@"
# exec keeps this pid ($$) for Codex: it identifies the run and its liveness. Registered in the background.
# Its own session (setsid on Linux, Perl's POSIX::setsid on macOS): a terminal hangup during Node's cold start would
# otherwise kill it before it installs its SIGHUP handler (Node resets inherited ignored signals, so \`trap '' HUP\` cannot help).
sr_detach() {
  if command -v setsid >/dev/null 2>&1; then setsid "$@"
  elif command -v perl >/dev/null 2>&1; then perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 0' "$@"
  else "$@"; fi
}
# HUP stays ignored (inherited by setsid/perl, which do not reset it) until the new session exists.
(trap '' HUP; sr_detach ${runner.map(shellQuote).join(' ')} start ${shellQuote(ctx.endpoint)} "$sr_run" $$ </dev/null >/dev/null 2>&1) &
exec "$sr_real" -c ${shellQuote(notify)}"$sr_run"'","'$$'"]' "$@"
`,
    });
  },
};

export const harnesses = [pi, claude, codex];
