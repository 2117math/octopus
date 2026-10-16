import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Per-session markers and moving a session. A session (one Claude Code
// conversation, its subagents included) is pinned per weekly bucket and per
// conversation; a move re-points every one of those pins, and the status
// payload lists sessions for the operator.

const SHARED = 'unified7d';
const FABLE_BUCKET = 'unified7dFable';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const HOUR = 3600_000;
const SID = '3f2a1b9c-0000-4000-8000-000000000001';
const SID2 = '3f2a1b9c-1111-4000-8000-000000000002';
const OTHER = 'aa11bb22-0000-4000-8000-000000000003';

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

// ── tracker ────────────────────────────────────────────────────

test('movePins re-points every bucket of every conversation of the session', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  // The session's own conversation on 0 for two families, a subagent on 1, and
  // an unrelated session on 0.
  st.beginRequest(`${SID}/main`, clock.t, { sessionId: SID });
  st.touch(`${SID}/main`, 0, SHARED, clock.t);
  st.touch(`${SID}/main`, 0, FABLE_BUCKET, clock.t);
  clock.t += 10;
  st.beginRequest(`${SID}/agent`, clock.t, { sessionId: SID });
  st.touch(`${SID}/agent`, 1, SHARED, clock.t);
  st.touch(OTHER, 0, SHARED, clock.t);

  assert.deepEqual(st.movePins(SID, 2, clock.t), [1, 0], 'the accounts it left, newest pin first');
  for (const key of [`${SID}/main`, `${SID}/agent`]) {
    assert.equal(st.pinnedAccount(key, SHARED, clock.t), 2);
  }
  assert.equal(st.pinnedAccount(`${SID}/main`, FABLE_BUCKET, clock.t), 2, 'every bucket moves, not only one');
  assert.equal(st.pinnedAccount(OTHER, SHARED, clock.t), 0, 'another session is left where it is');
});

test('movePins refuses a session it cannot move', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  assert.equal(st.movePins('nobody', 1, clock.t), false, 'unknown');
  st.beginRequest(SID, clock.t, { sessionId: SID });
  assert.equal(st.movePins(SID, 1, clock.t), false, 'known but never routed: no pin to move');
  st.touch(SID, 0, SHARED, clock.t);
  assert.equal(st.movePins(SID, -1, clock.t), false, 'not an account position');
  assert.equal(st.pinnedAccount(SID, SHARED, clock.t), 0);
});

test('sessionList folds conversations into one row per session, newest first', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest(`${SID}/main`, clock.t, { sessionId: SID, model: OPUS, clientPinned: false });
  st.touch(`${SID}/main`, 0, SHARED, clock.t);
  st.endRequest(`${SID}/main`, clock.t);
  clock.t += 1000;
  st.beginRequest(`${SID}/agent`, clock.t, { sessionId: SID, model: FABLE, clientPinned: true });
  st.touch(`${SID}/agent`, 1, FABLE_BUCKET, clock.t);
  st.endRequest(`${SID}/agent`, clock.t);
  clock.t += 5 * 60_000;
  st.beginRequest(OTHER, clock.t, { sessionId: OTHER });
  st.touch(OTHER, 2, SHARED, clock.t);
  st.endRequest(OTHER, clock.t);
  clock.t += 1000;

  const rows = st.sessionList(clock.t);
  assert.deepEqual(rows.map(r => r.id), [OTHER, SID]);
  const [, mine] = rows;
  assert.equal(mine.account, 1, 'the newest pin speaks for the session');
  assert.equal(mine.model, FABLE);
  assert.equal(mine.clientPinned, true);
  assert.equal(mine.active, false, 'idle past the active window');
  assert.equal(mine.lastSeen, 5 * 60_000 + 1000, 'ms since its last request');
  assert.deepEqual(st.sessionList(clock.t, { maxAgeMs: 60_000 }).map(r => r.id), [OTHER]);
  assert.deepEqual(st.sessionList(clock.t, { limit: 1 }).map(r => r.id), [OTHER]);
});

// ── manager ────────────────────────────────────────────────────

