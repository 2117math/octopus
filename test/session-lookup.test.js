import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { sessionColorCode } from '../src/session-color.js';

// GET /teamclaude/session?id=<uuid>: the account one session is on, for a
// status line that knows its own session id, and `octopus whoami` on top of it.

const HOUR = 3600_000;
const OPUS = 'claude-opus-5';
const SID = 'fa621427-a3d0-41c3-b7f4-d5f7f7021455';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

async function withServer(fn) {
  const am = new AccountManager([oauth('a@x.com'), oauth('mimath0626')], 0.98, { distributeSessions: true });
  am.beginSession(SID, { sessionId: SID, model: OPUS, clientPinned: false });
  am.recordSession(SID, 1, OPUS);
  am.endSession(SID);
  const config = { proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] }, upstream: 'http://127.0.0.1:9' };
  const proxy = createProxyServer(am, config, { sessionTitle: id => (id === SID ? 'Fix the login bug' : null) });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: 'close', ...headers } });
  try {
    await fn({ am, get, port });
  } finally {
    proxy.close();
  }
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, CLAUDE_SESSION_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('GET /teamclaude/session names the account a session is on, in its own colour', async () => {
  await withServer(async ({ get }) => {
    const res = await get(`/teamclaude/session?id=${SID}`, { 'x-api-key': PROXY_KEY });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, SID);
    assert.equal(body.title, 'Fix the login bug');
    assert.equal(body.account, 1);
    assert.equal(body.accountName, 'mimath0626');
    assert.equal(body.color, sessionColorCode(SID), 'the SGR code the TUI paints it in');
    assert.equal(body.model, OPUS);
    assert.equal(body.clientPinned, false);
    assert.equal(typeof body.active, 'boolean');
    assert.equal(typeof body.lastSeen, 'number');

    const unknown = await get(`/teamclaude/session?id=${UNKNOWN}`, { 'x-api-key': PROXY_KEY });
    assert.equal(unknown.status, 404);
    assert.equal(typeof (await unknown.json()).error, 'string');
    assert.equal((await get('/teamclaude/session?id=not-a-uuid', { 'x-api-key': PROXY_KEY })).status, 400);
    assert.equal((await get('/teamclaude/session', { 'x-api-key': PROXY_KEY })).status, 400);
    assert.equal((await get(`/teamclaude/session?id=${SID}`, { 'x-api-key': CLIENT_KEY })).status, 403,
      'a tenant does not read whose session is where');
  });
});

test('octopus whoami prints the account, state, model family and age', async () => {
  await withServer(async ({ port }) => {
    const dir = await mkdtemp(join(tmpdir(), 'octopus-whoami-'));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ proxy: { port, apiKey: PROXY_KEY }, upstream: 'https://api.anthropic.com', upstreamProxy: false, accounts: [] }));
    const ok = await runCli(configPath, ['whoami', '--session', SID]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^mimath0626 \((active|idle), opus, \d+s ago\)\n$/);
    const json = await runCli(configPath, ['whoami', SID, '--json']);
    assert.equal(JSON.parse(json.stdout).accountName, 'mimath0626');
    const missing = await runCli(configPath, ['whoami', UNKNOWN]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /knows no session/);
    const bad = await runCli(configPath, ['whoami']);
    assert.equal(bad.code, 1, 'no id and no CLAUDE_SESSION_ID');
    assert.match(bad.stderr, /Usage: octopus whoami/);
  });
});
