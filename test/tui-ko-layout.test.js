// 한글 화면(koLayout) — 원장 2026-10-27 시안.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, extraUsageKo } from '../src/tui.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const H = 3600e3;

function makeTUI(sessions = []) {
  const now = Date.now();
  const accounts = [
    { name: 'a@gmail.com', index: 0, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.5, unified5hReset: now + H, unified7d: 0.2, unified7dReset: now + 50 * H } },
    { name: 'b@gmail.com', index: 1, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.1, unified5hReset: now + H, unified7d: 0.99, unified7dReset: now + 5 * H } },
    { name: 'c@gmail.com', index: 2, type: 'oauth', status: 'error', credential: 't', quota: {} },
  ];
  const am = {
    accounts, currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; }, refreshExpiredQuotas() {}, sessionStats() { return { active: sessions.length, known: sessions.length }; },
    thresholdFor() { return 0.98; }, sessionList() { return sessions; },
  };
  const config = { proxy: { port: 1 }, accounts: accounts.map(a => ({ name: a.name, type: a.type })), routes: [], blockedModels: [], koLayout: true, hostLine: false };
  const tui = new TUI({ accountManager: am, config, loginAccount: async () => ({}), saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  return tui;
}

function renderRaw(tui) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  try { tui.running = true; tui._render(true); } finally { process.stdout.write = orig; tui.running = false; }
  return chunks.join('');
}
const renderToString = tui => stripAnsi(renderRaw(tui));

test('koLayout: 막대 이름은 머리글 한 줄, 줄마다 Ses/Wk 없음, 정상 계정엔 active 없음', () => {
  const out = renderToString(makeTUI());
  assert.match(out, /5시간\s+자동\s+일주일\s+구독/);
  assert.doesNotMatch(out, /\bSes\b|\bWk\b|\bactive\b/);
  assert.match(out, /계정 3 · 사용 가능 1 · 쉬는 중 1 · 오류 1/);
  assert.match(out, /c\s+⚠ 다시 로그인 필요/);
  assert.match(out, /새로고침/);
});

