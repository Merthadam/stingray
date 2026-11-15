import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installLauncher } from '../electron/views/launcher';
import { prependPath } from '../electron/terminals';

test('installLauncher writes an executable sh script that passes paths with spaces and quotes intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stingray launcher 'q' "));
  try {
    // Fake runtime: prints its env and arguments, one per line.
    const execPath = path.join(dir, "fake 'electron'");
    await writeFile(execPath, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE $CODEGRAPH_TELEMETRY $CODEGRAPH_NO_UPDATE_CHECK"\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
    const cliPath = path.join(dir, "dist electron/it's views-cli.cjs");
    const binDir = path.join(dir, 'bin dir');
    const file = await installLauncher({ binDir, execPath, cliPath });
    assert.equal(file, path.join(binDir, 'stingray-views'));
    assert.equal((await stat(file)).mode & 0o777, 0o755);
    await installLauncher({ binDir, execPath, cliPath }); // rewrite in place
    assert.match(await readFile(file, 'utf8'), /^#!\/bin\/sh\n/);
    const out = execFileSync(file, ['check', 'a b.yaml', "it's", '$HOME', '--json'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.deepEqual(out.split('\n'), ['1 0 1', '--liftoff-only', '--disable-warning=ExperimentalWarning', cliPath, 'check', 'a b.yaml', "it's", '$HOME', '--json', '']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prependPath puts the launcher dir first once and leaves PATH alone without one', () => {
  assert.equal(prependPath('/usr/bin:/x/bin:/bin', '/x/bin'), '/x/bin:/usr/bin:/bin');
  assert.equal(prependPath('/x/bin', '/x/bin'), '/x/bin');
  assert.equal(prependPath(undefined, '/x/bin'), '/x/bin');
  assert.equal(prependPath('/usr/bin::/bin', '/a b/bin'), '/a b/bin:/usr/bin:/bin');
  assert.equal(prependPath('/usr/bin', ''), '/usr/bin');
});
