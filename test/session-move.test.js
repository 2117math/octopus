import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// Per-session markers and moving a session. A session (one Claude Code
// conversation, its subagents included) is pinned per weekly bucket and per
// conversation; a move re-points every one of those pins, the status payload
// lists sessions for the operator, and the TUI draws them under their account
// and moves one with `m`.

const SHARED = 'unified7d';
const FABLE_BUCKET = 'unified7dFable';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const HOUR = 3600_000;
const SID = '3f2a1b9c-0000-4000-8000-000000000001';
const SID2 = '3f2a1b9c-1111-4000-8000-000000000002';
const OTHER = 'aa11bb22-0000-4000-8000-000000000003';

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra });
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');

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

// ── TUI ────────────────────────────────────────────────────────

function makeTUI(am, config = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [], ...config }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  return tui;
}

/** One full frame at 120x30, as plain lines (or as painted, with `raw`). */
function frame(tui, { raw = false } = {}) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let buf = '';
  try {
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render({ force: true });
  } finally {
    tui.running = false;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete process.stdout.rows;
  }
  return (raw ? buf : plain(buf)).split('\r\n');
}

test('the dashboard lists sessions in their own panel, not under the account rows', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  am.beginSession(SID, { sessionId: SID, model: OPUS });
  am.recordSession(SID, 1, OPUS);   // in flight: active
  am.beginSession(OTHER, { sessionId: OTHER, model: OPUS });
  am.recordSession(OTHER, 1, OPUS);
  am.endSession(OTHER);
  // Idle for a quarter of an hour: past the row's ten-minute window.
  for (const s of am.sessionTracker.sessions.values()) if (s.sessionId === OTHER) s.lastSeen -= 15 * 60_000;
  const titles = { enabled: true, width: 18, get: id => (id === SID ? '로그인 버그 고치기' : null) };

  const tui = makeTUI(am);
  tui.sessionTitles = /** @type {any} */ (titles);
  const lines = frame(tui);
  const row = lines.findIndex(l => l.includes('b@x.com') && !/[●○]/.test(l));
  assert.doesNotMatch(lines[row + 1], /[●○]/, 'no session line under the account any more');
  assert.doesNotMatch(lines[lines.findIndex(l => l.includes('a@x.com')) + 1], /[●○]/, 'nor under one with no sessions');
  assert.match(lines.find(l => l.includes('로그인 버그 고치기')) || '', /● 로그인 버그 고치기\s+→ b@x\.com/, 'the active session, named, in the panel with its account');
  assert.match(lines.find(l => l.includes('aa11bb')) || '', /○ aa11bb/, 'an idle session is listed hollow');

  const off = makeTUI(am, { sessionRows: false });
  off.sessionTitles = /** @type {any} */ (titles);
  assert.equal(frame(off).filter(l => /[●○]/.test(l)).length, 0, 'sessionRows: false draws the old layout');

  // Many sessions: what does not fit is counted, not cut.
  const many = am.sessionList();
  tui._sessionItems = () => Array.from({ length: 12 }, (_, i) => ({ ...many[0], id: `${i}`.padStart(8, 'a'), title: `session number ${i}` }));
  const panel = tui._sessionsPanel(80).map(plain);
  assert.ok(panel.every(l => l.length <= 80));
  assert.match(panel[panel.length - 1], /\+4 more$/);
});

test('the colours of an account\'s sessions run under its name, split between them', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com')], 0.98, { distributeSessions: true });
  // Two sessions on b, newest last; a carries none.
  for (const id of [OTHER, SID]) {
    am.beginSession(id, { sessionId: id, model: OPUS });
    am.recordSession(id, 1, OPUS);
    am.endSession(id);
  }
  for (const s of am.sessionTracker.sessions.values()) if (s.sessionId === OTHER) s.lastSeen -= 1000;
  const tui = makeTUI(am);
  const nameW = tui._listLayout(tui._displayOrder(), 120).nameW;
  const lines = frame(tui, { raw: true });
  // The row by its text: the runs split the name, so the painted line holds it in pieces.
  const rowOf = name => lines[lines.findIndex(l => plain(l).includes(name))];
  // A background run: a 4x/10x code with its text colour, up to its reset.
  const RUN = new RegExp(String.fromCharCode(27) + '\\[(4[0-7]|10[0-7]);(30|97)m([^' + String.fromCharCode(27) + ']*)' + String.fromCharCode(27) + '\\[0m', 'g');
  const runs = [...rowOf('b@x.com').matchAll(RUN)];
  assert.equal(runs.length, 2, 'one run per session');
  assert.notEqual(runs[0][1], runs[1][1], 'each in its own session colour');
  const cell = runs.map(m => m[3]).join('');
  assert.equal(cell.length, nameW, 'together they cover the whole name cell');
  assert.equal(cell.trimEnd(), 'b@x.com', 'and the name itself is unchanged');
  assert.equal(runs[0][3].length, Math.ceil(nameW / 2), 'the newest session takes the first half and the odd column');
  assert.equal([...rowOf('a@x.com').matchAll(RUN)].length, 0, 'no session, no background');

  const off = makeTUI(am, { sessionRows: false });
  assert.equal(frame(off, { raw: true }).filter(l => RUN.test(l)).length, 0, 'sessionRows: false paints no background');
});