test('koLayout: 「자동」 머리글은 자동 켜기 설정 색(녹색 켬 · 빨강 끔)', () => {
  const tui = makeTUI();
  tui.config.warmupSeconds = 600;
  assert.match(renderRaw(tui), /\x1b\[32m자동/);
  tui.config.warmupSeconds = 0;
  assert.match(renderRaw(tui), /\x1b\[31m자동/);
  tui.config.warmupSchedule = { mode: 'rolling', resetTime: '15:30', timezone: 'Asia/Seoul' };
  assert.match(renderRaw(tui), /\x1b\[32m자동/);
});

test('koLayout: 「자동」 점은 5시간 막대 오른쪽 — 녹색 창 돎 · 빨강 안 돎 · 회색 주간 다 씀', () => {
  const tui = makeTUI();
  tui.am.accounts.push({ name: 'd@gmail.com', index: 3, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.2, unified5hReset: Date.now() - H, unified7d: 0.1 } });
  tui.config.accounts.push({ name: 'd@gmail.com', type: 'oauth' });
  assert.match(tui._autoDot(0), /^\x1b\[32m●/, 'a: 5시간 창이 돈다');
  assert.match(tui._autoDot(1), /^\x1b\[90m●/, 'b: 주간 99%');
  assert.match(tui._autoDot(3), /^\x1b\[31m●/, 'd: 창이 끝났다');
  const out = renderToString(tui);
  assert.match(out, /^\s+a\s+50%[^\n]*?●\s+20%/m);
  assert.match(out, /^\s+d\s+20%\s+●\s+10%/m);
});

test('koLayout: 꺼 둔 계정도 막대·구독은 그대로, 진한 회색 + 「꺼 둠」 (원장 2026-10-28)', () => {
  const tui = makeTUI();
  const now = Date.now();
  tui.am.accounts.push({ name: 'e@gmail.com', index: 3, type: 'oauth', status: 'active', credential: 't', disabled: true, renewDate: '2026-11-05', quota: { unified5h: 0.4, unified5hReset: now + H, unified7d: 0.1, unified7dReset: now + 50 * H } });
  tui.config.accounts.push({ name: 'e@gmail.com', type: 'oauth' });
  const raw = renderRaw(tui);
  const out = stripAnsi(raw);
  assert.match(out, /^\s+e\s+40%[^\n]*?●\s+10%[^\n]*꺼 둠/m);
  assert.doesNotMatch(out, /D 로 켜기/);
  assert.match(out, /꺼 둠 1/);
  assert.match(raw, /\x1b\[38;5;242m\s*40%/, '막대가 진한 회색');
});

test('koLayout: 다시 로그인이 필요한 계정은 언제부터인지 같이 보인다', () => {
  const tui = makeTUI();
  const since = new Date(Date.now() - 2 * 24 * H);
  since.setHours(21, 42, 0, 0);
  tui.am.accounts[2].errorReason = { code: 'refresh_rejected', since: since.getTime() };
  const out = renderToString(tui);
  assert.match(out, new RegExp(`c\\s+⚠ 다시 로그인 필요 \\(L\\) · ${since.getMonth() + 1}/${since.getDate()} 21:42부터`));
});

test('koLayout: H 숨김이면 주간 다 쓴 계정 줄이 빠지고 개수가 나온다', () => {
  const tui = makeTUI();
  tui.config.hideSpent = true;
  const out = renderToString(tui);
  assert.doesNotMatch(out, /^\s+b\s/m);
  assert.match(out, /주간 다 쓴 계정 1개 숨김/);
});

test('koLayout: 세션은 처음 보인 순서로 고정된다', () => {
  const now = Date.now();
  const s1 = { id: '11111111-1111-4111-8111-111111111111', title: '첫째', account: 0, accountName: 'a@gmail.com', lastSeen: now - 5000, active: true, model: 'claude-opus-5-5' };
  const s2 = { id: '22222222-2222-4222-8222-222222222222', title: '둘째', account: 0, accountName: 'a@gmail.com', lastSeen: now - 1000, active: true, model: 'claude-opus-5-5' };
  const sessions = [s1, s2];
  const tui = makeTUI(sessions);
  let out = renderToString(tui);
  assert.ok(out.indexOf('첫째') < out.indexOf('둘째'));
  sessions.reverse(); // 최근 순이 바뀌어도
  out = renderToString(tui);
  assert.ok(out.indexOf('첫째') < out.indexOf('둘째'));
});

test('koLayout: 끝난 요청은 알림에 쌓이지 않고 세션 줄의 최근 요청으로 간다', () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.onRequestStart('r1', { sessionId: '11111111-1111-4111-8111-111111111111', method: 'POST', path: '/v1/messages' });
  tui.onRequestEnd('r1', { status: 200, account: 'a@gmail.com', method: 'POST', path: '/v1/messages' });
  assert.equal(tui.log.length, 0);
  assert.equal(tui._sessLast.get('11111111-1111-4111-8111-111111111111').ok, true);
  tui.onRequestStart('r2', { sessionId: '11111111-1111-4111-8111-111111111111', method: 'POST', path: '/v1/messages' });
  tui.onRequestEnd('r2', { status: 429, account: 'a@gmail.com', method: 'POST', path: '/v1/messages' });
  assert.equal(tui.log.length, 1);
  assert.match(stripAnsi(tui.log[0].msg), /✗ 429/);
});

test('B: 다 쓴 계정에 커서, Enter 한 번은 확인만, 두 번째에 뺀다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  const removed = [];
  tui.am.removeAccount = i => { removed.push(tui.am.accounts[i].name); tui.am.accounts.splice(i, 1); };
  tui._key('B');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.am.accounts[tui.selIdx].name, 'b@gmail.com');
  tui._key('enter');
  assert.deepEqual(removed, []);
  assert.match(stripAnsi(tui._renderFooter()), /정말 뺄까요/);
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(removed, ['b@gmail.com']);
  assert.equal(tui.mode, 'normal');
});

test('B: 확인 뒤 커서를 옮기면 확인이 풀린다', () => {
  const tui = makeTUI();
  tui.render = () => {};
  const removed = [];
  tui.am.removeAccount = i => { removed.push(i); };
  tui._key('ㅠ');
  tui._key('enter');
  tui._key('up');
  tui._key('enter');
  assert.deepEqual(removed, []);
});

test('koLayout: 결제 전 계정은 진한 회색 줄 + 주황 「결제 전」, 요약에 개수 (원장 2026-10-28)', () => {
  const tui = makeTUI();
  tui.am.accounts.push({ name: 'ai01@2117academy.com', index: 3, type: 'oauth', status: 'active', credential: 't', disabled: true, pendingPlan: true, quota: {} });
  tui.config.accounts.push({ name: 'ai01@2117academy.com', type: 'oauth' });
  const raw = renderRaw(tui);
  const out = stripAnsi(raw);
  assert.match(out, /^\s+ai01\s.*결제 전\s*$/m);
  assert.doesNotMatch(out, /ai01.*꺼 둠/);
  assert.match(out, /결제 전 1/);
  assert.doesNotMatch(out, /꺼 둠 1/);
  assert.match(raw, /\x1b\[38;5;208m결제 전/, '주황');
  assert.match(raw, /\x1b\[38;5;242mai01/, '이름은 진한 회색');
});

test('D: 결제 전 계정을 손으로 켜면 표시를 지우고 알린다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.am.accounts.push({ name: 'ai01@2117academy.com', id: 'id-ai01', index: 3, type: 'oauth', status: 'active', credential: 't', disabled: true, pendingPlan: true, quota: {} });
  tui.config.accounts.push({ name: 'ai01@2117academy.com', id: 'id-ai01', type: 'oauth' });
  tui.am.setDisabled = (i, v) => { tui.am.accounts[i].disabled = v; };
  await tui._doToggleDisabled(3);
  assert.equal(tui.am.accounts[3].disabled, false);
  assert.equal(tui.am.accounts[3].pendingPlan, false);
  assert.equal(tui.config.accounts[3].pendingPlan, false);
  assert.equal(tui.config.accounts[3].disabled, false);
  assert.match(stripAnsi(tui.log[0].msg), /결제 전 표시를 지우고 켰습니다/);
});

test('L: 로그인 결과가 결제 전이면 알림에 그렇게 나온다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.loginAccount = async () => ({ name: 'c@gmail.com', action: 'updated', pendingPlan: true });
  await tui._doLogin(2);
  const msgs = tui.log.map(l => stripAnsi(l.msg));
  assert.ok(msgs.some(m => /「c@gmail.com」 결제 전\(Pro\/Max 아님\)/.test(m)), JSON.stringify(msgs));
});

test('O(ㅐ): 계정 순서 바꾸기 — ← 위로 · → 아래로, Enter 로 끝내면 저장', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  tui._key('ㅐ');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'reorder');
  assert.equal(tui.am.accounts[tui.selIdx].name, 'a@gmail.com');
  assert.match(stripAnsi(tui._renderFooter()), /← 위로\s+→ 아래로/);
  tui._key('right'); // a 를 한 칸 아래로
  const names = () => tui._displayOrder().map(i => tui.am.accounts[i].name);
  assert.deepEqual(names(), ['b@gmail.com', 'a@gmail.com', 'c@gmail.com']);
  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  await tui._flushOrderSave();
  await new Promise(r => setImmediate(r));
  assert.equal(saved, 1);
  assert.deepEqual(names(), ['b@gmail.com', 'a@gmail.com', 'c@gmail.com']);
  assert.match(stripAnsi(tui._renderFooterKo().join('\n')), /O 순서/);
});

test('N(ㅜ): 새 계정 로그인 — 줄을 고르지 않고 바로 시작, 결과를 알림에 (원장 2026-10-28)', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  const calls = [];
  tui.loginAccount = async (acct, opts) => { calls.push(acct); return { name: 'ai01@2117academy.com', action: 'added', pendingPlan: true }; };
  tui._key('ㅜ');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [null], '고른 계정 없이 부른다');
  const msgs = tui.log.map(l => stripAnsi(l.msg));
  assert.ok(msgs.some(m => m === '「ai01@2117academy.com」 계정을 넣었습니다'), JSON.stringify(msgs));
  assert.ok(msgs.some(m => /「ai01@2117academy.com」 결제 전/.test(m)), JSON.stringify(msgs));
  assert.equal(tui.mode, 'normal');
  assert.equal(tui._loggingIn, null);
});

