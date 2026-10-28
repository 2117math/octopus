// Warmer.warmNow — TUI `W` 의 지금 한 번 켜기 (원장 2026-10-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Warmer } from '../src/warmer.js';
import { createDefaultConfig } from '../src/config.js';

test('새 설정 파일은 자동 켜기 10분 간격이 기본 (원장 2026-10-28)', () => {
  assert.equal(createDefaultConfig().warmupSeconds, 600);
});

test('주간을 다 쓴 계정은 자동으로도 W 로도 켜지 않는다', async () => {
  const am = new AccountManager([oauth('spent'), oauth('fresh')], 0.98);
  am.accounts[0].quota.unified7d = 0.99;
  const specs = [];
  const warmer = makeWarmer(am, async spec => { specs.push(spec); return 0; });
  assert.deepEqual(warmer.warmTargets().map(a => a.name), ['fresh']);
  await warmer.warmAll();
  assert.equal(specs.length, 1);
  assert.ok(specs[0].env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/fresh'));
});

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function makeWarmer(am, spawnFn) {
  return new Warmer(am, { intervalMs: 0, port: 3456, apiKey: 'tc-key', spawnFn, log: () => {} });
}

test('warmNow: 켜기 간격이 꺼져 있어도 5시간이 안 도는 계정을 한 번 켜고 결과를 돌려준다', async () => {
  const am = new AccountManager([oauth('idle'), oauth('active')], 0.98);
  am.accounts[1].quota.unified5hReset = Date.now() + 3600_000;
  const specs = [];
  const warmer = makeWarmer(am, async spec => { specs.push(spec); return 0; });
  assert.deepEqual(warmer.warmTargets().map(a => a.name), ['idle']);
  const done = [];
  const res = await warmer.warmNow(undefined, { onDone: (a, s) => done.push([a.name, s?.status ?? null]) });
  assert.equal(specs.length, 1);
  assert.ok(specs[0].env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/idle'));
  assert.deepEqual(res.map(r => [r.account.name, r.status]), [['idle', 'ok']]);
  assert.deepEqual(done, [['idle', 'ok']]);
  assert.equal(warmer.getStatus().enabled, false, '켜기 설정은 그대로 꺼져 있다');
});

test('warmNow: 차례가 왔을 때 그새 창이 돌기 시작한 계정은 건너뛴다', async () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const specs = [];
  const warmer = makeWarmer(am, async spec => {
    specs.push(spec);
    am.accounts[1].quota.unified5hReset = Date.now() + 3600_000; // b 는 다른 요청이 먼저 켰다
    return 0;
  });
  const done = [];
  const res = await warmer.warmNow(warmer.warmTargets(), { onDone: (a, s) => done.push([a.name, s?.status ?? null]) });
  assert.equal(specs.length, 1);
  assert.deepEqual(res.map(r => [r.account.name, r.status]), [['a', 'ok'], ['b', 'skipped']]);
  assert.deepEqual(done, [['a', 'ok'], ['b', null]]);
});

test('warmNow: claude 가 실패하면 error 와 이유', async () => {
  const am = new AccountManager([oauth('x')], 0.98);
  const warmer = makeWarmer(am, async () => 1);
  const res = await warmer.warmNow();
  assert.deepEqual(res.map(r => [r.status, r.error]), [['error', 'claude exited 1']]);
});

test('warmNow: 다른 켜기가 돌고 있으면 null (겹쳐 돌지 않는다)', async () => {
  const am = new AccountManager([oauth('x')], 0.98);
  /** @type {(code: number) => void} */
  let release = () => {};
  let spawned = 0;
  const warmer = makeWarmer(am, () => { spawned++; return new Promise(r => { release = r; }); });
  const first = warmer.warmNow();
  await new Promise(r => setImmediate(r));
  assert.equal(await warmer.warmNow(), null);
  release(0);
  const res = await first;
  assert.equal(spawned, 1);
  assert.deepEqual(res.map(r => r.status), ['ok']);
});
