import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

// [local patch 2026-10-27 원장] Fable 주간을 다 쓴 계정에 붙던 「다 썼다」 장식(`⊘ Fable`)을 TUI 에서 뺀다.
// 「어차피 100%라고 써 있으면 된다」 — F7 막대와 100% 숫자는 그대로, 라우팅은 그대로.

const H = 3600_000;
const ESC = String.fromCharCode(27);
const strip = s => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

function rowsFor(fable) {
  const entries = [0, 1].map(i => ({ name: `acct${i}@example.com`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H }));
  const am = new AccountManager(entries, 0.98, {});
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4; a.quota.unified5hReset = Date.now() + 4 * H;
    a.quota.unified7d = 0.3; a.quota.unified7dReset = Date.now() + 3 * 24 * H;
    a.quota.unified7dFable = fable[i]; a.quota.unified7dFableReset = Date.now() + 6 * 24 * H;
  });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [], quotaBarPercent: true }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rws = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const drawn = [];
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...a) => { const out = real(...a); drawn.push(out); return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rws) Object.defineProperty(process.stdout, 'rows', rws);
  }
  return { am, raw: drawn };
}

test('Fable 100% 계정 줄: ⊘·✗·취소선 없이 F7 막대와 100% 는 그대로', () => {
  const { am, raw } = rowsFor([1.0, 0.2]);
  assert.ok(am.accounts[0].quota.unified7dFable >= 1);
  const spent = raw[0];
  const text = strip(spent);
  assert.ok(text.includes('F7'), 'F7 막대는 그대로');
  assert.match(text, /F7[^\n]*100%/, '100% 숫자는 그대로');
  assert.ok(!/[⊘✗]/.test(text), `소진 표식이 없다: ${text}`);
  assert.ok(!spent.includes(`${ESC}[9m`), '취소선(SGR 9)이 없다');
  assert.ok(!/Fable/i.test(text), '따로 붙는 Fable 경고 글자가 없다');
});

test('라우팅은 그대로: Fable 을 다 쓴 계정은 Fable 요청을 받지 않는다', () => {
  const { am } = rowsFor([1.0, 0.2]);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), false);
  assert.equal(am._isAvailable(am.accounts[1], 'claude-fable-5'), true);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-sonnet-5-5'), true, '다른 모델은 계속 받는다');
});
