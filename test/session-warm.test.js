import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS, MAX_WARM_SESSIONS } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';
import { Warmer } from '../src/warmer.js';

const SHARED = 'unified7d';

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

// One warm run (account 0) and one ordinary session (account 0), both live.
function seeded() {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.markWarm('warm-1');
  st.beginRequest('warm-1', clock.t);
  st.touch('warm-1', 0, SHARED, clock.t);
  st.beginRequest('real-1', clock.t);
  st.touch('real-1', 0, SHARED, clock.t);
  st.endRequest('warm-1', clock.t);
  st.endRequest('real-1', clock.t);
  return { clock, st };
}

test('isWarm matches the bare id and any conversation key of it', () => {
  const st = new SessionTracker();
  st.markWarm('w');
  assert.equal(st.isWarm('w'), true);
  assert.equal(st.isWarm('w/abcdef'), true);
  assert.equal(st.isWarm('other'), false);
  assert.equal(st.isWarm(null), false);
});

test('a warm session is not counted as a seat on its account', () => {
  const { clock, st } = seeded();
  assert.equal(st.knownCountFor(0, clock.t), 1);
});

test('a warm session has no siblings and is no sibling', () => {
  const { clock, st } = seeded();
  st.touch('warm-1/aaa', 0, SHARED, clock.t);
  st.touch('warm-1/bbb', 1, SHARED, clock.t);
  st.touch('real-1/aaa', 2, SHARED, clock.t);
  st.touch('real-1/bbb', 3, SHARED, clock.t);
  assert.deepEqual(st.siblingAccounts('warm-1/aaa', clock.t), []);
  assert.deepEqual(st.siblingAccounts('real-1/aaa', clock.t).sort(), [0, 3]);
});

test('sessionList leaves warm sessions out', () => {
  const { clock, st } = seeded();
  assert.deepEqual(st.sessionList(clock.t).map(s => s.id), ['real-1']);
});

test('stats leaves warm sessions out of the counts but keeps their tokens', () => {
  const { clock, st } = seeded();
  st.recordTokens('warm-1', SHARED, { input_tokens: 7 }, clock.t);
  const s = st.stats(clock.t, { detail: true });
  assert.equal(s.known, 1);
  assert.equal(s.active, 1);
  assert.equal(s.tokens.input, 7);
  assert.deepEqual(s.knownPerAccount, { 0: 1 });
  assert.deepEqual(s.perAccount, { 0: 1 });
  assert.deepEqual(s.items.map(i => i.id), ['real-1']);
});

test('the warm set is bounded and drops the oldest id first', () => {
  const st = new SessionTracker();
  for (let i = 0; i < MAX_WARM_SESSIONS + 5; i++) st.markWarm(`w${i}`);
  assert.equal(st.warm.size, MAX_WARM_SESSIONS);
  assert.equal(st.isWarm('w0'), false);
  assert.equal(st.isWarm('w4'), false);
  assert.equal(st.isWarm('w5'), true);
  assert.equal(st.isWarm(`w${MAX_WARM_SESSIONS + 4}`), true);
});

test('sweep forgets a warm id once its session expired, but not a fresh unused one', () => {
  const { clock, st } = seeded();
  st.markWarm('fresh', clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.markWarm('later', clock.t);
  st.sweep(clock.t);
  assert.equal(st.isWarm('warm-1'), false, 'expired and gone');
  assert.equal(st.isWarm('fresh'), false, 'old and never used');
  assert.equal(st.isWarm('later'), true, 'marked just now, first request still to come');
});

test('the warmer puts a fresh --session-id in the args and marks it before the run', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const seen = [];
  const spawnFn = async (spec) => {
    const id = spec.args[spec.args.indexOf('--session-id') + 1];
    seen.push({ id, warmAtSpawn: am.sessionTracker.isWarm(id) });
    return 0;
  };
  const warmer = new Warmer(am, { intervalMs: 0, port: 3456, apiKey: 'k', spawnFn, log: () => {} });
  await warmer.warmAll();
  await warmer.warmAll();
  assert.equal(seen.length, 2);
  assert.match(seen[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(seen[0].id, seen[1].id);
  assert.ok(seen.every(s => s.warmAtSpawn));
});
