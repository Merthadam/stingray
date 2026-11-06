# Stingray status

Updated 2026-11-06. Context, not authorization for further work.

## Source repository

The user approved creating **`Merthadam/stingray` as a public GitHub repository**, initializing Git here, committing source and pushing `main`. This initial source snapshot targets `main` at https://github.com/Merthadam/stingray. Dependencies, generated builds/app bundles, local app data, secrets and `artifacts/` are excluded. No global Git configuration or application changes are part of publishing. GitHub publication does not resolve the reported clone failure below.

Publication preflight freshly passed **23/23 unit/integration tests**, TypeScript checking and staged whitespace checks. The source-only scan's credential-shaped matches were reviewed as deliberate dummy test fixtures; this is not an exhaustive security audit. Existing third-party notices are retained; no new project-wide license was selected.

## Implemented and locally delivered

- Projects home has one **Add project** action with **Local folder / Repository URL**. Local-folder registration and explicit HTTPS/SSH cloning to a new destination are implemented.
- Existing destinations are refused. Registration follows checkout and durable save. Progress is indeterminate, clone execution has a five-minute timeout, and failures preserve remaining files. No setup, dependency installs, hooks, recursive submodules or agents automatically run; trusted Git/SSH configuration remains relevant.
- In the maintainer's local checkout, the tested candidate was promoted to `release/Stingray.app` and reopened normally. The original is retained at `release/backups/2026-11-06-before-add-project/Stingray.app`; both candidates remain intact. Bundles are not distributed in this repository.
- Recorded implementation checks: **23/23 unit/integration tests**, TypeScript/build, source/candidate native checks and Chrome DevTools demo/visual checks. Fresh final-path promotion checks passed **22/22 clone-flow checks**, **31/31 desktop regressions**, isolated LaunchServices smoke, signature and bundle/source integrity comparisons.
- Full reports, screenshots and logs remain local under `artifacts/testing/2026-11-06-add-project/` and `artifacts/testing/2026-11-06-live-promotion/`. They are point-in-time evidence, not CI results or proof of a fresh clone's runtime state.

## Open issue: reported live clone failure

The user reported “Clone failed” in the delivered app. The screenshot showed a GitHub `/projects` page URL rather than a repository clone URL, and that attempt left an empty destination folder. Later read-only GitHub API and Git HTTPS reference checks succeeded for the canonical repository URL. The current failing inputs/download/checkout path have not been reproduced; do not claim the issue is resolved. Clone execution discards raw Git output and exposes only a generic failure, limiting diagnosis. No credential changes, retry clone or cleanup was performed during investigation.

## Remaining limits

Native clone tests use an isolated local SSH transport shim, not live encrypted SSH or HTTPS pack transfer. Native folder-chooser responses are stubbed. The GitHub access check proves metadata/reference access only, not successful clone/checkout. No notarization, Applications install, binary distribution, other-platform/real-agent testing, exhaustive accessibility/security audit, full process-tree supervision or transactional Git/JSON recovery. No cancellation/resume UI or job journal. Existing chunk-size/icon warnings and earlier packaging-development dependency audit findings remain.

No Travella/global changes, Pi/REA integration or prototype cleanup. Further feature changes, credential setup, real-provider clone tests and any future app replacement/rollback require scoped approval; confirm the app has quit before moving/replacing its bundle.
