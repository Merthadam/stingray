# Repo Map / main integration review

Date: 2026-11-07. Source-only integration checkpoint; not production delivery or authorization for later work.

## Scope and review

Integrates Repo Map and guarded terminal hyperlinks from `5c8c214` with local main's Pi activity/sidebar/ports checkpoint `c54e255`. Existing histories are preserved by an integration merge on `repo_map`, followed by a fast-forward of local `main` after final checks. No remote push, packaging, dependency installation, installed-app replacement/restart or personal-preview intervention is included.

The final review found no new merge-blocking issue in the inspected integration paths:

- Repo Map replaces Changes while retaining workspace-keyed Git status, sidebar PR/line counts, ports and Pi activity. The Lucide Map icon is aliased so native `Map` construction remains valid. Map results invalidate older status requests before updating the selected workspace's status.
- Sidebar totals remain tracked-only; map per-file/folder counts include untracked files. A regression explicitly verifies this distinction. Shared types, preload and main-process IPC expose both feature sets.
- Terminal hyperlink setup/cleanup coexists with Pi observation and acknowledgement. Main-process validation, workspace containment, default-cancel confirmation and post-confirmation revalidation remain. Native dialogs/OS handlers are stubbed in automated link verification.
- The map tracker explicitly remains unconnected to agent/file attribution and parent/subagent relationships. Existing Pi activity is shown separately in the sidebar. Component preview remains unsupported rather than executing repository source.
- Existing native regressions were adapted to Repo Map selectors, including clean/error states, untracked entries and hidden-terminal acknowledgement. Assertions were retained; workspace buttons use exact names to avoid new sidebar-control ambiguity.
- The read-only inspector retains bounded reads, symlink/ancestry checks and disabled external diff/textconv. This review is not an exhaustive security audit or a hostile-filesystem isolation guarantee.

## Verification evidence

The completed sanitized sequential run is retained locally under `artifacts/testing/agent-activity/pi-verification/run-Viin0N/`; its aggregate `results.json` records every stage exiting 0 with no timeout. The companion log is `artifacts/testing/merge-main/verification-rerun.log`.

| Stage | Result |
| --- | --- |
| TypeScript / Vite / Electron build | Pass |
| Unit/integration | 106/106; no failures, skips or cancellations |
| Repo Map native | 66/66; no renderer errors |
| Terminal links native | 26/26; no renderer errors |
| Pi-native | 22/22; no renderer errors |
| Pull requests/sidebar | 36/36; no renderer errors |
| Workspace ports | 28/28; no renderer errors |
| Desktop | 31/31; no renderer errors |
| Add project | 22/22; no renderer or console issues |

These suites were run during integration and completed after the source-session handoff. The final continuation read their results rather than restarting completed checks; only documentation was changed afterward. Pre-integration build/unit logs are also retained under `artifacts/testing/merge-main/`.

The runner uses sanitized HOME/config/environment, temporary Git repositories, test-owned app data and PTYs. Pi-native uses synthetic events, not a real-provider lifecycle. PR and Docker use strict fixtures; ports use real local PTY HTTP servers and macOS process scanning. Clone transfer uses a local SSH transport shim, not live provider authentication. No fresh real-Pi smoke was run in this integration pass. Repo Map's native fixture covers 2,048 files; 100,000-entry coverage remains model-only.

## Retained failures and limits

- The initial integrated build found an icon/native Map name collision and two missing GitStatus fixture fields; corrected before the passing run.
- `run-38Okfu` retained an initial Repo Map failure caused by an ambiguous workspace-button selector. Exact selectors fixed the fixture without dropping late-response assertions.
- The existing Vite renderer chunk warning (>500 kB) remains.
- Earlier packaged Repo Map startup-hang evidence and historical clone-timeout intermittency are retained; passing this source run does not establish their causes or fixes.
- Tiny proportional tiles, partial sizing and bounded inventory/content reads remain documented limitations. Original-reference comparison and user visual acceptance remain pending.
- Live Pi hyperlinks, native confirmation and actual browser/document-handler acceptance remain separate gates. No production promotion is implied.

## Final source/privacy gates

Staged and unstaged whitespace checks passed and the index had no unresolved merge entries. The narrow credential-pattern scan of the 34 files changed from main found three credential-bearing URL matches, all deliberate `example.com` rejection fixtures in tests; no real credential was identified. Generated builds, dependencies, app bundles and local test evidence are not tracked. This is a limited source scan, not an exhaustive secret/dependency audit.

Before changing main, require it to remain clean at `c54e255` and the integration tree to contain only reviewed changes. After committing, verify both original commits are ancestors, local main and repo_map point to the same integrated tree, both worktrees are clean and the merge is no longer in progress. Local artifacts under `artifacts/testing/merge-main/` record the final Git outcome separately so this pre-merge report does not claim an operation before it occurs.
