// 결제 전 계정 미리 넣기 — 원장 2026-10-28 「프로나 맥스를 결제 안 했더라도 미리 계정을 넣어 두는 방식」.
// 로그인 때 Pro/Max 가 아니면 꺼 둔 채(disabled + pendingPlan) 추적만 하고, 프로필에서 결제가
// 확인되면 자동으로 켠다. 갱신기는 결제 전 계정을 10분마다 더 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { SubscriptionRefresher } from '../src/subscription-refresher.js';
import { isPrePlanProfile, isPaidProfile } from '../src/subscription.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const HOUR = 3600e3;
const oauth = (name, extra = {}) => ({ name, id: `id-${name}`, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });
const FREE = { email: 'x@y.com', hasClaudeMax: false, hasClaudePro: false, seatTier: null, organizationType: 'claude_ai' };
const MAX = { email: 'x@y.com', hasClaudeMax: true, hasClaudePro: false, seatTier: null, organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' };

test('isPrePlanProfile / isPaidProfile: 분명할 때만 참, 모르면 둘 다 거짓', () => {
  assert.equal(isPrePlanProfile(FREE), true);
  assert.equal(isPaidProfile(FREE), false);
  assert.equal(isPrePlanProfile(MAX), false);
  assert.equal(isPaidProfile(MAX), true);
  assert.equal(isPaidProfile({ hasClaudeMax: false, hasClaudePro: true }), true);
  assert.equal(isPaidProfile({ hasClaudeMax: false, hasClaudePro: false, seatTier: 'standard' }), true, 'Team 좌석');
  assert.equal(isPrePlanProfile({ hasClaudeMax: false, hasClaudePro: false, seatTier: 'standard' }), false);
  for (const unknown of [null, undefined, {}, { error: 'nope' }, { hasClaudeMax: null, hasClaudePro: null }, { email: 'x' }]) {
    assert.equal(isPrePlanProfile(unknown), false, `pre ${JSON.stringify(unknown)}`);
    assert.equal(isPaidProfile(unknown), false, `paid ${JSON.stringify(unknown)}`);
  }
});

test('설정의 pendingPlan 은 계정에 실리고 상태 요약에도 나온다', () => {
  const am = new AccountManager([oauth('ai01', { disabled: true, pendingPlan: true }), oauth('b')], 0.98);
  assert.equal(am.accounts[0].pendingPlan, true);
  assert.equal(am.accounts[0].disabled, true);
  assert.equal(am.accounts[1].pendingPlan, false);
  const st = am.getStatus().accounts;
  assert.equal(st[0].pendingPlan, true);
  assert.equal(st[1].pendingPlan, false);
});

test('applyProfileData: 결제 전 계정이 Max 로 보이면 켜고 표시를 지우고 onPlanActivated 를 부른다', () => {
  const am = new AccountManager([oauth('ai01', { disabled: true, pendingPlan: true })], 0.98);
  const seen = [];
  am.onPlanActivated(a => seen.push(a.name));
  am.applyProfileData(0, FREE);
  assert.equal(am.accounts[0].disabled, true, '아직 결제 전');
  assert.equal(am.accounts[0].pendingPlan, true);
  assert.deepEqual(seen, []);
  am.applyProfileData(0, MAX);
  assert.equal(am.accounts[0].disabled, false);
  assert.equal(am.accounts[0].pendingPlan, false);
  assert.equal(am.accounts[0].hasClaudeMax, true);
  assert.deepEqual(seen, ['ai01']);
  am.applyProfileData(0, MAX);
  assert.deepEqual(seen, ['ai01'], '한 번만');
});

test('applyProfileData: 손으로 꺼 둔(pendingPlan 없는) 계정은 Max 프로필이 와도 그대로 꺼져 있다', () => {
  const am = new AccountManager([oauth('b', { disabled: true })], 0.98);
  let called = 0;
  am.onPlanActivated(() => { called++; });
  am.applyProfileData(0, MAX);
  assert.equal(am.accounts[0].disabled, true);
  assert.equal(called, 0);
});

test('syncAccountsFromDisk: 디스크의 pendingPlan 이 계정과 설정 항목에 반영된다(양방향)', async () => {
  const disk = { accounts: [oauth('ai01', { disabled: true, pendingPlan: true })] };
  const config = { accounts: disk.accounts.map(a => ({ ...a })) };
  const am = new AccountManager(config.accounts, 0.98);
  assert.equal(am.accounts[0].pendingPlan, true);
  // 결제 확인이 디스크에 적힌 뒤 reload
  const disk2 = { accounts: [{ ...disk.accounts[0] }] };
  delete disk2.accounts[0].disabled; delete disk2.accounts[0].pendingPlan;
  await syncAccountsFromDisk(disk2, config, am);
  assert.equal(am.accounts[0].pendingPlan, false);
  assert.equal(am.accounts[0].disabled, false);
  assert.equal('pendingPlan' in config.accounts[0], false);
});

test('갱신기: refreshAll({pendingOnly}) 은 결제 전 계정만, refreshPending 은 결제 전이 없으면 아무 것도 안 한다', async () => {
  const am = new AccountManager([oauth('ai01', { disabled: true, pendingPlan: true }), oauth('b')], 0.98);
  am.ensureTokenFresh = async () => {};
  const seen = [];
  const r = new SubscriptionRefresher(am, { profileFn: async (tok) => { seen.push(tok); return MAX; }, log: () => {} });
  await r.refreshAll({ pendingOnly: true });
  assert.deepEqual(seen, ['t-ai01']);
  assert.equal(am.accounts[0].disabled, false, '결제 확인 → 켬');
  seen.length = 0;
  await r.refreshPending();
  assert.deepEqual(seen, [], '이제 결제 전 계정이 없다');
  await r.refreshAll();
  assert.deepEqual(seen.sort(), ['t-ai01', 't-b']);
});

test('갱신기: start() 는 결제 전 계정을 짧은 주기로 다시 본다', async () => {
  const am = new AccountManager([oauth('ai01', { disabled: true, pendingPlan: true }), oauth('b')], 0.98);
  am.ensureTokenFresh = async () => {};
  const seen = [];
  const r = new SubscriptionRefresher(am, {
    profileFn: async (tok) => { seen.push(tok); return FREE; },
    log: () => {}, startDelayMs: 5, intervalMs: 60_000, pendingIntervalMs: 20,
  });
  r.start();
  await new Promise(res => setTimeout(res, 120));
  r.stop();
  const first = seen.slice(0, 2).sort();
  assert.deepEqual(first, ['t-ai01', 't-b'], '시작 직후 전체 한 번');
  const later = seen.slice(2);
  assert.ok(later.length >= 2, `결제 전 계정은 20ms 마다 더: ${JSON.stringify(seen)}`);
  assert.ok(later.every(t => t === 't-ai01'), `짧은 주기는 결제 전 계정만: ${JSON.stringify(later)}`);
});