test('N: 이미 있는 계정으로 로그인하면 그렇게 알리고, 실패·취소도 한 줄', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.loginAccount = async () => ({ name: 'a@gmail.com', action: 'updated', pendingPlan: false });
  await tui._doLoginNew();
  assert.match(stripAnsi(tui.log[0].msg), /「a@gmail.com」은 이미 있는 계정/);
  tui.loginAccount = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };
  await tui._doLoginNew();
  assert.match(stripAnsi(tui.log[0].msg), /새 계정 로그인을 취소/);
  tui.loginAccount = async () => { throw new Error('boom'); };
  await tui._doLoginNew();
  assert.match(stripAnsi(tui.log[0].msg), /새 계정 로그인 실패: boom/);
});

test('한글 안내는 세 줄이고 줄마다 80칸 안이다', () => {
  const tui = makeTUI();
  tui.warmNow = () => null;
  tui.addPlaceholders = async () => ({ added: [], skipped: [] });
  tui._cleanupAvailable = () => true;
  const lines = tui._renderFooterKo().map(stripAnsi);
  assert.equal(lines.length, 3);
  const vw = s => [...s].reduce((n, c) => n + (/[ᄀ-ᇿ㄰-㆏가-힯＀-￯]/.test(c) ? 2 : 1), 0);
  for (const l of lines) assert.ok(vw(l) <= 80, `${vw(l)}: ${l}`);
  // [원장 2026-11-04] U 5시간먼저가 셋째 줄에 들어가며 X 정리는 첫째 줄 끝으로, H 는 「다쓴 숨김/표시」로.
  assert.match(lines[0], /S 계정전환.*W 5시간켜기.*R 새로고침\s+X 정리$/);
  assert.match(lines[1], /L 다시로그인\s+N 새계정\s+A 미리넣기\s+D 끄기\/켜기\s+O 순서\s+B 계정빼기\s+E 추가사용/);
  assert.match(lines[2], /K 하위분산 켜기\s+T 소진우선 켜기\s+U 5시간먼저 켜기\s+H 다쓴 숨김\s+G 설정\s+Q 종료/);
  // 소진우선·5시간먼저가 켜져 있고 다쓴 계정을 숨겨도(라벨 「끄기」·「표시」) 80칸 안.
  tui.config.distributeSessions = 'adaptive';
  tui.config.fiveHourFirst = true;
  tui.config.hideSpent = true;
  tui.config.sessionAffinity = false;
  const on = tui._renderFooterKo().map(stripAnsi);
  for (const l of on) assert.ok(vw(l) <= 80, `${vw(l)}: ${l}`);
  assert.match(on[2], /U 5시간먼저 끄기\s+H 다쓴 표시/);
});

