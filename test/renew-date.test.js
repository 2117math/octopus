import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRenewal, subscriptionText } from '../src/subscription.js';
import { normalizeProfile } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { renderDashboardHtml } from '../src/dashboard.js';

// [local patch 2026-10-24 원장] 계정별 월 구독 갱신일: 프로필 subscription_created_at
// 의 일·시각이 매달 되풀이되고, 표시는 KST M/D + D-n.

const HOUR = 3600_000;
const KST = 9 * HOUR;
const CREATED = '2026-08-22T02:55:22.574587Z';
const SID = '3f2a1b9c-0000-4000-8000-000000000001';
const OPUS = 'claude-opus-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const kstDate = ms => { const d = new Date(ms + KST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const row = (tui, i) => tui._renderAcct(i, 10, true, [], [], {}, false);

function makeTUI(am) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return tui;
}

/** Date.now 를 고정해 콜백을 돌린다. */
function atTime(iso, fn) {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try { return fn(); } finally { Date.now = real; }
}

test('22일 기준: 10/24 에서 다음 갱신은 11/22, D-29', () => {
  const now = Date.parse('2026-10-24T03:00:00Z'); // KST 10/24 12:00
  const r = nextRenewal(CREATED, now);
  assert.equal(kstDate(r.renewAt), '11/22');
  assert.equal(r.daysLeft, 29);
  assert.equal(r.renewAt, Date.parse('2026-11-22T02:55:22.574Z'));
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, now).text, '구독 11/22 D-29');
});

test('31일 기준: 30일 달·2월은 말일, 다음 달은 다시 31일', () => {
  const created = '2026-08-31T10:00:00Z';
  assert.equal(nextRenewal(created, Date.parse('2026-09-05T00:00:00Z')).renewAt, Date.parse('2026-09-30T10:00:00Z'));
  assert.equal(nextRenewal(created, Date.parse('2026-10-05T00:00:00Z')).renewAt, Date.parse('2026-10-31T10:00:00Z'));
  assert.equal(nextRenewal(created, Date.parse('2027-02-05T00:00:00Z')).renewAt, Date.parse('2027-02-28T10:00:00Z'));
  assert.equal(nextRenewal(created, Date.parse('2028-02-05T00:00:00Z')).renewAt, Date.parse('2028-02-29T10:00:00Z'), '윤년 2월은 29일');
  assert.equal(nextRenewal(created, Date.parse('2026-12-31T10:00:01Z')).renewAt, Date.parse('2027-01-31T10:00:00Z'), '연말을 넘긴다');
});

test('당일: 갱신 시각 전이면 D-day, 지나면 다음 달', () => {
  const before = nextRenewal(CREATED, Date.parse('2026-10-22T02:00:00Z'));
  assert.equal(kstDate(before.renewAt), '10/22');
  assert.equal(before.daysLeft, 0);
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, Date.parse('2026-10-22T02:00:00Z')).text, '구독 10/22 D-day');
  const after = nextRenewal(CREATED, Date.parse('2026-10-22T03:00:00Z'));
  assert.equal(kstDate(after.renewAt), '11/22');
  assert.equal(after.daysLeft, 31);
});

test('D-n 은 KST 달력 날짜로 센다', () => {
  // 갱신 10/22 02:55Z = KST 10/22 11:55. 10/21 20:00Z = KST 10/22 05:00 → 같은 KST 날 → D-day.
  assert.equal(nextRenewal(CREATED, Date.parse('2026-10-21T20:00:00Z')).daysLeft, 0);
  // 10/21 14:00Z = KST 10/21 23:00 → D-1.
  assert.equal(nextRenewal(CREATED, Date.parse('2026-10-21T14:00:00Z')).daysLeft, 1);
});

test('경고 단계: D-4 보통, D-3 주황, D-day 빨강, 비활성 상태는 문구 그대로', () => {
  const lv = iso => subscriptionText({ createdAt: CREATED, status: 'active' }, Date.parse(iso)).level;
  assert.equal(lv('2026-10-18T03:00:00Z'), 0);
  assert.equal(lv('2026-10-19T03:00:00Z'), 1);
  assert.equal(lv('2026-10-22T02:00:00Z'), 2);
  const c = subscriptionText({ createdAt: CREATED, status: 'canceled' }, Date.now());
  assert.equal(c.text, '구독 상태: canceled');
  assert.equal(c.level, 2);
});

test('정보 없음(Codex·프로필 미수신)이면 표시 없음', () => {
  assert.equal(subscriptionText(null), null);
  assert.equal(subscriptionText({ createdAt: null, status: null }), null);
  assert.equal(subscriptionText({ createdAt: 'garbage', status: 'active' }), null);
  assert.equal(nextRenewal('garbage'), null);
  const am = new AccountManager([oauth('a@x.com'), oauth('cx@x.com', { provider: 'codex', accountId: 'acct-1' })], 0.98);
  assert.equal(am.getStatus().accounts[0].subscription, null);
  assert.equal(am.getStatus().accounts[1].subscription, null);
  const tui = makeTUI(am);
  assert.ok(!plain(row(tui, 0)).includes('구독'));
  assert.ok(!plain(row(tui, 1)).includes('구독'));
});

