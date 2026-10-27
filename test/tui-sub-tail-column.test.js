import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, alignSubTails, displayWidth } from '../src/tui.js';

// [local patch 2026-10-27 원장] 구독 꼬리(`· 구독 10/28 D-2`)는 모든 계정 줄에서 같은 세로 자리(같은 열)에서
// 시작한다 — 그 줄에 F7(Fable 주간) 칸이 있든 없든. 모자랄 때의 규칙(F7·S7 먼저 빼고, 그래도 안 되면 꼬리
// 통째로, 반쪽 금지)은 f57b973 그대로.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const KST = 9 * 3600_000;
const H = 3600_000;
const kstYmd = ms => new Date(ms + KST).toISOString().slice(0, 10);
const TAIL = '· 구독';
/** 꼬리 시작 열(표시 폭 기준). 꼬리가 없으면 -1. */
const colOf = line => { const i = line.indexOf(TAIL); return i < 0 ? -1 : displayWidth(line.slice(0, i)); };

function makeTui({ fableIdx = 4, sonnetIdx = null, n = 5 } = {}) {
  const entries = Array.from({ length: n }, (_, i) => ({
    name: `acct${i}@example.com`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H,
  }));
  const am = new AccountManager(entries, 0.98, {});
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4; a.quota.unified5hReset = Date.now() + 4 * H;
    a.quota.unified7d = 0.3 + i * 0.1; a.quota.unified7dReset = Date.now() + (i % 2 ? 5 : 3 * 24) * H; // 일부는 24시간 안 리셋
    a.renewDate = kstYmd(Date.now() + (2 + i * 4) * 24 * H); // D-2, D-6, D-10 … (꼬리 글자 수가 다르다)
    if (i === fableIdx) { a.quota.unified7dFable = 0.02; a.quota.unified7dFableReset = Date.now() + 6 * 24 * H; }
    if (i === sonnetIdx) { a.quota.unified7dSonnet = 0.1; a.quota.unified7dSonnetReset = Date.now() + 6 * 24 * H; }
  });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui._paint = () => {};
  tui.running = true;
  return { am, tui };
}

function withTerminal(width, fn) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  try { return fn(); } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
}

function accountLines(width, opts) {
  const { tui } = makeTui(opts);
  const drawn = [];
  withTerminal(width, () => {
    const real = tui._renderRows.bind(tui);
    tui._renderRows = (...a) => { const out = real(...a); drawn.push(...out.map(strip)); return out; };
    tui.render(true);
  });
  return drawn;
}

test('넓은 창: F7 칸이 있는 줄과 없는 줄의 구독 꼬리가 같은 열에서 시작한다', () => {
  const rows = accountLines(200, { fableIdx: 4 });
  assert.equal(rows.length, 5);
  assert.ok(rows[4].includes('F7') && !rows[0].includes('F7'));
  const cols = rows.map(colOf);
  assert.ok(cols.every(c => c > 0), rows.join('\n'));
  assert.equal(new Set(cols).size, 1, `꼬리 열이 제각각: ${cols} \n${rows.join('\n')}`);
  // 몸통이 짧은 줄은 빈칸으로 채웠을 뿐, 꼬리 글자는 온전하다
  assert.ok(rows.every(r => /· 구독 \d+\/\d+ (?:D-\d+|D-day)\s*$/.test(r)));
});

test('F7·S7 가 둘 다 있는 줄이 섞여도 같은 열이다', () => {
  const rows = accountLines(200, { fableIdx: 4, sonnetIdx: 2 });
  const cols = rows.map(colOf);
  assert.equal(new Set(cols).size, 1, `${cols}\n${rows.join('\n')}`);
});