test('K(ㅏ): 하위 세션 분산 켜기/끄기 = sessionAffinity 반전, 서버 즉시 적용 + 저장 (원장 2026-10-30)', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  const applied = [];
  tui.am.setSessionAffinity = v => { applied.push(v); };
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /K 하위분산 켜기/);
  tui._key('ㅏ');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.sessionAffinity, false);
  assert.deepEqual(applied, [false]);
  assert.equal(saved, 1);
  assert.match(stripAnsi(tui.log[0].msg), /하위 세션 분산 켬/);
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /K 하위분산 끄기/);
  tui._key('k');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.sessionAffinity, true);
  assert.deepEqual(applied, [false, true]);
  assert.match(stripAnsi(tui.log[0].msg), /하위 세션 분산 끔/);
});

// [원장 2026-11-02] T(ㅅ) 소진우선 = distributeSessions 'adaptive' ↔ true(균등). 하위분산(K)과는 다른 기능.
const DRAIN_ON = '새 대화 배정: 소진우선 켬 — 남은 주간 사용량이 가장 적은 계정부터 끝까지 다 쓰고 다음 계정으로 갑니다';
const DRAIN_OFF = '새 대화 배정: 소진우선 끔 — 새 대화는 부하가 적은 계정으로 골고루 갑니다(균등)';

