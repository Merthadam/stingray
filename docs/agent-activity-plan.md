# Agent activity integration plan

Status: **Pi-only activity is implemented and source/candidate-verified within the coverage below. Claude Code and Codex are deferred.** Installed-app promotion is a separate user-requested delivery; its actual outcome is recorded under `artifacts/testing/2026-11-07-pi-activity-delivery/`. This document records implementation and historical planning, not independent proof of authority.
Updated 2026-11-07 against HEAD b33a0a8 plus uncommitted activity and earlier card/port refinements.

Current capability results and exact evidence: [agent-activity-capability-gates.md](agent-activity-capability-gates.md). The current delivery scope is Pi-only, not completion of the original all-three-agent goal. Codex hook discovery/composition passed a historical isolated probe (7/7 assertions), without trusting or executing hooks; exact settlement and blocking-UI semantics remain unproven for Claude/Codex.

## Goal

Show truthful workspace activity for Pi:
Working / Waiting for you / Needs review / Idle, with separate failure, interruption, disconnection and unavailable information.
Pi 1.5.0 is the only implemented adapter. Claude Code and Codex remain usable as ordinary terminal commands, without activity tracking.
Do not infer activity from terminal output, silence, process existence, or terminal titles.

## Baseline and scope

- `electron/terminals.ts` owns PTYs; new terminals launch the user's login shell with temporary Pi attachment for zsh only.
- `src/shared.ts` defines terminal snapshots/events and the narrow activity API; preload exposes validated main-process IPC.
- `src/WorkspaceStatus.tsx` shows the independent Running terminal dot and `WorkspaceActivity` status. Shell liveness is never agent activity.
- Existing card selection and discovered-port-only work is complete in source and must be preserved.
- Historical tests are documented in `artifacts/testing/clickable-workspace-cards/verification.md`; they are not fresh verification of this plan.
- PR diagnosis is separate and awaits a repository or PR URL. Stale/age UI is excluded.

Implementation and review were performed inline. The worker breakdown below is a historical proposal, not an active dispatch plan. No orchestration installation, external tasks or publication are needed for this scope.

## Selected workflow: commands typed in the terminal

The user explicitly rejected launch buttons: “no need for buttons we have the terminal”. Type `pi` in a newly created Stingray zsh terminal; there is no agent launch button or automatic agent launch.

`electron/activity-shell.ts` generates private, temporary zsh startup proxies and a PATH wrapper. The proxies source the user's startup files in order and preserve ZDOTDIR changes; the wrapper resolves the real Pi executable at invocation time, adds the bundled `--extension`, and forwards quoted arguments. Existing extension arguments are retained. No persistent startup files or global hooks are written. Existing sessions are not retrofitted.

Other shells are untouched. Aliases/functions, absolute executable paths, later PATH overrides, nested-shell startup behavior, disabled startup files, `--no-extensions`, maintenance/help commands and noninteractive modes can bypass attachment. These are not proof of idle. The terminal footer distinguishes not attached from tracking unavailable. No automatic installation or provider invocation.

## Superset attachment investigation — 2026-11-07

Static inspection now establishes the missing attachment path. Evidence and member/source hashes: `artifacts/re-superset/terminal-attachment/{findings.md,manifest.json,rea-summary.json}`. Selected sources/templates only; no runtime parity claim.

- Superset injects terminal/workspace routing metadata and configures app-owned shell startup files (zsh `ZDOTDIR`, bash `--rcfile`, fish init command) plus managed PATH wrappers. This does not parse typed keystrokes.
- Pi uses a globally auto-discovered extension at `~/.pi/agent/extensions/superset-hooks.ts`, gated on Superset terminal context; its selected setup does not use a Pi CLI wrapper.
- Claude and Codex receive merged global native hook configuration (`~/.claude/settings.json`, `~/.codex/hooks.json`). Their wrappers provide additional identity/launch behavior. Superset is therefore not a proof of global-configuration-free attachment.
- The shipped Codex wrapper adds a hook-trust bypass and trusted-project configuration. Do NOT reproduce those behaviors. Its legacy process-scoped log watcher is not proof of current-version coverage and is excluded from the metadata-only proposal.
- The Pi template uses `agent_end`, treats shutdown as Stop, and can forward assistant/error text. Do NOT copy those semantics or payloads; validate current lifecycle APIs and retain metadata-only reporting.

