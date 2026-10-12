import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, symlink, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { selectModel, ModelPickerError } from '@neruok/pi-common/model-picker';
import { supportedReasoning, supportsReasoning } from '@neruok/pi-common/models';
import { SettingsError, readSettingsBytes, decodeSettings, updateJsonSettings, replaceJsonSettings, loadScopedSettings, settingsPaths } from '@neruok/pi-common/settings';
import { argumentCompletions, scopedArguments, completionContext } from '@neruok/pi-common/commands';
import { sanitizeText, sanitizeLabel, reportCommand } from '@neruok/pi-common/presentation';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-common-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'settings.json') };
}
const kind = code => error => error instanceof SettingsError && error.code === code;

test('CC-AC-2 shared picker preserves focus, dimensions, search, no-match, navigation and full IDs', async () => {
  const models = Array.from({ length: 30 }, (_, n) => ({ provider: 'catalog', id: 'model-' + n + '-界😀', name: 'Display ' + n }));
  const terminal = { rows: 24 }, theme = { fg: (_c, s) => s, bold: s => s };
  const ctx = { mode: 'tui', ui: { select: () => assert.fail('TUI cannot use RPC dialog'), custom: async factory => {
    let result, finished = false;
    const component = factory({ terminal, requestRender() {} }, theme, {}, value => { finished = true; result = value; });
    component.focused = true;
    assert.ok(component.render(80).join('\n').includes(CURSOR_MARKER));
    for (const rows of [24, 10, 6, 3, 1]) {
      terminal.rows = rows;
      for (const width of [1, 30, 80]) {
        const lines = component.render(width);
        assert.ok(lines.length <= Math.max(1, rows - 2));
        assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
    }
    terminal.rows = 24;
    assert.match(component.render(80).join('\n'), /✓.*model-17/);
    component.handleInput('zzzzzzz'); component.handleInput('\r');
    assert.equal(finished, false);
    assert.match(component.render(80).join('\n'), /No matching models/);
    component.handleInput('\x15'); component.handleInput('Display 29');
    assert.match(component.render(80).join('\n'), /→.*model-29/);
    component.handleInput('\r');
    return result;
  } } };
  assert.deepEqual(await selectModel(ctx, 'Models', models, { provider: 'catalog', model: models[17].id }), { provider: 'catalog', model: models[29].id });
});
test('CC-AC-2 RPC uses common labels, retains IDs, cancels and rejects invalid selections', async () => {
  const models = [{ provider: 'p', id: 'model/full' }];
  const ctx = { mode: 'rpc', ui: { select: async (_title, labels) => {
    assert.deepEqual(labels, ['p/model/full']); return labels[0];
  } } };
  assert.deepEqual(await selectModel(ctx, 'Model', models), { provider: 'p', model: 'model/full' });
  ctx.ui.select = async () => undefined;
  assert.equal(await selectModel(ctx, 'Model', models), undefined);
  ctx.ui.select = async () => 'not-a-label';
  await assert.rejects(selectModel(ctx, 'Model', models), ModelPickerError);
});
test('CC-AC-2 reasoning delegates capabilities to the host SDK without clamping', () => {
  for (const model of [
    { provider: 'mock', id: 'plain', api: 'mock-api', reasoning: false },
    { provider: 'mock', id: 'thinking', api: 'mock-api', reasoning: true },
    { provider: 'mock', id: 'limited', api: 'mock-api', reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
  ]) {
    assert.deepEqual(supportedReasoning(model), ['default', ...getSupportedThinkingLevels(model)]);
    assert.equal(supportsReasoning(model), true);
    assert.equal(supportsReasoning(model, 'default'), true);
    assert.equal(supportsReasoning(model, 'unsupported'), false);
  }
});

test('CC-AC-3 bounded settings reads accept exact limits and reject overflow or invalid UTF-8', async t => {
  const f = await fixture(t);
  assert.deepEqual(decodeSettings(await readSettingsBytes(f.path, 16000)), {});
  for (const max of [16000, 16384]) {
    await writeFile(f.path, '{}'.padEnd(max));
    assert.deepEqual(decodeSettings(await readSettingsBytes(f.path, max)), {});
    await writeFile(f.path, '{}'.padEnd(max + 1));
    await assert.rejects(readSettingsBytes(f.path, max), kind('invalid-config'));
    await writeFile(f.path, Buffer.concat([Buffer.from('"'), Buffer.alloc(max - 2, 32), Buffer.from([0xc3])]));
    assert.throws(() => decodeSettings(Buffer.from([0xff])), kind('invalid-config'));
    const raw = await readSettingsBytes(f.path, max);
    assert.throws(() => decodeSettings(raw), kind('invalid-config'));
  }
});
test('CC-AC-3 settings refuse final/parent symlinks, directories and FIFOs without blocking', async t => {
  const f = await fixture(t), target = join(f.dir, 'target.json');
  await writeFile(target, '{}'); await symlink(target, f.path);
  await assert.rejects(readSettingsBytes(f.path, 16000), kind('settings-unavailable'));
  await assert.rejects(replaceJsonSettings(f.path, {}, 16000), kind('settings-unavailable'));
  await rm(f.path); await mkdir(f.path);
  await assert.rejects(readSettingsBytes(f.path, 16000), kind('settings-unavailable'));
  await rm(f.path, { recursive: true }); execFileSync('mkfifo', [f.path]);
  await assert.rejects(readSettingsBytes(f.path, 16000), kind('settings-unavailable'));
  await rm(f.path);
  const actual = join(f.dir, 'actual'), alias = join(f.dir, 'alias');
  await mkdir(actual); await symlink(actual, alias);
  await assert.rejects(replaceJsonSettings(join(alias, 'new.json'), {}, 16000), kind('settings-unavailable'));
  assert.deepEqual(await readdir(actual), []);
});
test('CC-AC-3 settings updates use locked scope-owned data and refuse malformed content', async t => {
  const f = await fixture(t);
  await updateJsonSettings(f.path, 16000, value => ({ ...value, first: 1 }));
  await updateJsonSettings(f.path, 16000, value => ({ ...value, second: 2 }));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { first: 1, second: 2 });
  await writeFile(f.path, '{');
  await assert.rejects(updateJsonSettings(f.path, 16000, () => ({})), kind('invalid-config'));
  assert.equal(await readFile(f.path, 'utf8'), '{');
  assert.deepEqual(await readdir(f.dir), ['settings.json']);
});
test('CC-AC-3 checkpoint changes preserve the external writer and clean owned files', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '{"original":true}');
  await assert.rejects(updateJsonSettings(f.path, 16000, () => {
    writeFileSync(f.path, '{"external":true}');
    return { proposed: true };
  }), kind('settings-unavailable'));
  assert.equal(await readFile(f.path, 'utf8'), '{"external":true}');
  assert.deepEqual(await readdir(f.dir), ['settings.json']);
});
test('CC-AC-3 foreign locks remain untouched and replacement repairs raw malformed content', async t => {
  const f = await fixture(t);
  await writeFile(f.path, Buffer.alloc(131072, 0xff));
  await writeFile(f.path + '.lock', 'FOREIGN');
  await assert.rejects(replaceJsonSettings(f.path, {}, 16384), kind('settings-unavailable'));
  assert.equal(await readFile(f.path + '.lock', 'utf8'), 'FOREIGN');
  await rm(f.path + '.lock');
  await replaceJsonSettings(f.path, {}, 16384);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {});
  assert.deepEqual(await readdir(f.dir), ['settings.json']);
});
test('CC-AC-3 global/project loading ignores untrusted files and replaces whole fields', async t => {
  const f = await fixture(t), paths = settingsPaths(f.dir, f.dir, 'settings.json');
  const parse = value => value;
  await writeFile(paths.global, '{"model":{"provider":"p","model":"a","reasoning":"high"},"timeoutMs":10}');
  await mkdir(join(f.dir, '.pi'));
  await writeFile(paths.project, '{"model":{"provider":"q","model":"b"}}');
  const loaded = await loadScopedSettings(paths, true, 16000, parse);
  assert.deepEqual(loaded.settings, { model: { provider: 'q', model: 'b' }, timeoutMs: 10 });
  assert.deepEqual(loaded.sources, { model: 'project', timeoutMs: 'global' });
  await writeFile(paths.project, '{');
  assert.equal((await loadScopedSettings(paths, false, 16000, parse)).settings.model.model, 'a');
  await assert.rejects(loadScopedSettings(paths, true, 16000, parse), kind('invalid-config'));
});

