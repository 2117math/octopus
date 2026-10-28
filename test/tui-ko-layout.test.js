// 한글 화면(koLayout) — 원장 2026-10-27 시안.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

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
  assert.match(lines[0], /S 계정전환.*W 5시간켜기.*R 새로고침/);
  assert.match(lines[1], /L 다시로그인\s+N 새계정\s+A 미리넣기\s+D 끄기\/켜기\s+O 순서\s+B 계정빼기/);
  assert.match(lines[2], /H 다쓴계정 숨기기\s+X 정리\s+G 설정\s+Q 종료/);
});