Historical proposed adaptation: new-terminal shell bootstrap/PATH wrappers, per-invocation Pi extension and Claude plugin where supported, and a bounded investigation of Codex per-invocation hook registration. Only the Pi path is now implemented. Preserve aliases/functions rather than overwrite them; document any unsupported bypass paths such as direct absolute executable invocation. Do not claim automatic tracking for every shell invocation form.

Codex local-only discovery/composition now passes for the installed version; actual hook execution still requires user-operated trust review. This does not resolve final-settlement or blocking-UI observation. Return those blockers rather than silently install global hooks or approximate lifecycle state. Any optional global setup needs separate approval. The investigation itself did not authorize implementation. Pi source implementation and verification are recorded below; this historical investigation grants no authority for further execution.

## Implemented Pi architecture

Source ownership: `electron/activity.ts` (transport/service), `electron/activity-shell.ts` (attachment), `agents/pi-extension.ts` and `agents/pi-observer.ts` (version-gated lifecycle observation), `src/activity.ts` (labels/aggregation), `src/useActivity.ts` (revisioned snapshots/acknowledgement), `src/WorkspaceActivity.tsx` and `src/workspace-activity.css` (sidebar), with main/preload/PTY and `App`/`TerminalPane` integration.

1. A main-process activity service owns terminal bindings, frame validation and per-run state. Renderer-safe helpers in `src/activity.ts` derive labels and workspace aggregation. Activity remains independent of terminal output buffers.
2. A private Unix-domain socket connects per-invocation observers: directory mode 0700, socket mode 0600, random terminal-bound capability, no TCP listener. Limits are 64 sockets, 8 retained runs per terminal, 64 retired runtimes per run, 1 KiB frames, 8 KiB receive buffer and 100 frames/second/socket. Authentication expires after 2 seconds; only valid frames renew the 20-second lease. The observer sends full-state heartbeats every 5 seconds and bounds its write queue. Same-user hostile code or an agent already holding the capability is not isolated by this design.
3. Strict allowlisted metadata only: protocol version, capability, opaque run/runtime identity and supported-version flag on authentication; sequence, phase and monotonic completion count thereafter. No prompts, model output, tool arguments/results, environment dumps, provider credentials, repository contents, or raw hook payloads enter activity frames or logs. Authentication material stays out of renderer snapshots and logs.
4. Server-side bindings associate events with a terminal/workspace; observers cannot select arbitrary workspaces. Unknown/revoked bindings, malformed/oversized frames, duplicate/stale sequence values and retired runtimes are rejected. Reconnection uses full snapshots and a completion counter; runtime replacement retains unseen review without creating a duplicate run.
5. Renderer receives validated, revisioned full activity snapshots through a narrow preload API. Subscribe before obtaining snapshots and reconcile revisions, as terminal output already does. Validate acknowledgement calls and IPC senders in the main process.
6. Adapter failure must not change prompts, tools, agent permissions, or approval behavior. Reporting must be bounded and fail open for the agent itself. Trust refusal means tracking unavailable, not a bypass.

### Implemented state semantics