test('T: 바닥글 라벨은 상태대로 — 균등이면 「T 소진우선 켜기」, 소진우선이면 「끄기」(한글·영문 안내 모두)', () => {
  const tui = makeTUI();
  tui.config.distributeSessions = true;
  // [원장 2026-11-04] T 와 H 사이에 U 5시간먼저가 들어갔다.
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /K 하위분산 켜기\s+T 소진우선 켜기\s+U 5시간먼저 켜기\s+H /);
  assert.match(stripAnsi(tui._renderFooter()), /K 하위분산 켜기\s+T 소진우선 켜기\s+U 5시간먼저 켜기\s+H /);
  tui.config.distributeSessions = 'adaptive';
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /T 소진우선 끄기/);
  assert.match(stripAnsi(tui._renderFooter()), /T 소진우선 끄기/);
  // 매니저 값이 있으면 그것이 먼저(attach 모드는 서버 상태).
  tui.am.distributionMode = 'even';
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /T 소진우선 켜기/);
});

test('koLayout: 요약 줄에 배정 모드가 늘 보인다 — 균등 · 소진우선(주황) · 끔(흐리게)', () => {
  const tui = makeTUI();
  tui.config.distributeSessions = true;
  assert.match(renderToString(tui), /계정 3 · 사용 가능 1 · 쉬는 중 1 · 오류 1 · 배정 균등/);
  tui.config.distributeSessions = 'adaptive';
  const raw = renderRaw(tui);
  assert.match(stripAnsi(raw), /· 배정 소진우선/);
  assert.match(raw, /\x1b\[38;5;208m배정 소진우선/, '주황');
  tui.config.distributeSessions = false;
  const off = renderRaw(tui);
  assert.match(stripAnsi(off), /· 배정 끔/);
  assert.match(off, /\x1b\[2m배정 끔/, '흐리게');
  delete tui.config.distributeSessions;
  assert.match(renderToString(tui), /· 배정 끔/, '설정에 없으면 끔');
  tui.am.distributionMode = 'adaptive';
  assert.match(renderToString(tui), /· 배정 소진우선/, '매니저 값이 먼저');
});

test('T(ㅅ): 소진우선 켜기/끄기 = distributeSessions true → adaptive → true, 서버 즉시 적용 + 저장 + 알림', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.config.distributeSessions = true;
  const applied = [];
  tui.am.setDistributeSessions = v => { applied.push(v); };
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  tui._key('ㅅ');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.distributeSessions, 'adaptive');
  assert.deepEqual(applied, ['adaptive']);
  assert.equal(saved, 1);
  assert.equal(stripAnsi(tui.log[0].msg), DRAIN_ON);
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /T 소진우선 끄기/);
  tui._key('t');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.distributeSessions, true);
  assert.deepEqual(applied, ['adaptive', true]);
  assert.equal(saved, 2);
  assert.equal(stripAnsi(tui.log[0].msg), DRAIN_OFF);
  // 끔(false)에서 누르면 소진우선, 대문자 T 도 같다.
  tui.config.distributeSessions = false;
  tui._key('T');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.distributeSessions, 'adaptive');
  assert.equal(tui.config.sessionAffinity, undefined, '하위분산(K)은 건드리지 않는다');
});

test('T: 저장이 실패하면 설정·서버 둘 다 되돌리고 실패를 알린다 · setDistributeSessions 없는 매니저도 괜찮다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.config.distributeSessions = true;
  const applied = [];
  tui.am.setDistributeSessions = v => { applied.push(v); };
  tui.saveConfig = async () => { throw new Error('disk full'); };
  await tui._toggleDrainFirst();
  assert.equal(tui.config.distributeSessions, true);
  assert.deepEqual(applied, ['adaptive', true]);
  assert.equal(stripAnsi(tui.log[0].msg), '새 대화 배정 저장 실패: disk full');
  delete tui.am.setDistributeSessions;
  tui.saveConfig = async () => {};
  await tui._toggleDrainFirst();
  assert.equal(tui.config.distributeSessions, 'adaptive');
  assert.equal(stripAnsi(tui.log[0].msg), DRAIN_ON);
});

// [원장 2026-11-04] U(ㅕ) 5시간 계정 먼저 = 설정 fiveHourFirst. makeTUI 의 a·b 는 5시간 사용률·리셋이 있어 5시간 계정.
const FH_ON = '5시간 계정 먼저 켬 — 5시간 제한이 있는 계정(a, b)부터 쓰고, 다 차면 나머지 계정으로 갑니다. 이미 앉은 대화는 옮기지 않습니다';
const FH_OFF = '5시간 계정 먼저 끔 — 원래 규칙(주간 구간 → 대화 수)으로 돌아갑니다';

