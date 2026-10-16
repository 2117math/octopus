import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// activityFormat: 'compact' drops the method and the path from activity rows
// (a plain messages call says nothing) and gives the session title the room;
// 'full', the default, is the row as it always was.

const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const SID = 'fa621427-a3d0-41c3-b7f4-d5f7f7021455';
const TITLE = 'Fix the login bug in the OAuth callback';

function makeTUI(activityFormat) {
  const am = { accounts: [], currentIndex: 0, switchThreshold: 0.98, getRoutes() { return []; } };
  const config = { proxy: { port: 1 }, accounts: [], routes: [], ...(activityFormat ? { activityFormat } : {}) };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.sessionTitles = /** @type {any} */ ({ enabled: true, width: 18, get: id => (id === SID ? TITLE : null) });
  return tui;
}

/** One request through the hooks the server calls; returns its log row. */
function request(tui, { path = '/v1/messages?beta=true', status = 200 } = {}) {
  tui.onRequestStart('r1', { method: 'POST', path, sessionId: SID });
  tui.onRequestModel('r1', { model: 'claude-opus-5' });
  tui.onRequestRouted('r1', { account: 'a@x.com' });
  tui.onRequestEnd('r1', { method: 'POST', path, account: 'a@x.com', status, model: 'claude-opus-5', sessionId: SID });
  return plain(tui.log[0].msg);
}

test('a compact row drops the messages path and widens the title', () => {
  const row = request(makeTUI('compact'));
  assert.doesNotMatch(row, /\/v1\/messages|POST/);
  assert.ok(row.includes(TITLE.slice(0, 31)), 'the default 18 widens to 32 columns');
  assert.match(row, /→ a@x\.com {2}\d+\.\ds$/, 'account, then the duration');
  assert.doesNotMatch(row, /✗/, 'a 2xx carries no mark');

  const count = request(makeTUI('compact'), { path: '/v1/messages/count_tokens?beta=true' });
  assert.match(count, / count \(/, 'a call other than messages keeps a short tag');
});

test('a compact row marks a non-2xx status in front of the duration', () => {
  const row = request(makeTUI('compact'), { status: 429 });
  assert.match(row, /→ a@x\.com {2}✗ 429 \d+\.\ds$/);
});

test('full, the default, is the row as it was', () => {
  for (const tui of [makeTUI(undefined), makeTUI('full')]) {
    const row = request(tui);
    assert.match(row, /^Fix the login bug  POST \/v1\/messages\?beta=true \(.+\) → a@x\.com \(200, \d+\.\ds\)$/);
  }
});
