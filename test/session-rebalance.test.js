import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, rebalanceSetting } from '../src/account-manager.js';
import { setRebalance, ConfigOpError } from '../src/config-ops.js';
import { TUI } from '../src/tui.js';

// Idle rebalance: a pinned session that comes back after `idleSeconds` without
// a request has lost its prompt cache, so when its account is at least `gap`
// more spent this week than the account a new session would get, it moves
// there. Off by default, and nothing else about selection changes.

const SHARED = 'unified7d';
const OPUS = 'claude-opus-5';
const HOUR = 3600_000;
const MIN = 60_000;
const SID = '3f2a1b9c-0000-4000-8000-000000000001';
const ON = { enabled: true, idleSeconds: 300, gap: 0.10 };

const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function weekly(am, index, used) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + 48 * HOUR;
  am.accounts[index].probing = false;
}

/** Two accounts, `a` at `from` and `b` at `to` weekly; the session placed on
 *  `a`, its last request `idleMin` minutes ago, and its next one just begun. */
function setup({ from = 0.48, to = 0.31, idleMin = 7, rebalance = ON, clientPinned = false } = {}) {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true, rebalanceSessions: rebalance });
  weekly(am, 0, from);
  weekly(am, 1, to);
  am.beginSession(SID, { sessionId: SID, model: OPUS, clientPinned });
  am.recordSession(SID, 0, OPUS);
  am.endSession(SID);
  for (const s of am.sessionTracker.sessions.values()) {
    s.lastSeen -= idleMin * MIN;
    for (const pin of s.pins.values()) pin.at -= idleMin * MIN;
  }
  am.beginSession(SID, { sessionId: SID, model: OPUS, clientPinned });
  return am;
}

/** Run `fn`, returning what it returned and the lines it logged. */
function logged(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { value: fn(), lines }; } finally { console.log = orig; }
}

test('a session back from a break moves to the less-spent account, and says so', () => {
  const am = setup();
  am.sessionTitle = id => (id === SID ? 'Fix the login bug' : null);
  const { value, lines } = logged(() => am.getActiveAccount(null, OPUS, null, SID));
  assert.equal(value.index, 1, 'routed to the account a new session would get');
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 1, 'the pin moved with it');
  assert.deepEqual(lines.filter(l => l.includes('Rebalanced')),
    ['[Octopus] Rebalanced session "Fix the login bug" a@x.com → b@x.com (idle 7m, 48% → 31%)']);
});

test('without a title the log names the session by the start of its id', () => {
  const am = setup();
  const { lines } = logged(() => am.getActiveAccount(null, OPUS, null, SID));
  assert.match(lines.find(l => l.includes('Rebalanced')), /Rebalanced session "3f2a1b" a@x\.com → b@x\.com/);
});

test('a session idle for less than idleSeconds keeps its account', () => {
  const am = setup({ idleMin: 2 });
  const { value, lines } = logged(() => am.getActiveAccount(null, OPUS, null, SID));
  assert.equal(value.index, 0);
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 0);
  assert.equal(lines.filter(l => l.includes('Rebalanced')).length, 0);
});

test('a gap below the setting keeps the session; one exactly at it moves it', () => {
  const below = setup({ from: 0.40, to: 0.31 });
  assert.equal(below.getActiveAccount(null, OPUS, null, SID).index, 0, '9 points is under a 10-point gap');
  // 0.41 - 0.31 is 0.0999... in floating point; the gap still counts as met.
  const at = setup({ from: 0.41, to: 0.31 });
  const { value } = logged(() => at.getActiveAccount(null, OPUS, null, SID));
  assert.equal(value.index, 1, 'the gap is >=, not >');
});

test('a session its client pins with TC_ACCT is never moved', () => {
  const am = setup({ clientPinned: true });
  assert.equal(am.getActiveAccount(null, OPUS, null, SID).index, 0);
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 0);
});

test('with the setting off (the default) nothing moves', () => {
  assert.equal(setup({ rebalance: { ...ON, enabled: false } }).getActiveAccount(null, OPUS, null, SID).index, 0);
  assert.equal(setup({ rebalance: null }).getActiveAccount(null, OPUS, null, SID).index, 0, 'absent is off');
  const off = new AccountManager([oauth('a@x.com')], 0.98);
  assert.deepEqual(off.rebalance, { enabled: false, idleSeconds: 300, gap: 0.10 });
});

test('a reload applies the setting to the running manager, both ways', () => {
  const am = setup({ rebalance: null });
  assert.equal(am.getActiveAccount(null, OPUS, null, SID).index, 0, 'off: stays');
  am.setRebalance(ON);   // what index.js does with the reloaded config
  const { value } = logged(() => am.getActiveAccount(null, OPUS, null, SID));
  assert.equal(value.index, 1, 'on: moves on the next request');

  const again = setup();
  again.setRebalance(undefined);   // the key removed from disk
  assert.equal(again.getActiveAccount(null, OPUS, null, SID).index, 0, 'off again');
});

test('at most one move per request, and none while another request is in flight', () => {
  const am = setup();
  const { value } = logged(() => am.getActiveAccount(null, OPUS, null, SID));
  assert.equal(value.index, 1);
  am.recordSession(SID, 1, OPUS);   // the server records the account it routed to
  // The fleet changes under it before a retry of the same request: b is now
  // the more spent, but the session is no longer idle.
  weekly(am, 0, 0.10);
  weekly(am, 1, 0.70);
  assert.equal(am.getActiveAccount(null, OPUS, null, SID).index, 1, 'no second move');

  const busy = setup();
  busy.beginSession(SID, { sessionId: SID, model: OPUS });   // a second request of it, still running
  assert.equal(busy.getActiveAccount(null, OPUS, null, SID).index, 0, 'an in-flight request is not idle');
});

test('the setting is normalised, and octopus rebalance edits it', () => {
  assert.deepEqual(rebalanceSetting(null), { enabled: false, idleSeconds: 300, gap: 0.10 });
  assert.deepEqual(rebalanceSetting({ enabled: true, idleSeconds: 5, gap: 0 }), { enabled: true, idleSeconds: 60, gap: 0.10 },
    'idle floored at a minute; a zero gap would trade sessions back and forth');
  assert.equal(rebalanceSetting({ enabled: 'yes' }).enabled, false, 'only true switches it on');

  const config = { rebalanceSessions: { enabled: false, idleSeconds: 300, gap: 0.2 } };
  assert.deepEqual(setRebalance(config, { enabled: true }), { enabled: true, idleSeconds: 300, gap: 0.2 }, 'the gap is kept');
  assert.deepEqual(setRebalance(config, { idleSeconds: 600 }), { enabled: true, idleSeconds: 600, gap: 0.2 });
  assert.equal(setRebalance(config, { idleSeconds: 0 }).enabled, false, '0 is off');
  assert.throws(() => setRebalance(config, { idleSeconds: 30 }), ConfigOpError);
  assert.equal(config.rebalanceSessions.idleSeconds, 600, 'a refused change writes nothing');
});

test('the settings screen toggles it and hands it to the manager', async () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  let saved = 0;
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => { saved += 1; }, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  const row = tui._settingsFields().find(f => f.id === 'rebalance');
  assert.equal(row.label, 'Idle rebalance');
  await row.right();
  assert.equal(tui.config.rebalanceSessions.enabled, true);
  assert.equal(am.rebalance.enabled, true, 'applied live');
  assert.equal(saved, 1);
  await tui._doSetRebalanceIdle('900');
  assert.equal(am.rebalance.idleSeconds, 900);
  await row.left();
  assert.equal(am.rebalance.enabled, false);
});
