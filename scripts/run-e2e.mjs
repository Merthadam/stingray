// Runs the native Electron (Playwright) suites one after another and prints a summary.
//
//   node scripts/run-e2e.mjs                 all suites
//   node scripts/run-e2e.mjs desktop views-tab
//   node scripts/run-e2e.mjs --list
//
// Requires `npm run build` first. On Linux run under a display, e.g. `xvfb-run -a node scripts/run-e2e.mjs`.
// Each suite writes screenshots/evidence below $STINGRAY_TEST_EVIDENCE (default artifacts/testing/e2e/<suite>).
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const suites = { desktop: 'app', 'repo-map': 'repo-map', 'terminal-links': 'terminals', 'workspace-status': 'runtime', 'pull-requests': 'git', 'worktree-removal': 'git', 'add-project': 'git', 'views-tab': 'views' };
const names = Object.keys(suites);

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(names.join('\n')); process.exit(0); }
const unknown = args.filter(name => !names.includes(name));
if (unknown.length) { console.error(`Unknown suite(s): ${unknown.join(', ')}. Known: ${names.join(', ')}`); process.exit(2); }

const selected = args.length ? args : names;
const evidenceRoot = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/e2e');
const results = [];
for (const suite of selected) {
  console.log(`\n=== e2e: ${suite} ===`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [`tests/${suites[suite]}/${suite}.mjs`], {
    stdio: 'inherit',
    env: { ...process.env, STINGRAY_TEST_EVIDENCE: path.join(evidenceRoot, suite) },
    timeout: 10 * 60 * 1000,
  });
  results.push({ suite, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000), status: run.status ?? run.signal });
}

console.log('\n=== e2e summary ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(18)} ${String(r.seconds).padStart(4)}s${r.ok ? '' : `  (exit ${r.status})`}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
