// [원장 2026-11-04] 「5시간 계정 먼저」(fiveHourFirst): 새 대화를 앉힐 때 5시간 제한이 있는 계정부터 쓰고, 그 계정들이
// 5시간 또는 주간을 다 써서 받을 수 없을 때만 나머지 계정으로. 이미 앉은 대화는 옮기지 않는다(배정만 바뀜).
// 판정(hasFiveHourWindow): ① accounts[].fiveHour 수동 지정 → ② quota.sessionWindowStated → ③ 5시간 사용률·리셋이 알려짐.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, hasFiveHourWindow } from '../src/account-manager.js';
import { normalizeUsagePayload } from '../src/oauth.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { setFiveHourFirst, configuredFiveHourAccounts, ConfigOpError } from '../src/config-ops.js';

const H = 3600e3;
const MODEL = 'claude-opus-5-5';

/** 5시간 있음 2(5h-a 주간 0.5 · 5h-b 0.45, 대화 1개씩 앉음) + 없음 2(no-a 0.3 · no-b 0.35, 대화 없음).
 *  끄면 원래 규칙(주간 40% 미만 구간 → 대화 수 → 주간)으로 no-a 가 뽑힌다. */
function fleet({ extra = [], weekly = [0.5, 0.45, 0.3, 0.35], ...opts } = {}) {
  const now = Date.now();
  const names = ['5h-a', '5h-b', 'no-a', 'no-b'];
  const am = new AccountManager(
    names.map((name, i) => ({ name, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}`, ...(extra[i] || {}) })),
    0.98, { distributeSessions: true, ...opts });
  am.accounts.forEach((a, i) => {
    const q = a.quota;
    q.unified7d = weekly[i]; q.unified7dReset = now + (60 + i) * H;
    if (i < 2) { q.sessionWindowStated = true; q.unified5h = 0.2; q.unified5hReset = now + 2 * H; }
    else q.sessionWindowStated = false;
  });
  am.sessionTracker.touch('S0/x', 0, 'unified7d');
  am.sessionTracker.touch('S1/x', 1, 'unified7d');
  return am;
}
const pick = am => am._pickLeastLoadedEven(null, MODEL)?.name;

test('끔(기본): 원래 규칙 — 대화가 없고 주간이 가장 낮은 5시간 없는 계정(no-a)', () => {
  const am = fleet();
  assert.equal(am.fiveHourFirst, false, '기본 끔');
  assert.equal(pick(am), 'no-a');
});

test('켬: 5시간 없는 계정이 대화 수가 적고 주간이 낮아도 5시간 계정 중 하나(그 안에서는 원래 정렬 — 주간 낮은 5h-b)', () => {
  const am = fleet({ fiveHourFirst: true });
  assert.equal(pick(am), '5h-b');
  assert.equal(am._pickLeastLoaded(null, MODEL)?.name, '5h-b', '새 대화 배정 입구(_pickLeastLoaded)도 같다');
});

test('켬: 5시간 계정들이 받을 수 없으면(하나는 5시간 100%, 하나는 주간 100%) 나머지 계정으로', () => {
  const am = fleet({ fiveHourFirst: true });
  am.accounts[0].quota.unified5h = 1;
  am.accounts[1].quota.unified7d = 1;
  assert.equal(pick(am), 'no-a');
  // 하나만 막히면 남은 5시간 계정으로.
  am.accounts[1].quota.unified7d = 0.45;
  assert.equal(pick(am), '5h-b');
  am.accounts[1].quota.unified7d = 1;
  am.accounts[0].quota.unified5h = 0.5;
  assert.equal(pick(am), '5h-a');
});

test('수동 지정: accounts[].fiveHour:false 는 5시간 계정에서 빠지고, true 는 조회와 상관없이 들어간다', () => {
  const am = fleet({ fiveHourFirst: true, extra: [{}, { fiveHour: false }] });
  assert.equal(am.accounts[1].fiveHour, false, '설정 값이 매니저 계정에 남는다');
  assert.equal(pick(am), '5h-a', '5h-b 는 수동으로 뺐다');
  const am2 = fleet({ fiveHourFirst: true, extra: [{ fiveHour: false }, { fiveHour: false }, {}, { fiveHour: true }] });
  assert.equal(pick(am2), 'no-b', 'no-b 는 조회가 없다고 했어도 수동으로 넣었다');
  assert.deepEqual(am2.fiveHourAccountNames(), ['no-b']);
});

test('setFiveHourFirst 토글이 다음 배정에 바로 반영된다', () => {
  const am = fleet();
  assert.equal(pick(am), 'no-a');
  am.setFiveHourFirst(true);
  assert.equal(pick(am), '5h-b');
  am.setFiveHourFirst(false);
  assert.equal(pick(am), 'no-a');
  am.setFiveHourFirst('yes');
  assert.equal(am.fiveHourFirst, false, 'true 만 켬');
});

test('켬: 5시간 계정이 하나도 없으면 후보 그대로(원래 규칙)', () => {
  const am = fleet({ fiveHourFirst: true, extra: [{ fiveHour: false }, { fiveHour: false }] });
  assert.equal(pick(am), 'no-a');
});

test('켬: 집중 계정은 5시간이 없어도 정렬 맨 앞 규칙 그대로(좁히기에서 빼지 않음)', () => {
  const am = fleet({ fiveHourFirst: true });
  am.setFocusAccount('no-b');
  assert.equal(pick(am), 'no-b');
});

test('adaptive(소진우선) 모드에서도 5시간 계정만 고른다', () => {
  // 소진우선은 남은 주간이 가장 적은 계정부터 — 5시간 없는 계정을 가장 많이 써 둔다.
  const am = fleet({ weekly: [0.3, 0.35, 0.6, 0.55] });
  am.setDistributeSessions('adaptive');
  assert.equal(am.distributionMode, 'adaptive');
  const off = am._pickAdaptive(null, MODEL)?.name;
  assert.ok(off === 'no-a' || off === 'no-b', `끄면 5시간 없는 계정(${off})`);
  am.setFiveHourFirst(true);
  const on = am._pickAdaptive(null, MODEL)?.name;
  assert.ok(on === '5h-a' || on === '5h-b', `켜면 5시간 계정(${on})`);
  const placed = am._pickLeastLoaded(null, MODEL)?.name;
  assert.ok(placed === '5h-a' || placed === '5h-b', `배정 입구도 5시간 계정(${placed})`);
});

test('getStatus().fiveHourFirst = { enabled, accounts: 5시간 계정 이름들 }, 계정마다 fiveHour', () => {
  const am = fleet({ extra: [{}, {}, { fiveHour: false }] });
  let s = am.getStatus();
  assert.deepEqual(s.fiveHourFirst, { enabled: false, accounts: ['5h-a', '5h-b'] });
  am.setFiveHourFirst(true);
  s = am.getStatus();
  assert.deepEqual(s.fiveHourFirst, { enabled: true, accounts: ['5h-a', '5h-b'] });
  assert.deepEqual(s.accounts.map(a => a.fiveHour), [null, null, false, null]);
});

test('판정 hasFiveHourWindow: 수동 → sessionWindowStated → 사용률·리셋', () => {
  const now = Date.now();
  assert.equal(hasFiveHourWindow({ quota: {} }), false, '모름 = 아님');
  assert.equal(hasFiveHourWindow({ quota: { unified5h: 0.1, unified5hReset: now + H } }), true, '기록 없으면 사용률·리셋');
  assert.equal(hasFiveHourWindow({ quota: { unified5h: 0.1 } }), false, '리셋 없으면 아님');
  assert.equal(hasFiveHourWindow({ quota: { sessionWindowStated: true } }), true, '창이 끝나 값이 지워져도 사실은 남음');
  assert.equal(hasFiveHourWindow({ quota: { sessionWindowStated: false, unified5h: 0.1, unified5hReset: now + H } }), false);
  assert.equal(hasFiveHourWindow({ fiveHour: true, quota: { sessionWindowStated: false } }), true);
  assert.equal(hasFiveHourWindow({ fiveHour: false, quota: { sessionWindowStated: true } }), false);
  assert.equal(hasFiveHourWindow(null), false);
});

test('사용량 조회: five_hour 가 null 이면 sessionWindowStated=false(없음), 객체면 true — 모름(기록 없음)과 구분', () => {
  const am = new AccountManager([{ name: 'x', type: 'oauth', accessToken: 'tok', refreshToken: 'r' }], 0.98);
  const q = am.accounts[0].quota;
  assert.equal(q.sessionWindowStated, undefined, '처음엔 모름');
  const reset = new Date(Date.now() + 50 * H).toISOString();
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day: { utilization: 30, resets_at: reset } }));
  assert.equal(q.sessionWindowStated, false);
  assert.equal(am._hasFiveHour(am.accounts[0]), false);
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: 31, resets_at: reset } }));
  assert.equal(q.sessionWindowStated, true);
  assert.equal(am._hasFiveHour(am.accounts[0]), true);
  // 실패한 조회·주간도 없는 응답은 아무것도 바꾸지 않는다.
  am.applyUsageData(0, { error: 'HTTP 500' });
  am.applyUsageData(0, normalizeUsagePayload({}));
  assert.equal(q.sessionWindowStated, true);
});

test('설정 다시 읽기(sync): accounts[].fiveHour 가 매니저·메모리 설정에 반영되고 지우면 null', async () => {
  const disk = [{ name: 'k1', type: 'apikey', apiKey: 'sk-1', fiveHour: true }, { name: 'k2', type: 'apikey', apiKey: 'sk-2' }];
  const mem = disk.map(a => ({ ...a }));
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  assert.deepEqual(am.accounts.map(a => a.fiveHour), [true, null]);
  disk[0].fiveHour = false;
  disk[1].fiveHour = true;
  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.deepEqual(am.accounts.map(a => a.fiveHour), [false, true]);
  assert.deepEqual(mem.map(a => a.fiveHour), [false, true]);
  delete disk[0].fiveHour;
  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.equal(am.accounts[0].fiveHour, null);
  assert.equal('fiveHour' in mem[0], false);
});

test('CLI 설정 함수: setFiveHourFirst(켬/끔, 같으면 안 씀) · configuredFiveHourAccounts', () => {
  const c = { accounts: [{ name: 'a', fiveHour: true }, { name: 'b', fiveHour: false }, { name: 'c' }] };
  assert.equal(setFiveHourFirst(c, false), false, '없음 = 끔이라 안 바뀜');
  assert.equal('fiveHourFirst' in c, false);
  assert.equal(setFiveHourFirst(c, true), true);
  assert.equal(c.fiveHourFirst, true);
  assert.equal(setFiveHourFirst(c, true), false);
  assert.equal(setFiveHourFirst(c, false), true);
  assert.equal(c.fiveHourFirst, false);
  assert.throws(() => setFiveHourFirst(c, 'on'), ConfigOpError);
  assert.deepEqual(configuredFiveHourAccounts(c), ['a']);
  assert.deepEqual(configuredFiveHourAccounts({}), []);
});
