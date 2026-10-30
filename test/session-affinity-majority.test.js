// [local patch 2026-10-30 원장] 세션 자리 = 다수결. 한 세션의 대화가 두 계정에 걸치면
// 「가장 최근 핀」이 아니라 대화가 가장 많이 앉은 계정(같으면 가장 먼저 앉은 계정)이
// 화면의 계정(sessionList)이자 새 하위 대화가 따라갈 자리(siblingAccounts)다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, rankPinnedAccounts } from '../src/session-tracker.js';

const SHARED = 'unified7d';
const SID = '3f2a1b9c-0000-4000-8000-0000000000aa';

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

// ── 순수 함수 ──────────────────────────────────────────────────

test('rankPinnedAccounts: 대화가 더 많이 앉은 계정이 먼저', () => {
  assert.deepEqual(rankPinnedAccounts([{ idx: 1, at: 10 }, { idx: 0, at: 5 }, { idx: 1, at: 20 }]), [1, 0]);
});

test('rankPinnedAccounts: 수가 같으면 가장 먼저 핀된 계정이 먼저', () => {
  assert.deepEqual(rankPinnedAccounts([{ idx: 2, at: 30 }, { idx: 0, at: 5 }]), [0, 2]);
});

test('rankPinnedAccounts: 핀이 없으면 빈 배열', () => {
  assert.deepEqual(rankPinnedAccounts([]), []);
});

// ── tracker ────────────────────────────────────────────────────

test('두 계정에 걸친 세션: 가장 최근 핀(1)이 아니라 다수(0)가 화면의 계정이자 형제 자리', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  // 대화 둘은 계정 0, 가장 최근의 대화 하나만 계정 1.
  for (const [conv, idx] of [['main', 0], ['agent1', 0], ['agent2', 1]]) {
    const key = `${SID}/${conv}`;
    st.beginRequest(key, clock.t, { sessionId: SID });
    st.touch(key, idx, SHARED, clock.t);
    st.endRequest(key, clock.t);
    clock.t += 1000;
  }

  const row = st.sessionList(clock.t).find(r => r.id === SID);
  assert.ok(row, '세션 줄이 있다');
  assert.equal(row.account, 0, '다수결: 대화 둘이 앉은 계정 0');
  assert.equal(st.siblingAccounts(`${SID}/agent3`, clock.t)[0], 0, '새 하위 대화도 계정 0 을 따라간다');
});
