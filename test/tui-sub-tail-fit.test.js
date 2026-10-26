import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

// [local patch 2026-10-26 원장] 계정 줄 끝 「· 구독 10/28 D-2」 가 「· 구」 처럼 글자 중간에서
// 잘리던 문제. Fable 주간 칸(F7)이 붙은 계정 줄만 길어져 꼬리가 줄 끝에서 잘렸다.
// 규칙: 꼬리는 통째로 보이거나 통째로 없다. 모자라면 F7·S7 칸을 먼저 뺀다.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const KST = 9 * 3600_000;
const H = 3600_000;
const kstYmd = ms => new Date(ms + KST).toISOString().slice(0, 10);
const WHOLE_TAIL = /· 구독 \d+\/\d+ (?:D-\d+|D-day)\s*$/;

/** 계정 5개(구독 갱신일 모두 수동값), fableIdx 계정에만 Fable 주간 칸. 그려진 줄(ANSI 제거)을 돌려준다. */
function renderRows(width, { fableIdx = 4, sonnetIdx = null } = {}) {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    name: `acct${i}@example.com`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H,
  }));
  const am = new AccountManager(entries, 0.98, {});
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4; a.quota.unified5hReset = Date.now() + 4 * H;
    a.quota.unified7d = 0.3; a.quota.unified7dReset = Date.now() + (i + 1) * 24 * H;
    a.renewDate = kstYmd(Date.now() + 2 * 24 * H);
    if (i === fableIdx) { a.quota.unified7dFable = 0.02; a.quota.unified7dFableReset = Date.now() + 6 * 24 * H; }
    if (i === sonnetIdx) { a.quota.unified7dSonnet = 0.1; a.quota.unified7dSonnetReset = Date.now() + 6 * 24 * H; }
  });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const drawn = [];
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { const out = real(...args); drawn.push(strip(out)); return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('넓은 창: F7 칸이 있어도 모든 줄이 구독 꼬리까지 온전하다', () => {
  const rows = renderRows(200);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(r => WHOLE_TAIL.test(r)), rows.join('\n'));
  assert.ok(rows[4].includes('F7'), 'F7 칸은 그대로');
});

test('모든 너비에서 꼬리는 통째로 있거나 통째로 없다(반쪽 금지)', () => {
  for (let w = 50; w <= 200; w++) {
    for (const opts of [{ fableIdx: 4 }, { fableIdx: 4, sonnetIdx: 4 }]) {
      for (const r of renderRows(w, opts)) {
        assert.ok(r.length <= w, `W=${w}: ${r.length}열`);
        assert.ok(!r.includes('구독') || WHOLE_TAIL.test(r), `W=${w}: 꼬리가 잘림 「${r}」`);
      }
    }
  }
});

test('좁은 창: F7 줄은 F7 칸을 빼서 꼬리를 살리고, 다른 줄은 그대로다', () => {
  let found = 0;
  for (let w = 60; w <= 200; w++) {
    const rows = renderRows(w);
    const f = rows[4];
    if (WHOLE_TAIL.test(f) && !f.includes('F7')) {
      found++;
      assert.ok(rows.slice(0, 4).every(r => WHOLE_TAIL.test(r) && !r.includes('F7')), `W=${w}: 다른 줄은 F7 없이 꼬리 유지`);
    }
    // F7 칸을 그대로 둔 줄에는 꼬리가 온전하다.
    if (f.includes('F7')) assert.ok(WHOLE_TAIL.test(f) || !f.includes('구독'), `W=${w}`);
  }
  assert.ok(found > 0, 'F7 칸을 빼서 꼬리를 살리는 너비가 있어야 한다');
});

test('F7 를 빼도 안 들어가는 아주 좁은 창: 꼬리를 통째로 뺀다', () => {
  let none = 0;
  for (let w = 50; w <= 100; w++) {
    for (const r of renderRows(w)) if (!r.includes('구독')) none++;
  }
  assert.ok(none > 0, '꼬리를 통째로 뺀 줄이 있어야 한다');
});
