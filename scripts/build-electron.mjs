import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const electronBuildOptions = { entryPoints: { main: 'electron/main.ts', preload: 'electron/adapters/driving/ipc/preload.ts', 'codegraph-worker': 'electron/app/stinggraph-worker.ts', 'views-cli': 'electron/adapters/driving/cli/views-cli.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron', 'node-pty', 'web-tree-sitter', '@colbymchenry/codegraph'] };
// CodeGraph runs in codegraph-worker.cjs (forked by main) and stays external: it resolves its platform bundle (grammars, native kernel, workers) from node_modules at runtime.

export async function buildExtras() {
  await mkdir('dist-electron', { recursive: true });
  // The Database tab parses Python with this grammar; web-tree-sitter stays external so it finds its own runtime wasm.
  await copyFile('electron/adapters/driven/tree-sitter/tree-sitter-python.wasm', 'dist-electron/tree-sitter-python.wasm');
  // Agent skills: Pi loads them via the extension's resources_discover; `stingray-views help` prints the same SKILL.md.
  await rm('dist-electron/skills', { recursive: true, force: true });
  await cp('agents/skills', 'dist-electron/skills', { recursive: true });
  // Keep Pi's host API external: the per-invocation extension resolves it inside Pi.
  await build({ entryPoints: ['agents/pi-extension.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: 'dist-electron/pi-extension.js', external: ['@earendil-works/pi-coding-agent'] });
  // Claude Code hooks / Codex notify run this per event with Stingray's Electron binary as Node (ELECTRON_RUN_AS_NODE).
  await build({ entryPoints: ['agents/hook-client.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/hook-client.cjs' });
}

// Run directly (npm run build): same output as before. Imported (scripts/dev.mjs): nothing runs.
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build(electronBuildOptions);
  await buildExtras();
}
