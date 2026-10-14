import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Select only the fixture suites so this driver cannot recursively invoke itself.
test('CC-AC-10 packaging fixtures survive inherited publication dry-run', () => {
  const env = { ...process.env, npm_config_dry_run: 'true', npm_config_offline: 'true' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/package.test.mjs', 'tests/release.test.mjs'], {
    cwd: new URL('../', import.meta.url), env,
    encoding: 'utf8', timeout: 60000,
  });
  assert.match(output, /ok \d+ - CC-AC-1 CC-AC-9 packed library/);
  assert.match(output, /ok \d+ - CC-AC-6 npm installs the archive independently/);
  assert.match(output, /# fail 0/);
  assert.match(output, /# skipped 0/);
});