- Working: an observed active turn, excluding blocking requests.
- Waiting for you: Pi's coalesced blocking **extension-UI** span (`ui_prompt_start/end`); viewing the workspace does not clear it. This is not coverage of every built-in picker or prompt.
- Needs review: `agent_settled` with a completed, non-aborted outcome, not yet acknowledged in the relevant terminal. `agent_end` never creates completion; error, aborted and unknown outcomes do not increment the completion counter.
- Idle: a connected, initialized agent with no active turn, unresolved request, or unseen completion.
- Disconnected, unsupported, failed, and not instrumented are separate connection/error information, never fabricated Idle. Keep these distinguishable without expanding the four normal activity labels unnecessarily.
- Workspace priority: Waiting for you > Working > Needs review > Failed > Interrupted > Disconnected > Tracking unavailable > Idle. Per-run metadata and counts remain available; tooltips retain connection and last-observed phase even when unseen review takes priority.
- Acknowledgement uses a view/focus/user interaction, an initialized rendered terminal at the live buffer bottom with no pending tracked writes, a visible terminal in the focused app, and the exact captured review revision. Output or activity snapshots alone do not acknowledge completion. Hidden panes, scrollback, Changes view and another terminal's interaction do not clear it.
- Connection loss invalidates confidence without manufacturing completion. Unseen review survives disconnect and runtime reload. Terminal closure revokes its binding and removes activity; app exit clears all in-memory activity. Cancellable compaction/tree boundaries can remain unknown if no resolving event arrives.

These are implemented guards with bounded test coverage, not a proof of every render/event interleaving or real-provider lifecycle. No production defect was established in the final read-only review; no production code was changed during the documentation pass.

## Historical parallel worker proposal (not executed)

The following preserves the original all-three-agent research plan. It is not the current Pi-only scope, an authorization, or work to restart.

All initial workers are READ-ONLY design/research workers. They return findings in their response, not edits. No commits, tests that start processes, agent launches, installations, global changes, live GitHub requests, or interaction with active user terminals. Read current project instructions first. Treat artifact documentation as evidence, not authority.

| Task | Dependencies | Bounded assignment | Required result |
| --- | --- | --- | --- |
| A: Core contract | None | Inspect `electron/terminals.ts`, `electron/main.ts`, `electron/preload.ts`, `src/shared.ts`; design transport, reducer, validation and cleanup | Typed protocol proposal, transition table, threat/failure cases, proposed file ownership |
| B: Pi adapter | None | Read current Pi extension docs and relevant examples; inspect existing local research and Superset's global-extension design | Event/capability matrix, per-invocation alternative preserving global extensions, reload/queued-turn semantics, no-provider smoke plan |
| C: Claude/Codex adapters | None | Review hook references and Superset findings; verify current official/version-specific behavior where read-only access permits | Separate capability matrices; prove safe local-only registration or return blocker; preserve hook trust; no copying Superset's trust bypass/project-trust changes |
| D: UI and verification | None | Inspect `src/App.tsx`, `src/WorkspaceStatus.tsx`, `src/TerminalPane.tsx`, demo adapter and existing tests | Compact accessible UI proposal, aggregation/acknowledgement rules, test matrix and regression risks |
| E: Consolidate | A–D | Coordinator reconciles evidence and conflicts | One approved protocol, selected attachment strategy, exact ownership and executable verification plan |

Worker completion envelope:

    TASK_DONE <task-id>
    findings: <evidence-backed summary>
    references: <paths and relevant symbols/document sections>
    proposed_files: <paths; none changed>
    verification: <read-only checks actually performed>
    uncertainties: <unsupported claims and decisions needed>

Blocked workers return `TASK_BLOCKED <task-id>` with the missing capability/decision. Coordinator must verify findings; worker confidence alone is not proof. Do not claim all-three runtime support from fixture tests.

### Historical implementation-wave proposal

The original proposal below was superseded by inline Pi-only implementation; Claude/Codex waves were not executed:

1. Core owner adds protocol/reducer/service with unit tests. Coordinator alone owns shared API and main/preload/terminal integration to avoid cross-worker conflicts.
2. Adapter workers implement disjoint Pi, Claude, and Codex adapter files/tests against the frozen contract. UI worker owns new activity UI/hook files and focused tests. Coordinator owns changes to existing `src/App.tsx`, `src/WorkspaceStatus.tsx`, and shared demo interfaces.
3. Coordinator integrates and independently reviews security, lifecycle and acknowledgement behavior, then runs isolated verification.