test('CC-AC-4 completion preserves whitespace, scopes, ranking and silent failures', async () => {
  const spec = { commands: [{ value: 'show', description: 'Show' }, { value: 'model', description: 'Model' }],
    modelCommands: ['model'], validateModel() {},
    models: () => [{ provider: 'chat', id: 'tiny', name: 'Tiny Moon' }, { provider: 'another', id: 'large' }] };
  assert.deepEqual(scopedArguments('model --project chat tiny'), { scope: 'project', args: ['model', 'chat', 'tiny'] });
  assert.equal(scopedArguments('--global --project show'), undefined);
  assert.equal(await argumentCompletions('--global --global ', spec), null);
  assert.deepEqual((await argumentCompletions('model ', spec)).map(x => x.label), ['another', 'chat']);
  assert.deepEqual((await argumentCompletions('--project\tmodel\tchat\tTM', spec)).map(x => x.value), ['--project\tmodel\tchat\ttiny ']);
  spec.models = () => { throw new Error('SECRET'); };
  assert.equal(await argumentCompletions('model ', spec), null);
  assert.ok(await argumentCompletions('sho', spec));
});
test('CC-AC-4 unknown prototype-named commands fail silently', async () => {
  const spec = { commands: [{ value: 'transcripts', description: 'Capture' }], modelCommands: [],
    isolatedCommands: { transcripts: [{ value: 'show', description: 'Show' }] }, validateModel() {} };
  for (const prefix of ['toString x ', 'constructor x ', '__proto__ x ']) {
    assert.equal(await argumentCompletions(prefix, spec), null);
  }
});