test('U: 바닥글 라벨은 상태대로 — 꺼져 있으면 「U 5시간먼저 켜기」, 켜져 있으면 「끄기」(한글·영문 안내 모두)', () => {
  const tui = makeTUI();
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /U 5시간먼저 켜기/);
  assert.match(stripAnsi(tui._renderFooter()), /U 5시간먼저 켜기/);
  tui.config.fiveHourFirst = true;
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /U 5시간먼저 끄기/);
  assert.match(stripAnsi(tui._renderFooter()), /U 5시간먼저 끄기/);
  // 매니저 값이 있으면 그것이 먼저(attach 모드는 서버 상태).
  tui.am.fiveHourFirst = false;
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /U 5시간먼저 켜기/);
});

test('koLayout: 요약 줄에 5시간먼저가 늘 보인다 — 끔(흐리게) · 켬(N)(녹색, N = 5시간 계정 수)', () => {
  const tui = makeTUI();
  const off = renderRaw(tui);
  assert.match(stripAnsi(off), /· 배정 \S+ · 5시간먼저 끔/);
  assert.match(off, /\x1b\[2m5시간먼저 끔/, '흐리게');
  tui.config.fiveHourFirst = true;
  const on = renderRaw(tui);
  assert.match(stripAnsi(on), /· 5시간먼저 켬\(2\)/);
  assert.match(on, /\x1b\[32m5시간먼저 켬\(2\)/, '녹색');
  // 조회가 5시간 제한이 없다고 말한 계정은 빠지고, 수동 지정(fiveHour)이 먼저다.
  tui.am.accounts[1].quota.sessionWindowStated = false;
  assert.match(renderToString(tui), /· 5시간먼저 켬\(1\)/);
  tui.am.accounts[2].fiveHour = true;
  assert.match(renderToString(tui), /· 5시간먼저 켬\(2\)/);
  tui.am.fiveHourFirst = false;
  assert.match(renderToString(tui), /· 5시간먼저 끔/, '매니저 값이 먼저');
});

test('U(ㅕ): 5시간먼저 켜기/끄기 = fiveHourFirst 반전, 서버 즉시 적용 + 저장 + 알림 (ㅕ·u·U 모두)', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  const applied = [];
  tui.am.setFiveHourFirst = v => { applied.push(v); };
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  tui._key('ㅕ');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.fiveHourFirst, true);
  assert.deepEqual(applied, [true]);
  assert.equal(saved, 1);
  assert.equal(stripAnsi(tui.log[0].msg), FH_ON);
  assert.match(stripAnsi(tui._renderFooterKo()[2]), /U 5시간먼저 끄기/);
  tui._key('u');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.fiveHourFirst, false);
  assert.deepEqual(applied, [true, false]);
  assert.equal(saved, 2);
  assert.equal(stripAnsi(tui.log[0].msg), FH_OFF);
  tui._key('U');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.config.fiveHourFirst, true);
  assert.equal(tui.config.distributeSessions, undefined, '배정 모드(T)는 건드리지 않는다');
});

test('U: 저장이 실패하면 설정·서버 둘 다 되돌리고 실패를 알린다 · setFiveHourFirst 없는 매니저도 괜찮다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  const applied = [];
  tui.am.setFiveHourFirst = v => { applied.push(v); };
  tui.saveConfig = async () => { throw new Error('disk full'); };
  await tui._toggleFiveHourFirst();
  assert.equal('fiveHourFirst' in tui.config, false, '없던 키는 다시 없음');
  assert.deepEqual(applied, [true, false]);
  assert.equal(stripAnsi(tui.log[0].msg), '5시간 계정 먼저 저장 실패: disk full');
  delete tui.am.setFiveHourFirst;
  tui.saveConfig = async () => {};
  await tui._toggleFiveHourFirst();
  assert.equal(tui.config.fiveHourFirst, true);
  assert.equal(stripAnsi(tui.log[0].msg), FH_ON);
});

