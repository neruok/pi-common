import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
async function pack(source, dir) {
  await mkdir(dir, { recursive: true });
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', dir], { cwd: source, timeout: 60000 });
  const report = JSON.parse(stdout);
  const [artifact] = Array.isArray(report) ? report : Object.values(report);
  assert.equal(artifact.bundled.length, 0);
  return { path: join(dir, artifact.filename), artifact };
}
async function extract(archive, target) {
  await mkdir(target, { recursive: true });
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
  assert.equal((await lstat(target)).isSymbolicLink(), false);
}

test('CC-AC-1 CC-AC-9 packed library has typed subpaths and provider-free modules load without Pi', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-common-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { path, artifact } = await pack(root, join(dir, 'archive'));
  const installed = join(dir, 'isolated/node_modules/@neruok/pi-common');
  await extract(path, installed);
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@neruok/pi-common');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.pi, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.exports['.'], undefined);
  for (const subpath of ['./diagnostics', './deadlines']) {
    assert.ok(pkg.exports[subpath]?.types, `${subpath} must declare its types`);
    assert.ok(pkg.exports[subpath]?.import, `${subpath} must declare its runtime`);
  }
  const paths = new Set(artifact.files.map(file => file.path));
  for (const required of ['LICENSE', 'README.md', 'package.json']) assert.ok(paths.has(required), required);
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    assert.ok(paths.has(entry.types.replace(/^\.\//, '')), subpath + ' types');
    assert.ok(paths.has(entry.import.replace(/^\.\//, '')), subpath + ' runtime');
  }
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
    assert.equal(pkg.peerDependencies['@earendil-works/' + name], '*');
    assert.equal(pkg.peerDependenciesMeta['@earendil-works/' + name].optional, true);
  }
  assert.deepEqual(await readdir(join(dir, 'isolated/node_modules')), ['@neruok']);
  const result = await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const settings = await import('@neruok/pi-common/settings');
    const presentation = await import('@neruok/pi-common/presentation');
    const types = await import('@neruok/pi-common/model-types');
    const diagnostics = await import('@neruok/pi-common/diagnostics');
    const deadlines = await import('@neruok/pi-common/deadlines');
    assert.equal(diagnostics.providerErrorCategory({ status: 429 }), 'rate-limit');
    assert.equal(deadlines.remainingBudgetMs(10, 20, 15), 15);
    assert.equal(deadlines.remainingDeadlineMs(30, 15), 15);
    assert.equal(typeof settings.updateJsonSettings, 'function');
    assert.equal(presentation.sanitizeLabel('a\\nb'), 'a b');
    assert.ok(types.REASONING_LEVELS.includes('default'));
    await assert.rejects(import('@neruok/pi-common/dist/settings.js'), e => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    console.log('isolated exports passed');
  `], { cwd: join(dir, 'isolated') });
  assert.match(result.stdout, /isolated exports passed/);
});
