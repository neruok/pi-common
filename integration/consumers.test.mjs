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
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: source, timeout: 60000 });
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

test('CC-AC-1 packed consumers load the archived library through Pi 1.0.4 and 1.1.0', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-common-consumers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = await pack(root, join(dir, 'common'));
  for (const project of ['pi-advisor', 'pi-magic8ball', 'pi-compaction-model']) {
    const source = join(root, '../../../', project, 'worktrees/main');
    const archive = await pack(source, join(dir, project + '-archive'));
    const installed = join(dir, project);
    await extract(archive.path, installed);
    const dep = join(installed, 'node_modules/@neruok/pi-common');
    await extract(common.path, dep);
    assert.deepEqual(await readdir(join(installed, 'node_modules')), ['@neruok']);
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies), ['@neruok/pi-common']);
    const resolved = await run(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: source });
    const piEntry = new URL(resolved.stdout.trim());
    const host = JSON.parse(await readFile(new URL('../package.json', piEntry), 'utf8'));
    assert.equal(host.version, project === 'pi-compaction-model' ? '1.1.0' : '1.0.4');
    const loader = new URL('./core/extensions/loader.js', piEntry).href;
    const entry = join(installed, manifest.pi.extensions[0]);
    const expectedCommand = project.replace('pi-', '');
    const result = await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { loadExtensions } = await import(${JSON.stringify(loader)});
      const loaded = await loadExtensions([${JSON.stringify(entry)}], ${JSON.stringify(installed)});
      assert.deepEqual(loaded.errors, []);
      assert.deepEqual(loaded.warnings ?? [], []);
      assert.equal(loaded.extensions.length, 1);
      const extension = loaded.extensions[0];
      assert.deepEqual([...extension.commands.keys()], [${JSON.stringify(expectedCommand)}]);
      const models = [{ provider: 'mock', id: 'model/full', name: 'Display', api: 'mock-api', reasoning: false }];
      const ctx = { cwd: ${JSON.stringify(installed)}, mode: 'tui', hasUI: true, isProjectTrusted: () => false,
        waitForIdle: async () => {}, modelRegistry: {
          getAvailable: () => models, getAvailableOfType: async () => models,
          find: () => models[0], findOfType: () => models[0], hasConfiguredAuth: () => true,
          streamSimple: () => assert.fail('no generation'), classify: () => assert.fail('no classification'),
        }, ui: { notify() {}, select: () => assert.fail('TUI must use shared picker'),
          custom: async factory => {
            let finished = false, result;
            const component = factory({ terminal: { rows: 24 }, requestRender() {} },
              { fg: (_color, text) => text, bold: text => text }, {},
              value => { finished = true; result = value; });
            component.focused = true;
            assert.match(component.render(80).join('\\n'), /model\\/full/);
            component.handleInput('Display');
            assert.match(component.render(80).join('\\n'), /Display/);
            component.handleInput('\\x1b');
            assert.equal(finished, true);
            return result;
          } } };
      await extension.commands.get(${JSON.stringify(expectedCommand)}).handler('', ctx);
      console.log('packed loader and picker passed');
    `], { cwd: installed, env: { ...process.env, PI_CODING_AGENT_DIR: installed }, timeout: 30000 });
    assert.match(result.stdout, /packed loader and picker passed/, project);
  }
});