test('모든 너비에서: 꼬리가 남은 줄들은 같은 열이고, 꼬리는 통째로 있거나 통째로 없다', () => {
  let sawNarrow = 0;
  for (let w = 50; w <= 200; w++) {
    for (const opts of [{ fableIdx: 4 }, { fableIdx: 4, sonnetIdx: 4 }, { fableIdx: 1, sonnetIdx: 3 }]) {
      const rows = accountLines(w, opts);
      const withTail = rows.filter(r => r.includes('구독'));
      for (const r of rows) {
        assert.ok(displayWidth(r) <= w, `W=${w}: ${displayWidth(r)}열`);
        assert.ok(!r.includes('구독') || /· 구독 \d+\/\d+ (?:D-\d+|D-day)\s*$/.test(r), `W=${w}: 꼬리가 잘림 「${r}」`);
      }
      const cols = new Set(withTail.map(colOf));
      assert.ok(cols.size <= 1, `W=${w}: 꼬리 열이 제각각 ${[...cols]}\n${rows.join('\n')}`);
      if (withTail.length && withTail.length < rows.length) sawNarrow++;
    }
  }
  assert.ok(sawNarrow > 0, '일부 줄만 꼬리를 뺀 너비도 확인했다');
});

test('alignSubTails: 열 맞춤·F7 먼저 빼기·반쪽 금지(단위)', () => {
  const mk = (body, droppable, tail, width) => ({ body, droppable, tail, width });
  // 넉넉하면 짧은 줄을 채운다
  let out = alignSubTails([mk('aaaa', [], ' · T1', 40), mk('aaaa[F7]', ['[F7]'], ' · T2', 40), mk('aa', [], '', 40)]);
  assert.deepEqual(out, ['aaaa     · T1', 'aaaa[F7] · T2', 'aa']);
  // 모자라면 가장 긴 줄에서 F7 을 먼저 뺀다 → 다른 줄과 열이 같아진다
  out = alignSubTails([mk('aaaa', [], ' · T1', 12), mk('aaaa[F7]', ['[F7]'], ' · T2', 12)]);
  assert.deepEqual(out, ['aaaa · T1', 'aaaa · T2']);
  // 빼도 안 되면 꼬리를 통째로(반쪽 없음) — 나머지 줄은 자기 자리
  out = alignSubTails([mk('aaaaaaaa', [], ' · T1', 10), mk('aa', [], ' · T2', 10)]);
  assert.deepEqual(out, ['aaaaaaaa', 'aa · T2']);
  // 너비 모름(0)이면 제한 없이 맞춘다
  out = alignSubTails([mk('a', [], ' · T', 0), mk('aaa', [], ' · T', 0)]);
  assert.deepEqual(out, ['a   · T', 'aaa · T']);
});

test('집중 계정 창: 구독 꼬리가 같은 열(리셋 꼬리가 있든 없든)', () => {
  const { tui } = makeTui({ fableIdx: -1 });
  tui._openFocus();
  const lines = [];
  tui._renderFocus(lines, 160, 40);
  const rows = lines.map(strip).filter(l => l.includes(TAIL));
  assert.equal(rows.length, 5);
  assert.ok(rows.some(r => r.includes('리셋')) && rows.some(r => !r.includes('리셋')), '리셋 꼬리가 섞여 있다');
  assert.equal(new Set(rows.map(colOf)).size, 1, rows.join('\n'));
});

test('move 창 계정 줄: 구독 꼬리가 같은 열', () => {
  const { am, tui } = makeTui({ fableIdx: -1 });
  const rows = am.accounts.map((a, idx) => ({
    idx, ok: idx !== 2, current: idx === 0, ses: 0.4, wk: a.quota.unified7d, wkReset: a.quota.unified7dReset,
  }));
  tui.mode = 'move';
  tui.move = { stage: 'account', items: [], idx: 0, visible: 0, session: { id: 'abcdef', title: 't', account: 0, model: null, lastSeen: Date.now() }, accounts: rows, aIdx: 0 };
  const lines = [];
  tui._renderMove(lines, 160, 40);
  const out = lines.map(strip).filter(l => l.includes(TAIL));
  assert.equal(out.length, 5);
  assert.ok(out.some(r => r.includes('리셋')) && out.some(r => !r.includes('리셋')), '리셋 꼬리가 섞여 있다');
  assert.equal(new Set(out.map(colOf)).size, 1, out.join('\n'));
});
