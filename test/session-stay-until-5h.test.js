// [local patch 2026-10-27 원장] 한 번 자리를 잡은 대화는 그 계정이 계속 받을 수 있는 동안 옮기지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600e3;
const MODEL = 'claude-sonnet-5-5';

function fleet(extra = {}) {
  const now = Date.now();
  const am = new AccountManager(
    [0, 1, 2].map(i => ({ name: `acct${i}`, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}` })),
    0.98, { distributeSessions: true, sessionAffinity: true, ...extra });
  am.accounts.forEach((a, i) => {
    const q = a.quota;
    q.unified7d = 0.3 + i * 0.01; q.unified7dReset = now + (50 + i) * H;
    q.unified5h = 0.3; q.unified5hReset = now + 2 * H;
  });
  return am;
}
// 서버처럼: 고르고, 서빙 계정으로 고정을 기록한다.
const serve = (am, key, exclude = null) => {
  const a = am.getActiveAccount(exclude, MODEL, null, key);
  if (a) am.recordSession(key, a.index, MODEL);
  return a?.name;
};

test('① A 에 고정된 세션은 B 의 priority 를 더 낮은 숫자로 바꿔도 A 에 남는다', () => {
  const am = fleet();
  am.sessionTracker.touch('S/1', 0, 'unified7d');
  assert.equal(serve(am, 'S/1'), 'acct0');
  am.accounts[1].priority = -1;
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 'S/1'), 'acct0');
  assert.equal(serve(am, 'T/new'), 'acct1', '새 대화는 priority 를 따른다');
});

test('② A 에 고정 뒤 focus=B 여도 A 유지, 새 세션은 B', () => {
  const am = fleet();
  am.sessionTracker.touch('S/1', 0, 'unified7d');
  am.setFocusAccount('acct1');
  assert.equal(serve(am, 'S/1'), 'acct0');
  assert.equal(serve(am, 'T/new'), 'acct1');
});

test('③ A 의 5h 가 임계 이상이면 옮겨진다(focus 있으면 B 로)', () => {
  const am = fleet();
  am.sessionTracker.touch('S/1', 0, 'unified7d');
  am.setFocusAccount('acct1');
  am.accounts[0].quota.unified5h = 0.99;
  assert.equal(serve(am, 'S/1'), 'acct1');
  const am2 = fleet();
  am2.sessionTracker.touch('S/1', 0, 'unified7d');
  am2.accounts[0].quota.unified5h = 0.99;
  assert.notEqual(serve(am2, 'S/1'), 'acct0');
});

test('④ 옮겨진 뒤 A 가 다시 쓸 수 있게 돼도 돌아오지 않는다', () => {
  const am = fleet();
  am.sessionTracker.touch('S/1', 0, 'unified7d');
  am.accounts[0].quota.unified5h = 0.99;
  const moved = serve(am, 'S/1');
  assert.notEqual(moved, 'acct0');
  am.accounts[0].quota.unified5h = 0.1;
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 'S/1'), moved);
});

test('⑤ expiry 롤오버 선점이 켜져 있어도 고정 세션은 옮기지 않는다', () => {
  const am = fleet({ expiryRouting: { enabled: true, preempt: true } });
  am.sessionTracker.touch('S/1', 0, 'unified7d');
  assert.equal(serve(am, 'S/1'), 'acct0');
  am.accounts[0].quota.unified7dReset += 7 * 24 * H;
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 'S/1'), 'acct0');
});