test('프로필 정규화·적용: 구독 필드가 계정에 저장되고 상태 파일 왕복에 남는다', () => {
  const p = normalizeProfile({
    account: { uuid: 'u' },
    organization: { subscription_created_at: CREATED, subscription_status: 'active', billing_type: 'stripe_subscription' },
  });
  assert.equal(p.subscriptionCreatedAt, CREATED);
  assert.equal(p.subscriptionStatus, 'active');
  assert.equal(p.billingType, 'stripe_subscription');
  const am = new AccountManager([oauth('a@x.com', { accountUuid: 'uuid-a' })], 0.98);
  am.applyProfileData(0, p);
  assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED);
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const am2 = new AccountManager([oauth('a@x.com', { accountUuid: 'uuid-a' })], 0.98);
  am2.restoreQuotaState(saved);
  assert.equal(am2.accounts[0].subscriptionCreatedAt, CREATED, '재시작 직후에도 남는다');
  assert.equal(am2.accounts[0].subscriptionStatus, 'active');
  assert.equal(am2.accounts[0].billingType, 'stripe_subscription');
});

test('/teamclaude/status 계정 객체의 subscription 필드', () => {
  const am = new AccountManager([oauth('a@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' })], 0.98);
  atTime('2026-10-24T03:00:00Z', () => {
    const sub = am.getStatus().accounts[0].subscription;
    assert.equal(sub.createdAt, CREATED);
    assert.equal(sub.status, 'active');
    assert.equal(sub.renewAt, Date.parse('2026-11-22T02:55:22.574Z'));
    assert.equal(sub.daysLeft, 29);
  });
});

test('TUI 계정 줄과 move 화면 꼬리, 색 단계', () => {
  const am = new AccountManager([oauth('a@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' }), oauth('b@x.com')], 0.98);
  const tui = makeTUI(am);
  atTime('2026-10-24T03:00:00Z', () => {
    assert.ok(plain(row(tui, 0)).endsWith(' · 구독 11/22 D-29'), '줄 맨 끝에 붙는다');
    assert.ok(!plain(row(tui, 1)).includes('구독'));
  });
  atTime('2026-10-19T03:00:00Z', () => {
    assert.ok(row(tui, 0).includes('\x1b[38;5;208m · 구독 10/22 D-3'), 'D-3 은 주황');
  });
  atTime('2026-10-22T02:00:00Z', () => {
    assert.ok(row(tui, 0).includes('\x1b[31m · 구독 10/22 D-day'), '당일은 빨강');
  });
  // move 화면
  am.beginSession(SID, { sessionId: SID, model: OPUS, clientPinned: false });
  am.recordSession(SID, 1, OPUS);
  am.endSession(SID);
  tui._key('m'); tui._key('enter');
  atTime('2026-10-24T03:00:00Z', () => {
    const lines = [];
    tui._renderMove(lines, 120, 28);
    const a = lines.map(plain).find(l => l.includes('a@x.com') && l.includes('5h'));
    const b = lines.map(plain).find(l => l.includes('b@x.com') && l.includes('5h'));
    assert.match(a, /5h.*· 구독 11\/22 D-29/);
    assert.ok(!b.includes('구독'));
  });
});

test('attach 모드 TUI 도 status 의 subscription 으로 같은 꼬리를 그린다', () => {
  const am = new RemoteAccountManager();
  am.applyStatus({ accounts: [{ name: 'a@x.com', type: 'oauth', quota: {}, subscription: { createdAt: CREATED, status: 'active', renewAt: 1, daysLeft: 1 } }] });
  const tui = makeTUI(am);
  assert.match(plain(row(tui, 0)), /· 구독 \d+\/\d+ D-(\d+|day)$/);
});

test('대시보드 페이지가 구독 줄 헬퍼를 싣는다', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('function subscriptionText'));
  assert.ok(html.includes('function nextRenewal'));
  assert.ok(html.includes('subscriptionText(a.subscription'));
});

test('프로버: 티어를 이미 아는 계정도 구독 정보가 없으면 프로필을 한 번 읽고, 6시간 안에는 다시 읽지 않는다', async () => {
  const am = new AccountManager([oauth('a@x.com', { rateLimitTier: 'max_20x', hasClaudeMax: true })], 0.98);
  let calls = 0;
  const profileFn = async () => { calls++; return { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' }; };
  const prober = new Prober(am, { probeFn: async () => ({ unified5h: 0.1 }), profileFn, log: () => {} });
  await prober.probeAccount(am.accounts[0]);
  assert.equal(calls, 1);
  assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED);
  await prober.probeAccount(am.accounts[0]);
  assert.equal(calls, 1, '6시간 안 재확인 없음');
  am.accounts[0].subscriptionCheckedAt = Date.now() - 7 * HOUR;
  await prober.probeAccount(am.accounts[0]);
  assert.equal(calls, 2);
});