test('moveSession moves a placed session, and its next request follows', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com'), oauth('c@x.com')], 0.98, { distributeSessions: true });
  am.beginSession(SID, { sessionId: SID });
  am.recordSession(SID, 0, OPUS);
  am.endSession(SID);
  assert.equal(am.getActiveAccount(null, OPUS, null, SID).index, 0, 'pinned where it was placed');

  const res = am.moveSession(SID, 2);
  assert.deepEqual(res, { ok: true, session: SID, from: 0, fromAll: [0], to: 2 });
  assert.equal(am.getActiveAccount(null, OPUS, null, SID).index, 2, 'the next request routes to the new account');

  const [row] = am.sessionList({ title: id => (id === SID ? 'Fix the login bug' : null) });
  assert.equal(row.title, 'Fix the login bug');
  assert.equal(row.account, 2);
  assert.equal(row.accountName, 'c@x.com');
  assert.equal(row.model, OPUS, 'recordSession notes the model');
});

test('moveSession refuses what it cannot do', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  am.recordSession(SID, 0, OPUS);
  assert.equal(am.moveSession(SID, 9).ok, false, 'no such account');
  assert.equal(am.moveSession('bad id!', 1).ok, false, 'not a session id');
  assert.match(am.moveSession(OTHER, 1).error, /not been routed/);
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 0, 'nothing moved');
});

// ── server ─────────────────────────────────────────────────────

const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const CONFIG = {
  proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] },
  upstream: 'http://127.0.0.1:9',
};

async function withServer(fn) {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  for (const id of [SID, SID2]) {
    am.beginSession(id, { sessionId: id, model: OPUS, clientPinned: id === SID2 });
    am.recordSession(id, 0, OPUS);
    am.endSession(id);
  }
  const titles = { [SID]: 'Fix the login bug' };
  const proxy = createProxyServer(am, CONFIG, { sessionTitle: id => titles[id] ?? null });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const call = (method, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    await fn({ am, call });
  } finally {
    proxy.close();
  }
}

test('status lists the sessions to the operator, and not to a client key', async () => {
  await withServer(async ({ call }) => {
    const status = await (await call('GET', '/teamclaude/status')).json();
    const list = status.sessions.list;
    assert.deepEqual(list.map(s => s.id).sort(), [SID, SID2]);
    const row = list.find(s => s.id === SID);
    assert.equal(row.title, 'Fix the login bug');
    assert.equal(row.account, 0);
    assert.equal(row.accountName, 'a@x.com');
    assert.equal(row.model, OPUS);
    assert.equal(row.clientPinned, false);
    assert.equal(typeof row.lastSeen, 'number');
    assert.equal(typeof row.active, 'boolean');
    assert.equal(list.find(s => s.id === SID2).clientPinned, true);
    assert.equal(status.sessions.items, undefined, 'the sessionDetail readout stays off');

    const tenant = await (await call('GET', '/teamclaude/status', undefined, { 'x-api-key': CLIENT_KEY })).json();
    assert.equal(tenant.sessions.list, undefined, 'a tenant does not see whose sessions are running');
  });
});

test('POST /teamclaude/session-move moves by id prefix and account name or index', async () => {
  await withServer(async ({ am, call }) => {
    const res = await call('POST', '/teamclaude/session-move', { session: '3f2a1b9c-0', account: 'b@x.com' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.session, SID);
    assert.equal(body.from, 'a@x.com');
    assert.equal(body.to, 'b@x.com');
    assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 1);

    const back = await (await call('POST', '/teamclaude/session-move', { session: SID, account: 0 })).json();
    assert.equal(back.to, 'a@x.com', 'an index names an account too');
  });
});

test('POST /teamclaude/session-move refuses an ambiguous or unknown session, and a client key', async () => {
  await withServer(async ({ am, call }) => {
    const ambiguous = await call('POST', '/teamclaude/session-move', { session: '3f2a1b9c', account: 'b@x.com' });
    assert.equal(ambiguous.status, 400);
    assert.equal((await ambiguous.json()).candidates.length, 2);

    assert.equal((await call('POST', '/teamclaude/session-move', { session: 'ffff', account: 'b@x.com' })).status, 404);
    assert.equal((await call('POST', '/teamclaude/session-move', { session: SID, account: 'nobody@x.com' })).status, 404);
    assert.equal((await call('POST', '/teamclaude/session-move', { session: 'bad id!', account: 'b@x.com' })).status, 400);

    const tenant = await call('POST', '/teamclaude/session-move', { session: SID, account: 'b@x.com' }, { 'x-api-key': CLIENT_KEY });
    assert.equal(tenant.status, 403);
    assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 0, 'nothing moved');
  });
});