test('koLayout: 조회가 5시간 제한이 없다고 한 계정의 5시간 칸은 흐린 「없음」(모름 회색 칸과 구분)', () => {
  const tui = makeTUI();
  const now = Date.now();
  tui.am.accounts.push({ name: 'n@gmail.com', index: 3, type: 'oauth', status: 'active', credential: 't', quota: { sessionWindowStated: false, unified7d: 0.3, unified7dReset: now + 50 * H } });
  tui.config.accounts.push({ name: 'n@gmail.com', type: 'oauth' });
  tui.am.accounts.push({ name: 'u@gmail.com', index: 4, type: 'oauth', status: 'active', credential: 't', quota: { unified7d: 0.3, unified7dReset: now + 50 * H } });
  tui.config.accounts.push({ name: 'u@gmail.com', type: 'oauth' });
  const raw = renderRaw(tui);
  const out = stripAnsi(raw);
  assert.match(out, /^\s+n\s+없음\s+●\s+30%/m);
  assert.match(raw, /\x1b\[2m\s+없음/, '흐리게');
  assert.doesNotMatch(out, /^\s+u\s+없음/m, '모름(기록 없음)은 「없음」이 아니다');
  // 칸 폭은 그대로 — 일주일 막대가 다른 줄과 같은 화면 열에서 시작(한글은 2칸).
  const vw = s => [...s].reduce((n, c) => n + (/[ᄀ-ᇿ㄰-㆏가-힯＀-￯]/.test(c) ? 2 : 1), 0);
  const col = name => { const l = out.split('\n').find(x => new RegExp(`^\\s+${name}\\s`).test(x)); return vw(l.slice(0, l.indexOf('30%'))); };
  assert.equal(col('n'), col('u'));
});

// [원장 2026-10-30] 추가 사용(번들): 실측 PC2 — 월 지출 한도 $40(limitMinor 4000), 2117math 는 $42.28 로 막힘.
const SPEND_OK = { enabled: true, usedMinor: 0, limitMinor: 4000, currency: 'USD', exponent: 2 };
const SPEND_BLOCKED = { enabled: false, usedMinor: 4228, limitMinor: 4000, currency: 'USD', exponent: 2, disabledReason: 'org_level_disabled_until' };

test('E(ㄷ): 추가 사용(번들) 켜기/끄기 — 계정 고르고 Enter, 매니저·설정 줄·저장·알림 (원장 2026-10-30)', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.am.accounts[0].id = 'id-a';
  tui.config.accounts[0].id = 'id-a';
  tui.am.accounts[0].quota.spend = { ...SPEND_OK };
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  tui._key('ㄷ');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'extra');
  assert.equal(tui.am.accounts[tui.selIdx].name, 'a@gmail.com');
  assert.match(stripAnsi(tui._renderFooter()), /추가 사용을 켜고 끌 계정/);
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.am.accounts[0].allowExtraUsage, true);
  assert.equal(tui.config.accounts[0].allowExtraUsage, true);
  assert.equal(saved, 1);
  assert.match(stripAnsi(tui.log[0].msg), /「a@gmail\.com」 추가 사용\(번들\) 켬 — 모든 계정이 다 찼을 때만 여기로 갑니다 · 남음 \$40$/);
  tui._key('e');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.am.accounts[0].allowExtraUsage, false);
  assert.equal(tui.config.accounts[0].allowExtraUsage, false, '명시적 false — 디스크의 true 를 덮어쓰도록');
  assert.equal(saved, 2);
  assert.match(stripAnsi(tui.log[0].msg), /「a@gmail\.com」 추가 사용\(번들\) 끔$/);
});

test('E: Anthropic 쪽에서 막힌 계정을 켜면 알림에 같이 나오고, 저장이 실패하면 되돌린다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  tui.am.accounts[1].id = 'id-b';
  tui.config.accounts[1].id = 'id-b';
  tui.am.accounts[1].quota.spend = { ...SPEND_BLOCKED };
  await tui._doToggleExtraUsage(1);
  assert.match(stripAnsi(tui.log[0].msg), /켬 .* · 남음 \$0 · Anthropic 쪽에서 막혀 있음\(한도 도달\)/);
  tui.saveConfig = async () => { throw new Error('disk full'); };
  await tui._doToggleExtraUsage(1);
  assert.equal(tui.am.accounts[1].allowExtraUsage, true, '끄기 실패 → 켠 채로');
  assert.equal(tui.config.accounts[1].allowExtraUsage, true);
  assert.match(stripAnsi(tui.log[0].msg), /추가 사용 저장 실패: disk full/);
});

