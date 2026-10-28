// W: 5시간 켜기 — 원장 2026-10-27.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const H = 3600e3;

function makeTUI({ result = 'ok' } = {}) {
  const now = Date.now();
  const accounts = [
    { name: 'busy@gmail.com', index: 0, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.5, unified5hReset: now + H, unified7d: 0.2, unified7dReset: now + 50 * H } },
    { name: 'idle@gmail.com', index: 1, type: 'oauth', status: 'active', credential: 't', quota: { unified5h: 0.3, unified5hReset: now - H, unified7d: 0.4, unified7dReset: now + 50 * H } },
    { name: 'spent@gmail.com', index: 2, type: 'oauth', status: 'active', credential: 't', quota: { unified7d: 0.99, unified7dReset: now + 5 * H } },
    { name: 'fresh@2117academy.com', index: 3, type: 'oauth', status: 'active', credential: 't', quota: {} },
  ];
  const am = {
    accounts, currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; }, refreshExpiredQuotas() {}, sessionStats() { return { active: 0, known: 0 }; },
    thresholdFor() { return 0.98; }, sessionList() { return []; },
  };
  const config = { proxy: { port: 1 }, accounts: accounts.map(a => ({ name: a.name, type: a.type })), routes: [], blockedModels: [], koLayout: true, hostLine: false };
  /** @type {string[][]} */
  const calls = [];
  // The warmer's own rule (no live 5h window); the TUI drops the weekly-spent itself.
  const warmCandidates = () => accounts.filter(a => !(a.quota.unified5hReset > Date.now()));
  const warmNow = async (/** @type {any[]} */ targets, /** @type {any} */ { onDone } = {}) => {
    calls.push(targets.map(a => a.name));
    for (const a of targets) onDone?.(a, { status: result, error: result === 'error' ? 'claude exited 1' : null });
    return targets.map(account => ({ account, status: result, error: result === 'error' ? 'claude exited 1' : null }));
  };
  const tui = new TUI({ accountManager: am, config, loginAccount: async () => ({}), saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, warmCandidates, warmNow });
  return { tui, calls, accounts };
}

function renderToString(tui) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  try { tui.running = true; tui._render(true); } finally { process.stdout.write = orig; tui.running = false; }
  return stripAnsi(chunks.join(''));
}

const logText = tui => tui.log.map(l => stripAnsi(l.msg)).join('\n');

test('W: 5시간이 안 도는 계정만 고르고(주간 다 쓴 계정은 뺌) Enter 로 켠다', async () => {
  const { tui, calls } = makeTUI();
  tui.render = () => {};
  tui._key('W');
  assert.equal(tui.mode, 'warm');
  assert.deepEqual(tui._warmPick.map(a => a.name), ['idle@gmail.com', 'fresh@2117academy.com']);
  assert.match(stripAnsi(tui._renderFooter()), /5시간이 안 도는 계정 2개\(\*\)를 지금 켤까요\?\s+Enter 켜기\s+Esc 취소/);
  tui.config.koLayout = false; // 옛 화면은 줄 표시가 없어 이름을 덧붙인다
  assert.match(stripAnsi(tui._renderFooter()), /Esc 취소.*idle, fresh/);
  tui.config.koLayout = true;
  assert.deepEqual(calls, [], '확인 전에는 안 켠다');
  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [['idle@gmail.com', 'fresh@2117academy.com']]);
  assert.match(logText(tui), /5시간 켬 2개/);
  assert.equal(tui._warming, null);
});

test('W: Esc 는 취소, 아무것도 켜지 않는다', () => {
  const { tui, calls } = makeTUI();
  tui.render = () => {};
  tui._key('ㅈ');
  assert.equal(tui.mode, 'warm');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui._warmPick, null);
  assert.deepEqual(calls, []);
});

test('W: 켤 계정이 없으면 화면을 바꾸지 않고 알림만 남긴다', () => {
  const { tui, calls, accounts } = makeTUI();
  tui.render = () => {};
  for (const a of accounts) a.quota.unified5hReset = Date.now() + H;
  tui._key('w');
  assert.equal(tui.mode, 'normal');
  assert.match(logText(tui), /켤 계정이 없습니다/);
  assert.deepEqual(calls, []);
});

test('W: 실패한 계정은 알림에 남고 끝 줄에 실패 수가 나온다', async () => {
  const { tui } = makeTUI({ result: 'error' });
  tui.render = () => {};
  tui._key('w');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.match(logText(tui), /✗ idle 5시간 켜기 실패: claude exited 1/);
  assert.match(logText(tui), /5시간 켬 0개 · 실패 2/);
});

test('한글 입력기가 ㅈ 과 Enter 를 한 덩어리("ㅈ\\r")로 보내도 W → Enter 로 처리된다', async () => {
  const { tui, calls } = makeTUI();
  tui.render = () => {};
  tui._onKeys('ㅈ\r');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [['idle@gmail.com', 'fresh@2117academy.com']]);
});

test('자모 쪼개기는 글자 입력 화면에서는 하지 않는다(붙여넣기 그대로)', () => {
  const { tui } = makeTUI();
  tui.render = () => {};
  tui.mode = 'input'; tui.inputBuf = ''; tui.inputReturn = 'normal';
  tui._onKeys('ㅈㅈ');
  assert.equal(tui.inputBuf, 'ㅈㅈ');
  assert.equal(tui.mode, 'input');
});

test('koLayout: W 확인 화면은 켤 계정 줄에 * 를 붙이고, 아래 안내에 W 가 있다', () => {
  const { tui } = makeTUI();
  let out = renderToString(tui);
  assert.match(out, /W 5시간켜기/);
  tui.render = () => {};
  tui._key('w');
  out = renderToString(tui);
  assert.match(out, /^\* idle\s/m);
  assert.match(out, /^\* fresh\s/m);
  assert.doesNotMatch(out, /^\* busy\s/m);
  assert.doesNotMatch(out, /^\* spent\s/m);
});
