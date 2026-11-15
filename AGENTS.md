# Agent instructions

## Git workflow (always)

1. Branch from latest main: `git fetch origin && git switch -c <type>/<short-name> origin/main`
   (types: `feat`, `fix`, `chore`, `docs`). If you are already on a fresh task branch/worktree, use it.
2. Commit in small, logical steps with clear messages as you go. Never commit secrets, `release/`,
   `artifacts/`, `dist*/` or `node_modules/`.
3. When the task is done and checks pass: `git push -u origin HEAD` and
   `gh pr create --base main --fill` (add a short summary + how it was tested). Report the PR URL.
4. Never push to `main` directly, force-push shared branches, or merge PRs unless asked.

## Checks

- `npm run build` and `npm test` before opening a PR; run the relevant `npm run test:*` suite for the area you touched.

## Testing the app

- Use the disposable Docker env: `scripts/test-env.sh up --detach`, inspect via Chrome DevTools/CDP,
  then `scripts/test-env.sh down --all`. Details: `.agents/skills/run-local/SKILL.md`.
- Do not build or keep extra app copies (`release/*-candidate`, backups) and do not replace the
  installed app at `~/Projects/stingray/release/Stingray.app` unless explicitly asked.