test('m picks a session, preselects the least-used account, and moves it', () => {
  const am = new AccountManager([oauth('a@x.com'), oauth('b@x.com'), oauth('c@x.com'), oauth('d@x.com')], 0.98, { distributeSessions: true });
  const weekly = [0.9, 0.6, 0.2, 0.1];
  weekly.forEach((w, i) => {
    am.accounts[i].quota.unified7d = w;
    am.accounts[i].quota.unified7dReset = Date.now() + 100 * HOUR;
    am.accounts[i].probing = false;
  });
  am.accounts[3].disabled = true;   // the least used, but out of rotation
  am.beginSession(SID, { sessionId: SID, model: OPUS, clientPinned: true });
  am.recordSession(SID, 0, OPUS);
  am.endSession(SID);

  const tui = makeTUI(am);
  tui.render = () => {};
  tui._key('m');
  assert.equal(tui.mode, 'move');
  assert.equal(tui.move.stage, 'session');
  tui._key('enter');
  assert.equal(tui.move.stage, 'account');
  const at = () => tui.move.accounts[tui.move.aIdx].idx;
  assert.equal(at(), 2, 'the cursor starts on the selectable account with the least weekly use');
  assert.equal(tui.move.accounts.find(r => r.idx === 3).ok, false, 'a disabled account cannot be chosen');
  tui._key('down');
  assert.equal(at(), 2, 'the cursor does not stop on a struck-through row');

  const lines = [];
  tui._renderMove(lines, 120, 28);
  const text = lines.map(plain).join('\n');
  assert.match(text, /▸ c@x\.com\s+Ses\s+-\s+· Wk\s+20%/);
  assert.match(lines.map(l => l).join('\n'), /\x1b\[9m/, 'the disabled row is struck through');

  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 2);
  assert.match(plain(tui.log[0].msg), /^Moved session "3f2a1b" a@x\.com → c@x\.com \(applies from its next request\) — but the client pins it with TC_ACCT; the move has no effect$/);

  tui._key('m');
  tui._key('esc');
  assert.equal(tui.mode, 'normal', 'Esc cancels');
  assert.equal(am.sessionTracker.pinnedAccount(SID, SHARED), 2);
});

test('attach mode reads the server\'s session list and sends the move', async () => {
  const am = new RemoteAccountManager();
  am.applyStatus({
    accounts: [{ name: 'a@x.com', quota: { unified7d: 0.5 } }, { name: 'b@x.com', quota: { unified7d: 0.1 } }],
    sessions: { list: [
      { id: SID, title: 'Fix\x1b[2J the bug', account: 0, accountName: 'a@x.com', lastSeen: 1000, active: true, model: OPUS, clientPinned: false },
      { id: 'bad id!', title: 'dropped', account: 0, lastSeen: 1, active: true },
    ] },
  });
  assert.deepEqual(am.sessionList().map(s => s.id), [SID], 'a row whose id is not one is dropped');
  assert.equal(am.sessionList()[0].title, 'Fix the bug', 'the title is scrubbed');

  const sent = [];
  const tui = new TUI({
    accountManager: am, remote: true, config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    applySessionMove: async (session, account) => { sent.push([session, account]); return { ok: true, from: 'a@x.com', to: account }; },
  });
  tui.render = () => {};
  tui._key('m');
  tui._key('enter');
  assert.equal(tui.move.accounts[tui.move.aIdx].idx, 1);
  tui._key('enter');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(sent, [[SID, 'b@x.com']]);
  assert.match(plain(tui.log[0].msg), /^Moved session "Fix the bug" a@x\.com → b@x\.com/);
});
