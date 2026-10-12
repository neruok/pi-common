import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
for (const project of ['pi-advisor', 'pi-magic8ball', 'pi-compaction-model']) {
  test(`CC-AC-6 COMMON-AC-1 ${project} installs through Pi with the registry common dependency`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-registry-install-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(root, '../../../', project, 'worktrees/main');
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { '@neruok/pi-common': '0.1.0' });
    const output = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: source });
    const report = JSON.parse(output.stdout);
    const pack = Array.isArray(report) ? report[0] : Object.values(report)[0];
    const host = await run(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: source });
    const hostEntry = host.stdout.trim();
    const registry = process.env.PI_COMMON_RELEASE_VERIFY_REGISTRY === '1';
    const spec = registry ? `${manifest.name}@${manifest.version}` : `${manifest.name}@file:${join(dir, pack.filename)}`;
    const child = await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mkdir, readFile, readdir, lstat, access } from 'node:fs/promises';
      import { join } from 'node:path';
      const cwd = ${JSON.stringify(join(dir, 'workspace'))}, agentDir = ${JSON.stringify(join(dir, 'agent'))};
      await mkdir(cwd); await mkdir(agentDir); await mkdir(process.env.HOME);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_OFFLINE = '1';
      process.env.npm_config_ignore_scripts = 'true';
      process.env.npm_config_audit = 'false';
      process.env.npm_config_fund = 'false';
      const { DefaultPackageManager, DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(hostEntry)});
      const settings = SettingsManager.inMemory();
      const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
      const source = ${JSON.stringify('npm:' + spec)};
      ${registry ? 'await manager.installAndPersist(source);' : 'await manager.install(source);'}
      const installed = manager.getInstalledPath(source, 'user');
      assert.ok(installed);
      const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
      assert.equal(pkg.name, ${JSON.stringify(manifest.name)});
      assert.equal(pkg.version, ${JSON.stringify(manifest.version)});
      assert.deepEqual(pkg.dependencies, { '@neruok/pi-common': '0.1.0' });
      const modules = join(agentDir, 'npm/node_modules');
      assert.deepEqual((await readdir(modules)).filter(name => name !== '.package-lock.json'), ['@neruok']);
      assert.deepEqual((await readdir(join(modules, '@neruok'))).sort(), ${JSON.stringify([project, 'pi-common'].sort())});
      const commonRoot = join(modules, '@neruok/pi-common');
      assert.equal((await lstat(commonRoot)).isSymbolicLink(), false);
      const common = JSON.parse(await readFile(join(commonRoot, 'package.json'), 'utf8'));
      assert.equal(common.version, '0.1.0'); assert.equal(common.dependencies, undefined);
      const lock = JSON.parse(await readFile(join(agentDir, 'npm/package-lock.json'), 'utf8'));
      assert.equal(lock.packages['node_modules/@neruok/pi-common'].integrity, 'sha512-8I3zVAP6kO1QgWbgiosEQIPfoQrSiwu04ustT7OhYcPYDXnsPkRpwYmluMv/dtSeE7TEaDGp86ba4kQjRiA7VQ==');
      await assert.rejects(access(join(commonRoot, 'node_modules')), e => e.code === 'ENOENT');
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        ${registry ? '' : 'additionalExtensionPaths: [installed],'} });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
      assert.equal(loaded.extensions.length, 1);
      const extension = loaded.extensions[0];
      const command = ${JSON.stringify(project.replace('pi-', ''))};
      assert.deepEqual([...extension.commands.keys()], [command]);
      assert.equal(extension.tools.size, ${project === 'pi-advisor' ? 3 : project === 'pi-magic8ball' ? 4 : 0});
      if (command === 'advisor') {
        assert.deepEqual(loader.getSkills().diagnostics, []);
        assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ['adversarial-review', 'socratic-reasoning']);
      }
      const messages = [];
      loaded.runtime.sendMessage = (message, options) => { assert.equal(options.triggerTurn, false); messages.push(message); };
      const model = { provider: 'mock', id: 'model/full', name: 'Display', api: 'mock-api', reasoning: false };
      const ctx = { cwd, mode: 'print', hasUI: false, isProjectTrusted: () => false,
        waitForIdle: async () => {}, sessionManager: new Proxy({}, { get() { throw Error('No session read'); } }),
        modelRegistry: { getAvailable: () => [model], getAvailableOfType: async () => [model],
          find: () => model, findOfType: () => model, hasConfiguredAuth: () => true,
          streamSimple: () => assert.fail('No generation'), classify: () => assert.fail('No classification') },
        ui: { notify() {}, select: async () => undefined, custom: async factory => {
          let finished = false, result;
          const component = factory({ terminal: { rows: 24 }, requestRender() {} },
            { fg: (_color, text) => text, bold: text => text }, {}, value => { finished = true; result = value; });
          component.focused = true;
          assert.match(component.render(80).join('\\n'), /model\\/full/);
          component.handleInput('\\x1b'); assert.equal(finished, true); return result;
        } } };
      await extension.commands.get(command).handler('show', ctx);
      assert.equal(messages.length, 1); assert.equal(messages[0].display, true);
      ctx.mode = 'tui'; ctx.hasUI = true;
      await extension.commands.get(command).handler('', ctx);
      await assert.rejects(access(join(agentDir, command + '.json')), e => e.code === 'ENOENT');
      console.log('Pi installer, registry dependency, resources, show, cancellation passed');
    `], { cwd: dir, timeout: 60000, env: { ...process.env, HOME: join(dir, 'home'), PI_OFFLINE: '1' } });
    assert.match(child.stdout, /Pi installer, registry dependency, resources, show, cancellation passed/);
  });
}