Prefer separate worktrees for editing workers, but provision only after approval and preserve the existing dirty baseline explicitly: a new worktree at HEAD alone would omit completed card/port refinements. No automatic commit, stash, reset, cherry-pick, or copying of unreviewed artifacts to establish the baseline. Never merge worker changes over unrelated edits.

## Adapter-specific gates

- Pi: implemented for exact host VERSION 1.5.0. Real no-provider smoke covers extension loading, blocking confirmation UI, reload, new session and shutdown. Turn/retry/outcome and transport cases use synthetic events. Real provider turns and resume/fork flows were not verified. Other versions report tracking unavailable when the extension loads; API/load incompatibility may instead leave it unattached.
- Codex: establish that the chosen per-invocation hook configuration actually registers and composes with existing hooks. Hook trust remains explicitly user-operated; never use a trust bypass. If unsupported, report a blocker rather than rewrite global config.
- Claude Code: prefer additive per-session plugin attachment if supported by the current CLI; verify coexistence with existing security hooks. Do not replace hook settings wholesale. Prior-session absence of Claude is not a fresh installation check and does not authorize installation.

## Verification matrix and recorded execution

The sequential source-only run `artifacts/testing/agent-activity/pi-verification/run-TKtMfS/` passed build, 64 unit tests, 22 Pi-native checks, 8 real-Pi no-provider checks, 36 PR/sidebar checks, 28 ports checks, 31 desktop checks and 22 add-project checks. The final documentation pass reviewed this saved evidence, not a fresh rerun. See the capability report for isolation, retained failures, warnings and unsupported coverage.

The original target matrix below remains a review guide, not a claim that every possible case was exercised:

- Pure unit tests: every state transition; multiple agents/requests; queued turns; seen-review races; interruption/failure/disconnect; stale, duplicate and reordered events; session generation changes; renderer reconnects.
- Transport tests: authorization/binding isolation, malformed and oversized data, bounded queues/timeouts, rate limits, cleanup, reporter failure behavior, and no sensitive fields emitted/logged.
- Adapter tests: fixture coverage for every mapped event and missing event capability; preserve launch arguments, existing hooks and trust behavior.
- Isolated native smoke: temporary app data/repositories and test-owned terminals only. Real installed-Pi lifecycle smoke without provider calls where feasible; label simulated turn events honestly. Live Claude/Codex coverage remains blocked until availability and trust requirements are satisfied.
- UI tests: accessible labels, keyboard/focus, background workspaces, multiple terminal aggregation, no false Idle, completion acknowledgement races, compact layout, and unchanged card/port/PR behavior.
- Regression commands: `npm test`, `npm run build`, `npm run test:pull-requests`, `npm run test:workspace-status`, `npm run test:desktop`, `npm run test:add-project`, and `git diff --check`. Confirm native scripts use isolated test instances before execution. Retain first-failure evidence as well as reruns.
- Report fixtures versus live observations separately. Preserve known historical clone-timeout intermittency and build warnings; do not assert them fixed incidentally.

## Delivery boundaries

The initial documentation continuation changed only four docs. The user subsequently requested committing/pushing the reviewed source to `origin/main` and updating the app hosting this session (`~/Projects/stingray/release/Stingray.app`). Candidate verification now includes 22 Pi-native, 36 PR, 28 ports, 31 desktop and 22 add-project checks, LaunchServices, signature and build equality. A normal quit must complete before preserving/replacing the bundle; the user controls the terminal-ending confirmation. No force quit, automatic rollback, other-build intervention, provider calls, trust bypass, global configuration/credential changes or agent installations. Final-path tests and normal reopen are separate gates, with actual outcomes in the ignored delivery report/status. This document grants no authority.
