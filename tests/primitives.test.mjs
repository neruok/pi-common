import test from 'node:test';
import assert from 'node:assert/strict';
import { providerErrorCategory } from '@neruok/pi-common/diagnostics';
import { remainingBudgetMs, remainingDeadlineMs } from '@neruok/pi-common/deadlines';

test('CC-AC-7 diagnostic categories preserve allowlists and status precedence', () => {
  for (const [statuses, category] of [
    [[401, 403], 'authentication'], [[400, 404, 409, 413, 422], 'provider-rejection'],
    [[429], 'rate-limit'], [[408, 500, 502, 503, 504], 'transport'],
  ]) for (const status of statuses) {
    assert.equal(providerErrorCategory({ status }), category);
    assert.equal(providerErrorCategory({ status, code: 'ECONNRESET' }), category);
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
    assert.equal(providerErrorCategory({ code }), 'transport');
    assert.equal(providerErrorCategory({ status: 418, code }), 'transport');
  }
  for (const input of [undefined, null, false, 401, '401', Symbol('error'), {}, { status: '401' }, { status: 418 }, { code: 'other' }, Object.create({ status: 401, code: 'ECONNRESET' })]) {
    assert.equal(providerErrorCategory(input), 'unknown');
  }
  assert.equal(providerErrorCategory(Object.assign(() => {}, { status: 401 })), 'authentication');
  assert.equal(providerErrorCategory(Object.assign([], { status: 429 })), 'rate-limit');
});

test('CC-AC-7 diagnostics ignore accessors and private text and contain descriptor failures', () => {
  let reads = 0;
  const fail = () => { reads++; throw new Error('private data'); };
  const error = Object.defineProperties({}, Object.fromEntries(['status', 'code', 'message', 'stack', 'cause', 'headers', 'errorMessage'].map(key => [key, { get: fail }])));
  assert.equal(providerErrorCategory(error), 'unknown');
  assert.equal(providerErrorCategory(Object.defineProperty(Object.create(error), 'status', { value: 401 })), 'authentication');
  const getterStatus = Object.defineProperty({ code: 'ECONNRESET' }, 'status', { get: fail });
  assert.equal(providerErrorCategory(getterStatus), 'transport');
  assert.equal(providerErrorCategory(new Proxy({}, { getOwnPropertyDescriptor: fail })), 'unknown');
  const statusFirst = new Proxy({ status: 401 }, { getOwnPropertyDescriptor(target, key) {
    if (key !== 'status') return fail();
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  assert.equal(providerErrorCategory(statusFirst), 'authentication');
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.equal(providerErrorCategory(proxy), 'unknown');
  assert.equal(reads, 1, 'only the deliberately throwing descriptor trap may run');
});

test('CC-AC-7 accessor descriptors cannot inherit a data value', () => {
  let reads = 0;
  const error = Object.defineProperties({}, {
    status: { get() { reads++; return 401; } },
    code: { get() { reads++; return 'ECONNRESET'; } },
  });
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  const categories = [];
  try {
    for (const value of [401, 'ECONNRESET']) {
      Object.defineProperty(Object.prototype, 'value', { value, configurable: true });
      categories.push(providerErrorCategory(error));
    }
  } finally {
    delete Object.prototype.value;
    if (previous) Object.defineProperty(Object.prototype, 'value', previous);
  }
  assert.deepEqual(categories, ['unknown', 'unknown']);
  assert.equal(reads, 0);
});

test('CC-AC-8 elapsed budgets preserve original start, signed time and caller rounding', () => {
  assert.equal(remainingBudgetMs(100.25, 20, 103.75), 16.5);
  assert.equal(remainingBudgetMs(100.25, 20, 120.25), 0);
  assert.equal(remainingBudgetMs(100.25, 20, 122.25), -2);
  assert.equal(remainingBudgetMs(100.25, 10, 103.75), 6.5);
  assert.equal(remainingBudgetMs(100.25, 2, 103.75), -1.5);
  assert.equal(remainingBudgetMs(100, 10, 95), 15);
  assert.equal(Math.floor(remainingBudgetMs(100.25, 20, 103.75)), 16);
  assert.equal(Math.ceil(remainingBudgetMs(100.25, 20, 103.75)), 17);
  assert.equal(remainingBudgetMs(0, 0, 0), 0);
  assert.equal(remainingBudgetMs(0, -1, 0), -1);
});

test('CC-AC-8 absolute deadlines retain their own arithmetic and precision', () => {
  assert.equal(remainingDeadlineMs(120.25, 103.75), 16.5);
  assert.equal(remainingDeadlineMs(120.25, 120.25), 0);
  assert.equal(remainingDeadlineMs(120.25, 122.25), -2);
  const started = 1e16, duration = 1, now = 1e16;
  assert.equal(remainingBudgetMs(started, duration, now), 1);
  assert.equal(remainingDeadlineMs(started + duration, now), 0);
});

test('CC-AC-8 deadline arithmetic preserves nonfinite values without reading clocks or starting timers', t => {
  const forbidden = () => assert.fail('callers own clocks and resources');
  t.mock.method(performance, 'now', forbidden);
  t.mock.method(Date, 'now', forbidden);
  t.mock.method(globalThis, 'setTimeout', forbidden);
  assert.equal(remainingBudgetMs(0, Infinity, 1), Infinity);
  assert.equal(remainingDeadlineMs(0, Infinity), -Infinity);
  assert.ok(Number.isNaN(remainingBudgetMs(NaN, 1, 0)));
  assert.ok(Number.isNaN(remainingDeadlineMs(Infinity, Infinity)));
  assert.equal(remainingBudgetMs(1, 10, 2), 9);
  assert.equal(remainingDeadlineMs(11, 2), 9);
});
