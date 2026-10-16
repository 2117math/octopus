import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

// The fleet line over the account list: average weekly use (and the least used
// account), how many five-hour windows are under half, and how many accounts
// sit at their switch threshold. It takes the list's spacer line, so with one
// account the frame is what it always was.

const HOUR = 3600_000;
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function quota(am, index, five, week) {
  const q = am.accounts[index].quota;
  q.unified5h = five;
  q.unified5hReset = five == null ? null : Date.now() + 2 * HOUR;
  q.unified7d = week;
  q.unified7dReset = week == null ? null : Date.now() + 48 * HOUR;
}

/** One frame at `cols`x30, as plain lines. */
function frame(am, cols = 120) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const saved = { cols: Object.getOwnPropertyDescriptor(process.stdout, 'columns'), rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows') };
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let buf = '';
  try {
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render({ force: true });
  } finally {
    tui.running = false;
    if (saved.cols) Object.defineProperty(process.stdout, 'columns', saved.cols); else delete process.stdout.columns;
    if (saved.rows) Object.defineProperty(process.stdout, 'rows', saved.rows); else delete process.stdout.rows;
  }
  return plain(buf).split('\r\n');
}

test('the fleet line averages weekly use and counts five-hour windows under half', () => {
  const am = new AccountManager(['a@x.com', 'bluejin', 'c@x.com', 'd@x.com', 'e@x.com'].map(oauth), 0.98);
  quota(am, 0, 0.20, 0.60);
  quota(am, 1, 0.70, 0.18);   // the least used this week
  quota(am, 2, 0.99, 0.40);   // five-hour window at the threshold
  quota(am, 3, null, 0.99);   // weekly at the threshold; an empty five-hour window
  quota(am, 4, 0.30, null);   // no weekly reading: left out of the average
  const lines = frame(am);
  const fleet = lines.find(l => l.startsWith(' Fleet'));
  assert.ok(fleet, 'drawn over the list');
  // (0.60 + 0.18 + 0.40 + 0.99) / 4 = 0.5425
  assert.match(fleet, /Wk avg 54% \(lowest bluejin 18%\)/);
  assert.match(fleet, /5h: 3\/5 under 50%/, 'a, d (empty) and e');
  assert.match(fleet, /2 at limit/);
  assert.equal(lines.indexOf(fleet), 2, 'in the spacer under the header rule');
  assert.match(lines[3], /a@x\.com/, 'the list starts where it always did');

  // A narrow terminal drops segments from the end.
  const narrow = frame(am, 60).find(l => l.startsWith(' Fleet'));
  assert.match(narrow, /Wk avg 54%/);
  assert.doesNotMatch(narrow, /at limit/);
});

test('one account, or a disabled second one, leaves the spacer empty', () => {
  const one = new AccountManager([oauth('a@x.com')], 0.98);
  quota(one, 0, 0.2, 0.6);
  const lines = frame(one);
  assert.equal(lines.some(l => l.startsWith(' Fleet')), false);
  assert.match(lines[2], /^\s*$/);

  const two = new AccountManager([oauth('a@x.com'), { ...oauth('b@x.com'), disabled: true }], 0.98);
  assert.equal(frame(two).some(l => l.startsWith(' Fleet')), false, 'only enabled accounts count');
});
