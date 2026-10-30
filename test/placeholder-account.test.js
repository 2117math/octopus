// 결제 전 계정 「이름만 미리 넣기」 — 원장 2026-10-28. Anthropic 로그인 페이지가 Pro/Max 아닌 계정을
// 막아(스크린샷 「Claude Code에 연결하려면 Claude Max 또는 Pro가 필요합니다」) 토큰 없는 줄을 넣어 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAccountNames, addPlaceholderAccounts, ConfigOpError } from '../src/config-ops.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { SubscriptionRefresher } from '../src/subscription-refresher.js';
import { TUI } from '../src/tui.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const HOUR = 3600e3;
const oauth = (name, extra = {}) => ({ name, id: `id-${name}`, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });

test('expandAccountNames: 범위·여러 개·중복 제거·오류', () => {
  assert.deepEqual(expandAccountNames('ai01-03@2117academy.com'), ['ai01@2117academy.com', 'ai02@2117academy.com', 'ai03@2117academy.com']);
  assert.deepEqual(expandAccountNames('ai9-11@x.com'), ['ai9@x.com', 'ai10@x.com', 'ai11@x.com'], '자릿수는 앞 숫자대로');
  assert.deepEqual(expandAccountNames('a@x.com, b@y.org  a@x.com;c@z.net'), ['a@x.com', 'b@y.org', 'c@z.net']);
  assert.equal(expandAccountNames('ai01-21@2117academy.com').length, 21);
  assert.throws(() => expandAccountNames('ai05-03@x.com'), ConfigOpError);
  assert.throws(() => expandAccountNames('hello'), ConfigOpError);
  assert.throws(() => expandAccountNames(''), ConfigOpError);
  assert.throws(() => expandAccountNames('a1-999@x.com'), ConfigOpError);
});

test('addPlaceholderAccounts: 토큰 없는 결제 전 줄을 넣고, 이미 있는 이름은 건너뛴다', () => {
  const config = { accounts: [oauth('ai01@2117academy.com')] };
  const r = addPlaceholderAccounts(config, 'ai01-03@2117academy.com', { renewDate: '2026-11-05' });
  assert.deepEqual(r.added, ['ai02@2117academy.com', 'ai03@2117academy.com']);
  assert.deepEqual(r.skipped, ['ai01@2117academy.com']);
  const row = config.accounts[1];
  assert.equal(row.type, 'oauth');
  assert.equal(row.placeholder, true);
  assert.equal(row.pendingPlan, true);
  assert.equal(row.disabled, true);
  assert.equal(row.renewDate, '2026-11-05');
  assert.equal('accessToken' in row, false);
  assert.deepEqual(addPlaceholderAccounts(config, 'ai02@2117academy.com').skipped, ['ai02@2117academy.com']);
});

test('resolveAccounts: 빈 줄은 토큰이 없어도 살아남고(꺼 둔 채), 그냥 토큰 없는 줄은 여전히 버린다', async () => {
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const out = await resolveAccounts({ accounts: [
      oauth('a'),
      { name: 'ai01@2117academy.com', type: 'oauth', placeholder: true, pendingPlan: true, disabled: true },
      { name: 'broken', type: 'oauth' },
    ] });
    assert.deepEqual(out.map(a => a.name), ['a', 'ai01@2117academy.com']);
    assert.equal(out[1].disabled, true);
  } finally { console.error = orig; }
  assert.ok(errs.some(e => /No token for "broken"/.test(e)));
});

test('AccountManager: 빈 줄은 결제 전·꺼짐이고 어떤 요청에도 뽑히지 않으며 상태 요약에 placeholder 가 나온다', () => {
  const am = new AccountManager([
    { name: 'ai01@2117academy.com', id: 'id-ai01', type: 'oauth', placeholder: true, pendingPlan: true, disabled: true },
    oauth('b'),
  ], 0.98);
  const ph = am.accounts[0];
  assert.equal(ph.placeholder, true);
  assert.equal(ph.pendingPlan, true);
  assert.equal(ph.disabled, true);
  assert.equal(ph.credential, undefined);
  assert.equal(am.unavailableReason(ph), 'disabled');
  assert.equal(am.getStatus().accounts[0].placeholder, true);
  // 갱신기·프로버 대상이 아니다(토큰이 없으니).
  const r = new SubscriptionRefresher(am, { profileFn: async () => ({}), log: () => {} });
  assert.equal(r._eligible(ph), false);
});

test('로그인 뒤 reload: 디스크 줄에 토큰이 생기고 placeholder 가 빠지면 계정이 채워진다', async () => {
  const disk0 = { accounts: [{ name: 'ai01@2117academy.com', id: 'id-ai01', type: 'oauth', placeholder: true, pendingPlan: true, disabled: true }] };
  const config = { accounts: disk0.accounts.map(a => ({ ...a })) };
  const am = new AccountManager(config.accounts, 0.98);
  assert.equal(am.accounts[0].credential, undefined);
  // 결제 뒤 L 로그인 → upsertOAuthAccount 가 그 줄에 토큰을 넣고 placeholder·pendingPlan·disabled 를 지운 모양.
  const disk1 = { accounts: [oauth('ai01@2117academy.com', { id: 'id-ai01', hasClaudeMax: true, hasClaudePro: false })] };
  await syncAccountsFromDisk(disk1, config, am);
  const a = am.accounts[0];
  assert.equal(a.credential, 't-ai01@2117academy.com');
  assert.equal(a.placeholder, false);
  assert.equal(a.pendingPlan, false);
  assert.equal(a.disabled, false);
  assert.equal('placeholder' in config.accounts[0], false);
});