test('E: 이름만 넣은 줄(placeholder)·토큰 없는 줄은 켜지 않고 알린다', async () => {
  const tui = makeTUI();
  tui.render = () => {};
  let saved = 0;
  tui.saveConfig = async () => { saved++; };
  tui.am.accounts.push({ name: 'ai01@2117academy.com', id: 'id-ai01', index: 3, type: 'oauth', status: 'active', disabled: true, pendingPlan: true, placeholder: true, quota: {} });
  tui.config.accounts.push({ name: 'ai01@2117academy.com', id: 'id-ai01', type: 'oauth', placeholder: true });
  tui._key('e');
  tui.selIdx = 3;
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.am.accounts[3].allowExtraUsage, undefined);
  assert.equal(tui.config.accounts[3].allowExtraUsage, undefined);
  assert.equal(saved, 0);
  assert.match(stripAnsi(tui.log[0].msg), /「ai01@2117academy\.com」은 추가 사용을 켤 수 없는 줄/);
  tui.am.accounts.push({ name: 'k@x.com', id: 'id-k', index: 4, type: 'apikey', status: 'active', credential: 'sk', quota: {} });
  tui.config.accounts.push({ name: 'k@x.com', id: 'id-k', type: 'apikey' });
  await tui._doToggleExtraUsage(4);
  assert.equal(tui.am.accounts[4].allowExtraUsage, undefined);
  assert.equal(saved, 0);
});

test('koLayout: 구독 오른쪽 「번들」 칸 — 켬 남음 $40, 요약에 추가사용 개수', () => {
  const tui = makeTUI();
  tui.am.accounts[0].allowExtraUsage = true;
  tui.am.accounts[0].quota.spend = { ...SPEND_OK };
  const raw = renderRaw(tui);
  const out = stripAnsi(raw);
  assert.match(out, /5시간\s+자동\s+일주일\s+구독\s+번들/);
  assert.match(out, /^\s+a\s+50%.*켬 남음 \$40\s*$/m);
  assert.match(raw, /\x1b\[32m켬 남음 \$40/, '녹색');
  assert.match(out, /· 추가사용 1/);
  assert.doesNotMatch(out, /추가사용 중/);
  // 아무 계정도 금액·허용이 없으면 칸도 머리글도 없다.
  const plain = renderToString(makeTUI());
  assert.doesNotMatch(plain, /번들|· 추가사용/);
});

test('extraUsageKo: 사용 중 · 막힘(쓴 돈/한도) · 켬 · 끔 · 모름', () => {
  const s = x => stripAnsi(x);
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, quota: { spend: SPEND_OK } }, true)), '사용 중 남음 $40');
  assert.match(extraUsageKo({ allowExtraUsage: true, quota: { spend: SPEND_OK } }, true), /^\x1b\[38;5;208m/, '주황');
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, quota: { spend: SPEND_BLOCKED } }, false)), '막힘 $42.28/40');
  assert.match(extraUsageKo({ allowExtraUsage: true, quota: { spend: SPEND_BLOCKED } }, false), /^\x1b\[31m/, '빨강');
  assert.equal(s(extraUsageKo({ allowExtraUsage: false, quota: { spend: SPEND_OK } }, false)), '끔 남음 $40');
  assert.equal(s(extraUsageKo({ allowExtraUsage: false, quota: { spend: SPEND_BLOCKED } }, false)), '끔 남음 $0');
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, quota: { spend: { ...SPEND_OK, limitMinor: 100000, usedMinor: 4228 } } }, false)), '켬 남음 $957.72');
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, quota: { spend: { ...SPEND_OK, limitMinor: null, usedMinor: 4228 } } }, false)), '켬 씀 $42.28');
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, maxSpend: 20, quota: { spend: SPEND_OK } }, false)), '켬 남음 $20', 'maxSpend 가 한도');
  assert.equal(s(extraUsageKo({ allowExtraUsage: true, quota: {} }, false)), '켬');
  assert.equal(extraUsageKo({ allowExtraUsage: false, quota: {} }, false), '');
  assert.equal(extraUsageKo({ quota: { spend: null } }, false), '');
});
