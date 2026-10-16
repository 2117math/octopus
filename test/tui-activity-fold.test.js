import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// activityFold: a finished request that matches the newest activity row (same
// session, account and model, and in the full format the same method and
// path) and lands within a minute of it rewrites that row with `×N` instead
// of adding one. A status other than 2xx is always its own row, and the
// activity file still gets one line per request.

const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const SID = 'fa621427-a3d0-41c3-b7f4-d5f7f7021455';

function makeTUI(config = {}) {
  const am = { accounts: [], currentIndex: 0, switchThreshold: 0.98, getRoutes() { return []; } };
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [], ...config }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.sessionTitles = /** @type {any} */ ({ enabled: true, width: 18, get: () => 'Fix the login bug' });
  const file = [];
  tui._activityStream = /** @type {any} */ ({ write: (/** @type {string} */ s) => { file.push(s); }, end() {} });
  return { tui, file };
}

let seq = 0;
/** One request through the hooks the server calls. */
function request(tui, { status = 200, path = '/v1/messages?beta=true', account = 'a@x.com', model = 'claude-opus-5' } = {}) {
  const id = `r${++seq}`;
  tui.onRequestStart(id, { method: 'POST', path, sessionId: SID });
  tui.onRequestModel(id, { model });
  tui.onRequestRouted(id, { account });
  tui.onRequestEnd(id, { method: 'POST', path, account, status, model, sessionId: SID });
}

const rows = tui => tui.log.map(l => plain(l.msg));

test('three like requests share one row, marked ×3, and the file still gets three lines', () => {
  const { tui, file } = makeTUI();
  for (let i = 0; i < 3; i++) request(tui);
  assert.equal(tui.log.length, 1);
  assert.match(rows(tui)[0], /^Fix the login bug  POST \/v1\/messages\?beta=true \(.+\) → a@x\.com \(200, \d+\.\ds\) ×3$/);
  assert.equal(file.length, 3, 'one file line per request');
  assert.ok(file.every(l => !l.includes('×')), 'the file lines are not folded');
});

test('a 429 is its own row and breaks the fold', () => {
  const { tui } = makeTUI();
  request(tui);
  request(tui);
  request(tui, { status: 429 });
  request(tui, { status: 429 });
  request(tui);
  const r = rows(tui);
  assert.equal(r.length, 4);
  assert.match(r[3], /\(200, .+\) ×2$/);
  assert.match(r[2], /\(429, [\d.]+s\)$/);
  assert.match(r[1], /\(429, [\d.]+s\)$/, 'a second 429 is not folded into the first');
  assert.match(r[0], /\(200, [\d.]+s\)$/, 'and the next 2xx starts afresh');
});

test('a different account, model or path starts a new row', () => {
  const { tui } = makeTUI();
  request(tui);
  request(tui, { account: 'b@x.com' });
  request(tui, { account: 'b@x.com', model: 'claude-sonnet-4-6' });
  request(tui, { account: 'b@x.com', model: 'claude-sonnet-4-6', path: '/v1/messages/count_tokens' });
  assert.equal(tui.log.length, 4);
});

test('a minute apart, the same request is a new row', (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { tui } = makeTUI();
  request(tui);
  now += 30_000;
  request(tui);
  assert.equal(tui.log.length, 1, 'thirty seconds: folded');
  now += 61_000;
  request(tui);
  assert.equal(tui.log.length, 2, 'past a minute from the last one: a new row');
  assert.doesNotMatch(rows(tui)[0], /×/);
});

test('activityFold: false keeps one row per request', () => {
  const { tui } = makeTUI({ activityFold: false });
  for (let i = 0; i < 3; i++) request(tui);
  assert.equal(tui.log.length, 3);
  assert.ok(rows(tui).every(r => !r.includes('×')));
});

test('compact rows fold too, across paths', () => {
  const { tui } = makeTUI({ activityFormat: 'compact' });
  request(tui);
  request(tui, { path: '/v1/messages/count_tokens?beta=true' });
  assert.equal(tui.log.length, 1);
  assert.match(rows(tui)[0], /→ a@x\.com {2}[\d.]+s ×2$/);
});
