// [local patch 2026-10-23 원장] 새 세션 배정 = 주간 사용률 균형.
//   요구 ① 주간 사용량을 맞춰 써야 5시간 한도를 피한다.
//   요구 ② 주간 리셋이 하루 남은 계정이 아니면 한 계정에 몰아 두지 않는다.
//   요구 ③ 한 번 배정된 세션은 그 계정의 5시간 사용량이 다 찰 때까지 바꾸지 않는다.
// 순서: priority → heldOff → finalDay → hot5h → 주간 사용률(2%p 칸) → known → active → inFlight → pressure → reset
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600e3;
const MIN = 60e3;
const MODEL = 'claude-sonnet-5-5';
const SID = '3f2a1b9c-0000-4000-8000-000000000001';

/** weekly[i] = 주간 사용률. opts.reset[i] = 주간 리셋까지 남은 시간(ms) · opts.h5[i] = 5시간 사용률. */
function fleet(weekly, { reset = [], h5 = [], ...opts } = {}) {
  const now = Date.now();
  const am = new AccountManager(
    weekly.map((_, i) => ({ name: `acct${i}`, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}` })),
    1, { distributeSessions: true, ...opts });
  weekly.forEach((u, i) => {
    const q = am.accounts[i].quota;
    q.unified7d = u; q.unified7dReset = now + (reset[i] ?? (50 + i) * H);
    q.unified5h = h5[i] ?? 0.1; q.unified5hReset = now + 2 * H;
  });
  return am;
}

const seat = (am, key, idx) => { am.sessionTracker.touch(key, idx, 'unified7d'); };
const pick = (am) => am._pickLeastLoadedEven(null, MODEL)?.name;

test('(a) 주간 57%·세션 13개 계정이 주간 71%·세션 0개 계정보다 먼저 뽑힌다', () => {
  const am = fleet([0.57, 0.71]);
  for (let i = 0; i < 13; i++) seat(am, `S${i}/x`, 0);
  assert.equal(am.sessionTracker.knownCountFor(0), 13);
  assert.equal(am.sessionTracker.knownCountFor(1), 0);
  assert.equal(pick(am), 'acct0');
});

test('(b) 리셋 20시간 남은 0.60 계정이 리셋 3일 남은 0.50 계정보다 먼저 뽑힌다(finalDay)', () => {
  const am = fleet([0.60, 0.50], { reset: [20 * H, 72 * H] });
  assert.equal(pick(am), 'acct0');
});

test('(c) 리셋 20시간 남았어도 0.97 이면 finalDay 가 아니라 낮은 쪽이 뽑힌다', () => {
  const am = fleet([0.97, 0.50], { reset: [20 * H, 72 * H] });
  assert.equal(pick(am), 'acct1');
});

test('(c2) 리셋이 24시간보다 멀면 finalDay 가 아니다', () => {
  const am = fleet([0.60, 0.50], { reset: [25 * H, 72 * H] });
  assert.equal(pick(am), 'acct1');
});

test('(d) 5시간 0.85 인 0.50 계정은 5시간 0.10 인 0.55 계정에 밀린다', () => {
  const am = fleet([0.50, 0.55], { h5: [0.85, 0.10] });
  assert.equal(pick(am), 'acct1');
});

test('(d2) 5시간이 79% 이면 아직 hot 이 아니다', () => {
  const am = fleet([0.50, 0.55], { h5: [0.79, 0.10] });
  assert.equal(pick(am), 'acct0');
});

test('(e) 0.570 과 0.575 는 같은 2%p 칸이라 세션이 적은 쪽이 뽑힌다', () => {
  const am = fleet([0.570, 0.575]);
  seat(am, 'A/aaa', 0);
  assert.equal(pick(am), 'acct1');
});

test('(e2) 칸이 다르면(0.57 vs 0.59) 세션이 있어도 낮은 쪽이 뽑힌다', () => {
  const am = fleet([0.57, 0.59]);
  seat(am, 'A/aaa', 0);
  assert.equal(pick(am), 'acct0');
});

test('(e3) 칸 경계의 부동소수 오차(0.58)에도 칸이 한 칸 내려가지 않는다', () => {
  // 0.58 * 50 === 28.999999999999996 — 보정 없이는 0.56 과 같은 칸이 된다.
  const am = fleet([0.58, 0.56]);
  seat(am, 'A/aaa', 1);
  assert.equal(pick(am), 'acct1', '0.56 칸이 0.58 칸보다 낮다');
  const am2 = fleet([0.58, 0.585]);
  seat(am2, 'A/aaa', 0);
  assert.equal(pick(am2), 'acct1', '0.58 과 0.585 는 같은 칸이라 세션 적은 쪽');
});

test('(f) 배정된 세션은 5시간 0.6 이면 주간이 훨씬 낮은 계정이 있어도 옮기지 않는다', () => {
  const am = fleet([0.70, 0.10], { h5: [0.6, 0.1] });
  seat(am, SID, 0);
  assert.equal(am._selectForSession(SID, null, MODEL, null).name, 'acct0');
});

test('(f2) 고정 계정이 쓸 수 없게 되면(5시간 1.0) 새 배정 — 가장 낮은 주간', () => {
  const am = fleet([0.70, 0.10, 0.40], { h5: [1.0, 0.1, 0.1] });
  seat(am, SID, 0);
  assert.equal(am._selectForSession(SID, null, MODEL, null).name, 'acct1');
});

// --- (g) 놀고 있던 세션 재배치: 켜 둬도 5시간이 남은 계정에서는 옮기지 않는다 ---
const ON = { enabled: true, idleSeconds: 300, gap: 0.10 };

function idleSetup(h5) {
  const am = fleet([0.48, 0.31], { h5, rebalanceSessions: ON });
  am.beginSession(SID, { sessionId: SID, model: MODEL, clientPinned: false });
  am.recordSession(SID, 0, MODEL);
  am.endSession(SID);
  for (const s of am.sessionTracker.sessions.values()) {
    s.lastSeen -= 7 * MIN;
    for (const pin of s.pins.values()) pin.at -= 7 * MIN;
  }
  am.beginSession(SID, { sessionId: SID, model: MODEL, clientPinned: false });
  return am;
}

test('(g) 재배치를 켜도 고정 계정의 5시간이 0.6 이면 옮기지 않는다', () => {
  const am = idleSetup([0.6, 0.1]);
  assert.equal(am.getActiveAccount(null, MODEL, null, SID).index, 0);
  assert.equal(am.sessionTracker.pinnedAccount(SID, am._weeklyBucketFor(MODEL)), 0);
});

test('(g2) 대조: 고정 계정의 5시간을 모르면(null) 기존 재배치 동작 그대로 옮긴다', () => {
  const am = idleSetup([null, 0.1]);
  am.accounts[0].quota.unified5h = null;
  assert.equal(am.getActiveAccount(null, MODEL, null, SID).index, 1);
});
