import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, rename, access, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This packaging recipe is verified for Apple Silicon macOS only.');
// An optional local candidate directory allows verification without touching a running build.
const output = path.resolve(root, process.env.STINGRAY_PACKAGE_OUTPUT || 'release');
const relativeOutput = path.relative(path.join(root, 'release'), output);
if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Package output must be inside this project\'s release directory.');
const target = path.join(output, 'Stingray.app');
await mkdir(output, { recursive: true });
try { await access(target); throw new Error('Target Stingray.app already exists. Move it aside or choose a new STINGRAY_PACKAGE_OUTPUT directory inside release; existing apps are never overwritten.'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const work = await mkdtemp(path.join(root, '.package-work-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = path.join(work, 'app'); await mkdir(stage);
  for (const name of ['dist', 'dist-electron', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  // Renderer and main JS dependencies are bundled. Only node-pty remains external at runtime.
  for (const name of ['node-pty', 'node-addon-api']) {
    await cp(path.join(root, 'node_modules', name), path.join(stage, 'node_modules', name), { recursive: true });
  }
  const ptyPrebuilds = path.join(stage, 'node_modules/node-pty/prebuilds');
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(ptyPrebuilds)) if (name !== 'darwin-arm64') await rm(path.join(ptyPrebuilds, name), { recursive: true });
  await chmod(path.join(ptyPrebuilds, 'darwin-arm64/spawn-helper'), 0o755);
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: manifest.name, productName: 'Stingray', version: manifest.version,
    main: manifest.main, description: manifest.description, dependencies: { 'node-pty': manifest.dependencies['node-pty'] } }, null, 2));
  const licenses = path.join(stage, 'dependency-licenses'); await mkdir(licenses);
  for (const name of [...Object.keys(manifest.dependencies), 'scheduler', 'node-addon-api']) {
    const directory = path.join(root, 'node_modules', name);
    for (const file of await readdir(directory)) if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(file)) {
      await cp(path.join(directory, file), path.join(licenses, name.replaceAll('/', '-') + '-' + file));
    }
  }
  const iconset = path.join(work, 'Stingray.iconset');
  execFileSync(electron, [path.join(root, 'scripts/make-icon.cjs'), iconset], { cwd: root, env, stdio: 'inherit', timeout: 30000 });
  const icon = path.join(work, 'Stingray.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  const packages = await packager({ dir: stage, name: 'Stingray', executableName: 'Stingray', platform: 'darwin', arch: 'arm64',
    electronVersion: manifest.devDependencies.electron, appBundleId: 'local.stingray.desktop',
    // Optional existing archive directory: packager fails on a cache miss instead of downloading.
    electronZipDir: process.env.STINGRAY_ELECTRON_ZIP_DIR ? path.resolve(process.env.STINGRAY_ELECTRON_ZIP_DIR) : undefined,
    appVersion: manifest.version, icon, out: path.join(work, 'output'), asar: false, prune: false,
    darwinDarkModeSupport: true });
  const app = path.join(packages[0], 'Stingray.app');
  // Local ad-hoc signature only: no developer identity, account, upload, or notarization.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  await rename(app, target);
  console.log(`Ready: ${target}`);
  console.log('Local Apple Silicon build; ad-hoc signed, not Apple-notarized.');
} finally {
  await rm(work, { recursive: true, force: true });
}
