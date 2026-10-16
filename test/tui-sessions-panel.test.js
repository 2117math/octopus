import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The Sessions panel under the account list: a `Sessions (N)` header and one
// line per known session (title, account, model, age), drawn instead of the
// line that used to sit under each account row. Off with sessionRows: false,
// and absent altogether when no session is known.

const HOUR = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const SID = '3f2a1b9c-0000-4000-8000-000000000001';
const OTHER = 'aa11bb22-0000-4000-8000-000000000003';
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const oauth = name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function makeTUI(am, config = {}, extra = {}) {
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [], ...config }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {}, ...extra,
  });
}

/** One full frame at `cols`x30, as plain lines without their padding. */
function frame(tui, cols = 120) {
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
  return plain(buf).split('\r\n').map(l => l.trimEnd());
}

/** Two accounts; SID active on b with a title, OTHER idle five minutes on a. */
function twoSessions() {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  am.beginSession(OTHER, { sessionId: OTHER, model: FABLE, clientPinned: true });
  am.recordSession(OTHER, 0, FABLE);
  am.endSession(OTHER);
  for (const s of am.sessionTracker.sessions.values()) if (s.sessionId === OTHER) s.lastSeen -= 5 * 60_000;
  am.beginSession(SID, { sessionId: SID, model: OPUS });
  am.recordSession(SID, 1, OPUS);   // in flight: active
  const tui = makeTUI(am);
  tui.sessionTitles = /** @type {any} */ ({ enabled: true, width: 18, get: id => (id === SID ? 'Fix the login bug' : null) });
  return { am, tui };
}

test('two sessions draw a Sessions (2) header and one line each, newest first', () => {
  const { tui } = twoSessions();
  const lines = frame(tui);
  const hdr = lines.findIndex(l => /^ Sessions \(2\) ─+$/.test(l));
  assert.ok(hdr > 0, 'the header, ruled like the Activity one');
  assert.match(lines[hdr + 1], /^ ● Fix the login bug\s+→ b@x\.com\s+opus\s+\d+s ago$/, 'title, account, model family, age');
  assert.match(lines[hdr + 2], /^ ○ aa11bb\s+→ a@x\.com\s+fable\s+5m ago\s+\[TC_ACCT\]$/, 'idle is hollow, an untitled one shows its id, a client pin is tagged');
  assert.ok(lines.findIndex(l => l.startsWith(' Activity')) > hdr + 2, 'the panel sits above the activity pane');
});

test('no session line is drawn under an account row any more', () => {
  const { tui } = twoSessions();
  const lines = frame(tui);
  for (const name of ['a@x.com', 'b@x.com']) {
    const row = lines.findIndex(l => l.includes(name) && !/[●○]/.test(l));
    assert.doesNotMatch(lines[row + 1], /[●○]/, `nothing under ${name}`);
  }
});

test('with no session the panel is not drawn at all', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  const lines = frame(makeTUI(am));
  assert.equal(lines.filter(l => l.includes('Sessions')).length, 0);
  assert.equal(lines.filter(l => /[●○]/.test(l)).length, 0);
});

test('sessionRows: false turns the panel off', () => {
  const { am } = twoSessions();
  const lines = frame(makeTUI(am, { sessionRows: false }));
  assert.equal(lines.filter(l => l.includes('Sessions (')).length, 0);
  assert.equal(lines.filter(l => /[●○]/.test(l)).length, 0);
});

test('a narrow terminal cuts each panel line to its width, and the rest is counted', () => {
  const { tui } = twoSessions();
  const base = tui._sessionItems()[0];
  tui._sessionItems = () => Array.from({ length: 11 }, (_, i) => ({ ...base, id: `${i}`.padStart(8, 'a'), title: `a long session title number ${i}`, accountName: 'someone-with-a-long-address@example.com' }));
  const panel = tui._sessionsPanel(50).map(plain);
  assert.match(panel[1], /^ Sessions \(11\) /);
  assert.equal(panel.length, 2 + 8 + 1, 'blank, header, eight sessions, the count');
  assert.ok(panel.every(l => l.length <= 50), 'nothing past the terminal edge');
  assert.match(panel[panel.length - 1], /… \+3 more$/);
});

test('attach mode draws the same panel from the server\'s sessions.list', () => {
  const am = new RemoteAccountManager();
  am.applyStatus({
    accounts: [{ name: 'a@x.com', quota: {} }, { name: 'b@x.com', quota: {} }],
    sessions: { list: [
      { id: SID, title: 'Fix\x1b[2J the bug', account: 1, accountName: 'b@x.com', lastSeen: 3 * 60_000, active: false, model: OPUS, clientPinned: false },
    ] },
  });
  const lines = frame(makeTUI(am, {}, { remote: true }));
  assert.ok(lines.some(l => /^ Sessions \(1\) ─+$/.test(l)));
  assert.ok(lines.some(l => /^ ○ Fix the bug\s+→ b@x\.com\s+opus\s+3m ago$/.test(l)), 'scrubbed title, account, model, age');
});
