// [local patch 2026-10-23 원장, 2차] 새 세션 배정 = 87% 아껴 두기 · 계정당 2세션 · 주간 40/60/87 구간.
//   요구 ① 주간 사용량을 맞춰 써야 5시간 한도를 피한다.
//   요구 ② 한 계정에 두 개까지, 어쩔 수 없을 때만 세 개째.
//   요구 ③ 87% 이상은 놔뒀다가 마지막에(남은 13% 는 5시간 한 번이면 끝). 단 주간 리셋이 24시간 안이면 먼저 마무리.
//   요구 ④ 한 번 배정된 세션은 그 계정의 5시간 사용량이 다 찰 때까지 바꾸지 않는다.
// 순서: priority → heldOff → reserve → hot5h → full(세션 2개 이상) → tier(40/60%) → 세션 수 → 주간 사용률 → inFlight → pressure → reset
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

// --- 시뮬레이션: 2026-10-23 실측 -------------------------------------------------
// acct0=2117math · acct1=mimath(세션 4개 이미 붙음) · acct2=2117academy · acct3=bluejin · acct4=misso
test('(sim) 실측 숫자에서 새 세션 8개: bluejin, 2117math, misso 를 돌고, 2개씩 차면 tier 낮은 mimath · 2117academy 는 한 번도 안 뽑힌다', () => {
  const NAMES = ['2117math', 'mimath', '2117academy', 'bluejin', 'misso'];
  const am = fleet([0.67, 0.59, 0.91, 0.64, 0.71], {
    reset: [73 * H, 97 * H, 57 * H, 111 * H, 89 * H],
    h5: [0.16, 0.11, 0.27, 0.02, 0.08],
  });
  for (let i = 0; i < 4; i++) seat(am, `M${i}/x`, 1);
  const order = [];
  for (let n = 0; n < 8; n++) {
    const a = am._pickLeastLoadedEven(null, MODEL);
    order.push(NAMES[a.index]);
    seat(am, `N${n}/x`, a.index);
  }
  assert.deepEqual(order, ['bluejin', '2117math', 'misso', 'bluejin', '2117math', 'misso', 'mimath', 'mimath']);
  assert.ok(!order.includes('2117academy'), '주간 91% 계정은 아껴 둔다');
});

// --- reserve: 87% 이상은 아껴 두기, 단 리셋이 24시간 안이면 먼저 마무리 ---
test('(r1) 리셋 20시간 남은 0.90 계정이 0.50 계정보다 먼저 뽑힌다(리셋 전 마무리)', () => {
  const am = fleet([0.90, 0.50], { reset: [20 * H, 72 * H] });
  assert.equal(pick(am), 'acct0');
});

test('(r2) 리셋 20시간 남았어도 0.99 이면 마무리 대상이 아니라 아껴 둔다', () => {
  const am = fleet([0.99, 0.50], { reset: [20 * H, 72 * H] });
  assert.equal(pick(am), 'acct1');
});

test('(r3) 리셋 3일 남은 0.88 은 0.80 보다 뒤', () => {
  const am = fleet([0.88, 0.80], { reset: [72 * H, 72 * H] });
  assert.equal(pick(am), 'acct1');
});

test('(r4) 0.87 경계: 0.869 는 아끼지 않고(1) 0.870 은 아낀다(2)', () => {
  const am = fleet([0.869, 0.87], { reset: [72 * H, 72 * H] });
  assert.deepEqual(am.accounts.map(a => am._reserveRank(a, MODEL, Date.now())), [1, 2]);
});

test('(r5) 다른 계정이 전부 쓸 수 없으면 0.88 도 뽑힌다', () => {
  const am = fleet([0.88, 0.30], { reset: [72 * H, 72 * H], h5: [0.1, 1.0] });
  assert.equal(pick(am), 'acct0');
});

test('(r6) 리셋 24시간 밖 0.50 계정은 마무리 대상이 아니다(reserve 1)', () => {
  const am = fleet([0.90, 0.50], { reset: [25 * H, 72 * H] });
  assert.equal(pick(am), 'acct1');
});

// --- hot5h ---
test('(h1) 5시간 0.85 인 0.50 계정은 5시간 0.10 인 0.55 계정에 밀린다', () => {
  const am = fleet([0.50, 0.55], { h5: [0.85, 0.10] });
  assert.equal(pick(am), 'acct1');
});

