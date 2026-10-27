// [local patch 2026-10-27 원장] Opus 새 대화는 Fable 사용량 100% 계정부터.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { blockedFamilies } from '../src/tui.js';

const H = 3600e3;
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5-5';
const FABLE = 'claude-fable-5';

// acct0: Fable 남음 · acct1: Fable 100% · acct2: Fable 미터 없음
function fleet(extra = {}) {
  const now = Date.now();
  const am = new AccountManager(
    [0, 1, 2].map(i => ({ name: `acct${i}`, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}` })),
    0.98, { distributeSessions: true, sessionAffinity: true, ...extra });
  am.accounts.forEach((a, i) => {
    const q = a.quota;
    q.unified7d = 0.30; q.unified7dReset = now + (50 + i) * H;
    q.unified5h = 0.2; q.unified5hReset = now + 2 * H;
  });
  am.accounts[0].quota.unified7dFable = 0.2; am.accounts[0].quota.unified7dFableReset = now + 50 * H;
  am.accounts[1].quota.unified7dFable = 1.0; am.accounts[1].quota.unified7dFableReset = now + 50 * H;
  return am;
}
const serve = (am, key, model, exclude = null) => {
  const a = am.getActiveAccount(exclude, model, null, key);
  if (a) am.recordSession(key, a.index, model);
  return a?.name;
};

test('판정이 tui.js blockedFamilies 와 같다', () => {
  const am = fleet();
  for (const a of am.accounts) {
    const tui = blockedFamilies(a.quota, key => am.thresholdFor(key, a)).includes('Fable');
    assert.equal(am._fableSpent(a), tui, a.name);
  }
  assert.equal(am._fableSpent(am.accounts[1]), true);
  assert.equal(am._fableSpent(am.accounts[2]), false, 'Fable 미터 없음 = 안 씀');
});

test('① 새 Opus 대화는 Fable 100% 계정', () => {
  const am = fleet();
  for (const k of ['A/1', 'B/1', 'C/1']) assert.equal(serve(am, k, OPUS), 'acct1', k);
});

test('② 새 Sonnet/Fable 대화는 기존대로(영향 없음)', () => {
  const am = fleet();
  const names = ['A/1', 'B/1', 'C/1'].map(k => serve(am, k, SONNET));
  assert.equal(new Set(names).size, 3, 'Sonnet 은 계정을 고르게 나눈다(Fable 100% 계정 선호 없음)');
  assert.notEqual(serve(fleet(), 'F/1', FABLE), 'acct1', 'Fable 은 Fable 100% 계정을 받을 수 없다');
});

test('③ 집중 계정이 있으면 집중이 우선', () => {
  const am = fleet();
  am.setFocusAccount('acct0');
  assert.equal(serve(am, 'A/1', OPUS), 'acct0');
});

test('④ Fable 100% 계정이 5h 꽉 차면 다른 계정', () => {
  const am = fleet();
  am.accounts[1].quota.unified5h = 0.99;
  assert.notEqual(serve(am, 'A/1', OPUS), 'acct1');
});

test('⑤ 이미 다른 계정에 고정된 Opus 대화는 옮기지 않는다', () => {
  const am = fleet();
  am.sessionTracker.touch('P/1', 0, 'unified7d');
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 'P/1', OPUS), 'acct0');
});

test('⑥ 적응형 분배·expiry 밴드에서도 Fable 100% 계정이 후보에서 빠지지 않는다', () => {
  for (const extra of [{ distributeSessions: 'adaptive' }, { expiryRouting: { enabled: true, preempt: true } }]) {
    const am = fleet(extra);
    assert.equal(serve(am, 'A/1', OPUS), 'acct1', JSON.stringify(extra));
  }
});
