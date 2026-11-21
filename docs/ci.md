# CI/CD and local runs

One pipeline, `.github/workflows/ci.yml`, runs on every PR, on pushes to `main`, on `v*` tags and on demand.

| Stage | Job | Runner | Blocking | What |
|---|---|---|---|---|
| 1 | `check (ubuntu-latest)`, `check (macos-14)` | Linux, macOS arm64 | yes | `npm ci`, `npm run setup`, typecheck, build, `npm test` |
| 2a | `e2e (linux, docker test-env)` | Linux | yes* | Electron e2e suites in the Docker test env (`scripts/test-env.sh test`), then a smoke of the local-run env (`scripts/test-env.sh up`) |
| 2b | `e2e (macos)` | macOS arm64 | no (for now) | all e2e suites (`npm run test:e2e`) |
| 3 | `package (macos arm64)` | macOS arm64 | yes | `npm run package:mac`, signature check, packaged-launch smoke, zip + sha256 uploaded as the `stingray-mac-arm64` artifact |
| 4 | deploy | – | – | not yet (see below) |

\* On Linux, `desktop`, `terminal-links` and `workspace-status` fail today (macOS assumptions in those
suites/features). They still run, in a separate non-blocking step, so a fix shows up immediately. Once
they pass, move them into the required step. Likewise make `e2e (macos)` blocking once it is green on
hosted runners.

Test evidence (screenshots, logs) and the packaged app are attached to each run as artifacts.

## Run the same checks locally

```bash
npm run check                         # typecheck + build + unit tests (stage 1)
npm run test:e2e                      # all e2e suites against your build, on this Mac
npm run test:e2e -- views-tab desktop # selected suites (node scripts/run-e2e.mjs --list)
scripts/test-env.sh test              # unit + e2e headless in Docker, exactly like stage 2a
scripts/test-env.sh test e2e views-tab
npm run package:mac                   # stage 3 (writes release/Stingray.app — never overwrites)
```

Running the app: `npm run dev` (native, hot-reload renderer) or `npm run env:up` (disposable Docker env
with a Chrome DevTools endpoint; `npm run env:down` to remove). See `.agents/skills/run-local/SKILL.md`.

## Next: deploy

Not wired up yet. To finish CD:

1. Apple Developer ID certificate + notarization credentials as repository secrets.
2. In `package-macos`, sign with the Developer ID instead of ad-hoc (`scripts/package-mac.mjs`), then
   `xcrun notarytool submit --wait` and `xcrun stapler staple`.
3. Add a `release` job on `v*` tags that publishes a GitHub Release with the zip (needs
   `permissions: contents: write`), optionally with an update feed for auto-updates.