test('(h2) 5시간이 79% 이면 아직 hot 이 아니다', () => {
  const am = fleet([0.50, 0.55], { h5: [0.79, 0.10] });
  assert.equal(pick(am), 'acct0');
});

// --- full: 계정당 2세션 ---
test('(s1) 세션 2개 계정은 같은 tier 의 세션 0개 계정보다 뒤', () => {
  const am = fleet([0.10, 0.20]);
  seat(am, 'A/x', 0); seat(am, 'B/x', 0);
  assert.equal(pick(am), 'acct1');
});

test('(s2) full 이 tier 보다 앞: 세션 2개인 0.10 계정은 세션 1개인 0.50 계정보다 뒤', () => {
  const am = fleet([0.10, 0.50]);
  seat(am, 'A/x', 0); seat(am, 'B/x', 0); seat(am, 'C/x', 1);
  assert.equal(pick(am), 'acct1');
});

test('(s3) 모든 계정이 2개씩이면 tier 낮은 쪽', () => {
  const am = fleet([0.50, 0.30]);
  seat(am, 'A/x', 0); seat(am, 'B/x', 0); seat(am, 'C/x', 1); seat(am, 'D/x', 1);
  assert.equal(pick(am), 'acct1');
});

test('(s4) 같은 tier 에서 모두 가득이면 세션이 적은 쪽', () => {
  const am = fleet([0.30, 0.20]);
  for (let i = 0; i < 3; i++) seat(am, `A${i}/x`, 1);
  seat(am, 'B/x', 0); seat(am, 'C/x', 0);
  assert.equal(pick(am), 'acct0');
});

test('(s5) 한 세션이 여러 대화로 퍼져도 한 자리(2개 채워지지 않음)', () => {
  const am = fleet([0.10, 0.20]);
  seat(am, 'A/aaa', 0); seat(am, 'A/bbb', 0); seat(am, 'A/ccc', 0);
  assert.equal(am.sessionTracker.knownCountFor(0), 1);
  assert.equal(am._pickLeastLoadedEven(null, MODEL).name, 'acct1', '세션 수가 적은 쪽(0개)이 먼저');
  seat(am, 'B/x', 1);
  assert.equal(pick(am), 'acct0', '둘 다 1개면 주간 사용률 낮은 쪽');
});

test('(s6) 쉬는 중이지만 붙어 있는 세션도 센다', () => {
  const am = fleet([0.10, 0.20]);
  const t0 = Date.now() - 10 * MIN;
  am.sessionTracker.touch('A/x', 0, 'unified7d', t0);
  am.sessionTracker.touch('B/x', 0, 'unified7d', t0);
  assert.equal(am.sessionTracker.activeCountFor(0), 0);
  assert.equal(pick(am), 'acct1');
});

// --- tier: 40/60 ---
test('(t1) tier 0(0.30) 계정은 세션 1개여도 tier 2(0.70) 세션 0개보다 먼저', () => {
  const am = fleet([0.30, 0.70]);
  seat(am, 'A/x', 0);
  assert.equal(pick(am), 'acct0');
});

test('(t2) tier 경계: 0.39 는 0, 0.40 은 1, 0.59 는 1, 0.60 은 2', () => {
  const am = fleet([0.39, 0.40, 0.59, 0.60]);
  assert.deepEqual(am.accounts.map(a => am._tierRank(a, MODEL)), [0, 1, 1, 2]);
});

test('(t3) 같은 tier 에서는 세션 수가 주간 사용률보다 앞(0.50 세션 0 vs 0.45 세션 1)', () => {
  const am = fleet([0.45, 0.50]);
  seat(am, 'A/x', 0);
  assert.equal(pick(am), 'acct1');
});

test('(t4) 같은 tier·같은 세션 수면 주간 사용률이 낮은 쪽(양자화 없음 — 0.571 vs 0.570)', () => {
  const am = fleet([0.571, 0.570]);
  assert.equal(pick(am), 'acct1');
});

test('(t5) 주간 사용률을 모르는 계정은 tier 0 이라 맨 앞', () => {
  const am = fleet([0.30, 0.30]);
  am.accounts[1].quota.unified7d = null;
  assert.equal(am._tierRank(am.accounts[1], MODEL), 0);
  assert.equal(pick(am), 'acct1');
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
