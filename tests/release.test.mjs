import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { SCOPE_CHOICES } from '../dist/commands.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('CC-AC-6 release metadata permits public publication and identifies the repository', () => {
  assert.notEqual(manifest.private, true, 'private blocks publication');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/');
  assert.equal(manifest.repository?.url, 'https://github.com/neruok/pi-common.git');
  assert.equal(manifest.homepage, 'https://github.com/neruok/pi-common#readme');
  assert.equal(manifest.bugs?.url, 'https://github.com/neruok/pi-common/issues');
});

test('CC-AC-6 prepublication verification propagates success and failure', async t => {
  assert.equal(manifest.scripts.prepublishOnly, 'npm run verify');
  const dir = await mkdtemp(join(tmpdir(), 'pi-common-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'common-gate-fixture', version: '0.0.0', private: true,
    scripts: { prepublishOnly: manifest.scripts.prepublishOnly, verify: 'node verify.cjs' },
  }));
  await writeFile(join(dir, 'verify.cjs'), "require('node:fs').writeFileSync('verified', process.env.VERIFY_EXIT); process.exit(Number(process.env.VERIFY_EXIT));\n");
  for (const code of [0, 1]) {
    await rm(join(dir, 'verified'), { force: true });
    const result = spawnSync('npm', ['run', 'prepublishOnly'], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, VERIFY_EXIT: String(code), npm_config_offline: 'true', npm_config_update_notifier: 'false' },
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, code === 0);
    assert.equal(await readFile(join(dir, 'verified'), 'utf8'), String(code));
  }
});

test('CC-AC-1 common command constants cannot mutate shared behavior', () => {
  assert.ok(Object.isFrozen(SCOPE_CHOICES));
  assert.ok(SCOPE_CHOICES.every(Object.isFrozen));
  assert.throws(() => SCOPE_CHOICES.push({ value: '--other', description: 'other' }), TypeError);
  assert.throws(() => { SCOPE_CHOICES[0].value = '--other'; }, TypeError);
});

test('CC-AC-6 npm installs the archive independently without host SDK copies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-common-npm-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: root, encoding: 'utf8', timeout: 60000 }));
  const [pack] = Array.isArray(report) ? report : Object.values(report);
  const isolated = join(dir, 'isolated');
  await import('node:fs/promises').then(fs => fs.mkdir(isolated));
  await writeFile(join(isolated, 'package.json'), JSON.stringify({ name: 'isolated-common', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', join(dir, pack.filename)], { cwd: isolated, encoding: 'utf8', timeout: 60000 });
  assert.deepEqual((await readdir(join(isolated, 'node_modules'))).filter(name => name !== '.package-lock.json'), ['@neruok']);
  const installed = JSON.parse(await readFile(join(isolated, 'node_modules/@neruok/pi-common/package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  for (const value of Object.values(installed.exports)) {
    await readFile(join(isolated, 'node_modules/@neruok/pi-common', value.import));
    await readFile(join(isolated, 'node_modules/@neruok/pi-common', value.types));
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', "await import('@neruok/pi-common/settings'); await import('@neruok/pi-common/model-types'); await import('@neruok/pi-common/presentation'); console.log('installed pure exports passed')"], { cwd: isolated, encoding: 'utf8', timeout: 15000 });
  assert.match(output, /installed pure exports passed/);
});
