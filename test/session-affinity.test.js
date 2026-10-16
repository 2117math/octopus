// [local patch] Placement rules for Octopus's distribution mode:
//   - spread first: a new client session takes an account no known session
//     sits on while one exists, least-used weekly among those;
//   - share only when unavoidable: once every account carries a session, the
//     least-used one is shared;
//   - session affinity: a conversation with no pin of its own (a fresh
//     subagent, a helper call) follows the account its client session already
//     sits on, unless that account cannot serve it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600e3;

function fleet(weekly, opts = {}) {
  const now = Date.now();
  const am = new AccountManager(
    weekly.map((_, i) => ({ name: `acct${i}`, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}` })),
    1, { distributeSessions: true, sessionAffinity: true, ...opts });
  weekly.forEach((u, i) => {
    const q = am.accounts[i].quota;
    q.unified7d = u; q.unified7dReset = now + (50 + i) * H;
    q.unified5h = 0.3; q.unified5hReset = now + 2 * H;
  });
  return am;
}

const seat = (am, key, idx) => { am.sessionTracker.touch(key, idx, 'unified7d'); };
const place = (am, key, model = 'claude-sonnet-5-5') => am._selectForSession(key, null, model, null)?.name;

test('spread first: a new session avoids an account another session already sits on', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'A/aaa', 0);                       // acct0 is the least used, but taken
  assert.equal(place(am, 'B/bbb'), 'acct1');  // least used among the free ones
});

test('a resting session still holds its seat (known, not merely active)', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  const t0 = Date.now() - 10 * 60e3;          // pinned ten minutes ago, idle since
  am.sessionTracker.touch('A/aaa', 0, 'unified7d', t0);
  assert.equal(am.sessionTracker.activeCountFor(0), 0);
  assert.equal(am.sessionTracker.knownCountFor(0), 1);
  assert.equal(place(am, 'B/bbb'), 'acct1');
});

test('share only when unavoidable: with every account seated, the least used is shared', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'A/aaa', 0); seat(am, 'B/bbb', 1); seat(am, 'C/ccc', 2);
  assert.equal(place(am, 'D/ddd'), 'acct0');
});

test('one session fanning out counts as one seat, not one per conversation', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'A/aaa', 1); seat(am, 'A/bbb', 1); seat(am, 'A/ccc', 1);
  seat(am, 'B/aaa', 0);
  assert.equal(am.sessionTracker.knownCountFor(1), 1);
  assert.equal(place(am, 'C/ccc'), 'acct2');  // acct0 and acct1 each hold one session
});

test('session affinity: a conversation without a pin follows its session\'s seat', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'S/parent', 2);                     // the session sits on the most-used account
  assert.equal(place(am, 'S/subagent'), 'acct2');
  assert.deepEqual(am.sessionTracker.siblingAccounts('S/subagent'), [2]);
});

test('session affinity yields when the seat cannot serve the request', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'S/parent', 2);
  am.accounts[2].quota.unified7d = 1;          // seat is spent
  assert.equal(place(am, 'S/subagent'), 'acct0');
});

test('session affinity off: a fan-out spreads as upstream did', () => {
  const am = fleet([0.10, 0.30, 0.50], { sessionAffinity: false });
  seat(am, 'S/parent', 2);
  assert.equal(place(am, 'S/subagent'), 'acct0');
  am.setSessionAffinity(true);
  assert.equal(place(am, 'S/subagent'), 'acct2');
});

test('a pinned conversation keeps its own account over its siblings\' seat', () => {
  const am = fleet([0.10, 0.30, 0.50]);
  seat(am, 'S/parent', 2);
  seat(am, 'S/child', 1);                      // moved by hand, say
  assert.equal(place(am, 'S/child'), 'acct1');
});