test('CC-AC-4 each completion registration invalidates pending old-context results', async () => {
  let finish;
  const state = completionContext(async (_prefix, ctx) => new Promise(resolve => { finish = () => resolve([{ value: ctx, label: ctx }]); }));
  state.set('old');
  const pending = state.complete(''); state.set('new'); finish();
  assert.equal(await pending, null);
});
test('CC-AC-5 sanitization preserves multiline text and flattens labels', () => {
  assert.equal(sanitizeText('first\nsecond\u202e\x1b\tend'), 'first\nsecond end');
  assert.equal(sanitizeLabel('first\nsecond\u2066'), 'first second');
});
test('CC-AC-5 command reporting uses UI or a visible message without a turn', () => {
  const messages = [], notices = [];
  const pi = { sendMessage: (m, options) => messages.push({ m, options }) };
  const ui = { notify: (text, level) => notices.push({ text, level }) };
  assert.equal(reportCommand(pi, { hasUI: true, ui }, 'settings', 'Saved', 'info'), true);
  assert.deepEqual(notices, [{ text: 'Saved', level: 'info' }]);
  assert.equal(reportCommand(pi, { hasUI: false, ui }, 'settings', 'Failed', 'error'), true);
  assert.deepEqual(messages, [{ m: { customType: 'settings', content: 'Failed', display: true, details: { level: 'error' } }, options: { triggerTurn: false } }]);
  const previous = console.error, errors = [];
  console.error = text => errors.push(text);
  try {
    assert.equal(reportCommand({ sendMessage() { throw new Error('SECRET'); } }, { hasUI: false, ui }, 'settings', 'Data', 'info'), false);
  } finally { console.error = previous; }
  assert.deepEqual(errors, ['settings: could not report the result.']);
});