function makeTUI() {
  const accounts = [
    { name: 'a@gmail.com', id: 'id-a', index: 0, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.5, unified5hReset: Date.now() + HOUR, unified7d: 0.2, unified7dReset: Date.now() + 50 * HOUR } },
    { name: 'ai01@2117academy.com', id: 'id-ai01', index: 1, type: 'oauth', status: 'active', credential: undefined, placeholder: true, pendingPlan: true, disabled: true, quota: {} },
  ];
  const am = { accounts, currentIndex: 0, switchThreshold: 0.98, getRoutes() { return []; }, refreshExpiredQuotas() {}, sessionStats() { return { active: 0, known: 0 }; }, thresholdFor() { return 0.98; }, sessionList() { return []; } };
  const config = { proxy: { port: 1 }, accounts: accounts.map(a => ({ name: a.name, id: a.id, type: a.type })), routes: [], blockedModels: [], koLayout: true, hostLine: false };
  const calls = [];
  const tui = new TUI({
    accountManager: am, config, loginAccount: async () => ({}), saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    addPlaceholders: async spec => { calls.push(spec); return { added: ['ai02@2117academy.com', 'ai03@2117academy.com'], skipped: ['ai01@2117academy.com'] }; },
  });
  tui.render = () => {};
  return { tui, calls };
}

function renderToString(tui) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  try { tui.running = true; tui._render(true); } finally { process.stdout.write = orig; tui.running = false; }
  return stripAnsi(chunks.join(''));
}

test('TUI: 빈 줄은 「결제 전 · 결제 뒤 L」, 요약은 결제 전 1', () => {
  const { tui } = makeTUI();
  const out = renderToString(tui);
  assert.match(out, /^\s+ai01\s.*결제 전 · 결제 뒤 L\s*$/m);
  assert.match(out, /결제 전 1/);
});

test('TUI A(ㅁ): 이메일(범위)을 받아 addPlaceholders 를 부르고 결과를 알린다', async () => {
  const { tui, calls } = makeTUI();
  tui._key('ㅁ');
  assert.equal(tui.mode, 'input');
  assert.match(tui.inputPrompt, /미리 넣을 이메일/);
  tui._onKeys('ai01-03@2117academy.com');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['ai01-03@2117academy.com']);
  assert.equal(tui.mode, 'normal');
  const msgs = tui.log.map(l => stripAnsi(l.msg));
  assert.ok(msgs.some(m => /결제 전 계정 2개를 이름만 넣었습니다: ai02, ai03/.test(m)), JSON.stringify(msgs));
  assert.ok(msgs.some(m => /이미 있어서 건너뜀 1개: ai01/.test(m)), JSON.stringify(msgs));
  assert.match(stripAnsi(tui._renderFooterKo().join('\n')), /A 미리넣기/);
});

test('TUI A: 잘못된 입력은 실패 한 줄, Esc 는 아무 일 없음', async () => {
  const { tui } = makeTUI();
  tui.addPlaceholders = async () => { throw new ConfigOpError('"hello" 은 이메일이 아닙니다'); };
  tui._key('a');
  tui._onKeys('hello');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.match(stripAnsi(tui.log[0].msg), /이름만 넣기 실패: "hello" 은 이메일이 아닙니다/);
  const n = tui.log.length;
  tui._key('a');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.log.length, n);
});

test('TUI L: 빈 줄을 고르면 결제 전이면 막힌다고 먼저 알린다', async () => {
  const { tui } = makeTUI();
  tui.loginAccount = async () => ({ name: 'ai01@2117academy.com', action: 'updated', pendingPlan: false });
  await tui._doLogin(1);
  const msgs = tui.log.map(l => stripAnsi(l.msg));
  assert.ok(msgs.some(m => /「ai01」은 이름만 넣은 줄 — 결제\(Pro\/Max\)가 안 됐으면 로그인 페이지가 막습니다/.test(m)), JSON.stringify(msgs));
});

test('AccountManager: 빈 줄은 disabled 를 풀어도 unavailableReason 이 disabled 다 (D 로 켜도 요청이 안 간다)', () => {
  const am = new AccountManager([
    { name: 'ai01@2117academy.com', id: 'id-ai01', type: 'oauth', placeholder: true, pendingPlan: true, disabled: true },
    oauth('b'),
  ], 0.98);
  am.setDisabled(0, false);
  assert.equal(am.accounts[0].disabled, false);
  assert.equal(am.unavailableReason(am.accounts[0]), 'disabled');
  assert.equal(am.unavailableReason(am.accounts[1]), null);
});

test('TUI D: 빈 줄은 켜지지 않고 안내만, 상태는 pendingPlan 이 없어도 「결제 전」', async () => {
  const { tui } = makeTUI();
  tui.am.accounts[1].pendingPlan = false;
  let toggled = 0;
  tui.am.setDisabled = () => { toggled++; };
  await tui._doToggleDisabled(1);
  assert.equal(toggled, 0);
  assert.equal(tui.am.accounts[1].disabled, true);
  assert.match(stripAnsi(tui.log[0].msg), /「ai01」은 이름만 넣은 줄 — 결제됐으면 L 로 로그인하면 켜집니다/);
  assert.equal(tui._koState(tui.am.accounts[1]), 'pending');
});
