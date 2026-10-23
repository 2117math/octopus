import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRenewal, nextRenewalOnDate, subscriptionText } from '../src/subscription.js';
import { normalizeProfile } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { SubscriptionRefresher } from '../src/subscription-refresher.js';
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
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, now).text, '구독 11/22 D-29 (추정)');
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
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, Date.parse('2026-10-22T02:00:00Z')).text, '구독 10/22 D-day (추정)');
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
  // 경고색은 원장이 입력한 확정 날짜(renewDate)에만. 프로필 추정은 항상 0.
  const lv = iso => subscriptionText({ createdAt: CREATED, renewDate: '2026-08-22', status: 'active' }, Date.parse(iso)).level;
  assert.equal(lv('2026-10-18T03:00:00Z'), 0);
  assert.equal(lv('2026-10-19T03:00:00Z'), 1);
  assert.equal(lv('2026-10-22T02:00:00Z'), 2);
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, Date.parse('2026-10-22T02:00:00Z')).level, 0, '추정은 경고색 없음');
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
  const am = new AccountManager([oauth('a@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active', renewDate: '2026-08-22' }), oauth('b@x.com')], 0.98);
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
    assert.match(a, /5h.*· 구독 11\/22 D-29$/);
    assert.ok(!b.includes('구독'));
  });
});

test('attach 모드 TUI 도 status 의 subscription 으로 같은 꼬리를 그린다', () => {
  const am = new RemoteAccountManager();
  am.applyStatus({ accounts: [{ name: 'a@x.com', type: 'oauth', quota: {}, subscription: { createdAt: CREATED, status: 'active', renewAt: 1, daysLeft: 1 } }] });
  const tui = makeTUI(am);
  assert.match(plain(row(tui, 0)), /· 구독 \d+\/\d+ D-(\d+|day)( \(추정\))?$/);
});

test('대시보드 페이지가 구독 줄 헬퍼를 싣는다', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('function subscriptionText'));
  assert.ok(html.includes('function nextRenewal'));
  assert.ok(html.includes('subscriptionText(a.subscription'));
});

// ── 갱신기 (프로브와 무관) ──────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const goodProfile = { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active', billingType: 'stripe_subscription' };

test('갱신기: 시작 직후 1회 읽고 구독 3필드를 저장, 6시간(간격) 뒤 다시 읽는다', async () => {
  const am = new AccountManager([oauth('a@x.com', { rateLimitTier: 'max_20x', hasClaudeMax: true })], 0.98);
  let calls = 0;
  const r = new SubscriptionRefresher(am, { profileFn: async () => { calls++; return goodProfile; }, startDelayMs: 5, intervalMs: 40, log: () => {} });
  r.start();
  try {
    await sleep(25);
    assert.equal(calls, 1, '시작 직후 1회');
    assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED);
    assert.equal(am.accounts[0].subscriptionStatus, 'active');
    assert.equal(am.accounts[0].billingType, 'stripe_subscription');
    await sleep(70);
    assert.ok(calls >= 2, '간격 뒤 재호출');
  } finally { r.stop(); }
  const after = calls;
  await sleep(60);
  assert.equal(calls, after, 'stop 뒤에는 더 읽지 않는다');
});

test('갱신기: codex·disabled·프로필 없는 계정 제외, 동시 2개까지', async () => {
  const am = new AccountManager([
    oauth('a@x.com'), oauth('b@x.com'), oauth('c@x.com'), oauth('d@x.com'),
    oauth('cx@x.com', { provider: 'codex', accountId: 'acct-1' }),
    oauth('off@x.com', { disabled: true }),
  ], 0.98);
  const seen = [];
  let inFlight = 0, peak = 0;
  const profileFn = async cred => {
    seen.push(cred); inFlight++; peak = Math.max(peak, inFlight);
    await sleep(15); inFlight--;
    return goodProfile;
  };
  const r = new SubscriptionRefresher(am, { profileFn, log: () => {} });
  await r.refreshAll();
  assert.equal(seen.length, 4, 'codex 와 disabled 는 읽지 않는다');
  assert.equal(peak, 2, '동시 2개');
  assert.equal(am.accounts[4].subscriptionCreatedAt, null);
  assert.equal(am.accounts[5].subscriptionCreatedAt, null);
  assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED);
});

test('갱신기: 실패·타임아웃·예외는 무해하고 로그 한 줄, 기존 값은 유지', async () => {
  const am = new AccountManager([oauth('a@x.com', { subscriptionCreatedAt: CREATED }), oauth('b@x.com'), oauth('c@x.com'), oauth('d@x.com')], 0.98);
  const logs = [];
  const profileFn = async cred => {
    if (cred.includes('b@x')) return { error: 'HTTP 500', status: 500 };
    if (cred.includes('c@x')) throw new Error('boom');
    if (cred.includes('d@x')) await sleep(200);
    return goodProfile;
  };
  const r = new SubscriptionRefresher(am, { profileFn, timeoutMs: 20, log: l => logs.push(l) });
  await r.refreshAll();
  assert.equal(logs.length, 3, 'b·c·d 각 한 줄');
  assert.equal(am.accounts[1].subscriptionCreatedAt, null);
  assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED, '성공 계정은 저장');
});

test('갱신기: 401 이면 토큰을 강제 갱신하고 한 번만 다시 읽는다', async () => {
  const am = new AccountManager([oauth('a@x.com')], 0.98);
  const forced = [];
  am.ensureTokenFresh = async (i, force) => { forced.push(!!force); };
  let calls = 0;
  const r = new SubscriptionRefresher(am, { profileFn: async () => (++calls === 1 ? { error: 'HTTP 401', status: 401 } : goodProfile), log: () => {} });
  await r.refreshAll();
  assert.equal(calls, 2);
  assert.deepEqual(forced, [false, true]);
  assert.equal(am.accounts[0].subscriptionCreatedAt, CREATED);
});

test('프로버는 티어를 아는 계정의 프로필을 다시 읽지 않는다(갱신기 하나로)', async () => {
  const am = new AccountManager([oauth('a@x.com', { rateLimitTier: 'max_20x', hasClaudeMax: true })], 0.98);
  let calls = 0;
  const prober = new Prober(am, { probeFn: async () => ({ unified5h: 0.1 }), profileFn: async () => { calls++; return goodProfile; }, log: () => {} });
  await prober.probeAccount(am.accounts[0]);
  assert.equal(calls, 0);
});
