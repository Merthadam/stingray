import { build } from 'esbuild';
import { copyFile, cp, rm } from 'node:fs/promises';
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/codegraph-worker.ts', 'electron/views-cli.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron', 'node-pty', 'web-tree-sitter', '@colbymchenry/codegraph'] });
// CodeGraph runs in codegraph-worker.cjs (forked by main) and stays external: it resolves its platform bundle (grammars, native kernel, workers) from node_modules at runtime.
// The Database tab parses Python with this grammar; web-tree-sitter stays external so it finds its own runtime wasm.
await copyFile('electron/tree-sitter-python.wasm', 'dist-electron/tree-sitter-python.wasm');
// Agent skills: Pi loads them via the extension's resources_discover; `stingray-views help` prints the same SKILL.md.
await rm('dist-electron/skills', { recursive: true, force: true });
await cp('agents/skills', 'dist-electron/skills', { recursive: true });
// Keep Pi's host API external: the per-invocation extension resolves it inside Pi.
await build({ entryPoints: ['agents/pi-extension.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: 'dist-electron/pi-extension.js', external: ['@earendil-works/pi-coding-agent'] });
// Claude Code hooks / Codex notify run this per event with Stingray's Electron binary as Node (ELECTRON_RUN_AS_NODE).
await build({ entryPoints: ['agents/hook-client.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/hook-client.cjs' });
