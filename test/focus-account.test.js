// [local patch 2026-10-27 원장] 집중 계정: 구독 마지막 날 한 계정에 몰아서 쓰려고 지정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { renameAccount, setFocusAccount, ConfigOpError } from '../src/config-ops.js';

const H = 3600e3;
const MODEL = 'claude-sonnet-5-5';
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function fleet(weekly = [0.50, 0.10, 0.20]) {
  const now = Date.now();
  const am = new AccountManager(
    weekly.map((_, i) => ({ name: `acct${i}`, type: 'oauth', accessToken: 'tok', refreshToken: 'r', accountUuid: `u${i}`, orgUuid: `o${i}` })),
    0.98, { distributeSessions: true, sessionAffinity: true });
  weekly.forEach((u, i) => {
    const q = am.accounts[i].quota;
    q.unified7d = u; q.unified7dReset = now + (50 + i) * H;
    q.unified5h = 0.3; q.unified5hReset = now + 2 * H;
  });
  return am;
}
const pick = (am, key, exclude = null) => am.getActiveAccount(exclude, MODEL, null, key)?.name;
const capture = fn => {
  const orig = console.log; const out = [];
  console.log = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return out;
};

test('집중 계정이 새 세션의 맨 앞이다(주간 사용률이 가장 높아도)', () => {
  const am = fleet([0.50, 0.10, 0.20]);
  assert.equal(pick(am, 'A/new1'), 'acct1', '집중 없음: 가장 한가한 계정');
  am.setFocusAccount('acct0');
  assert.equal(pick(am, 'A/new2'), 'acct0');
  // 한 계정 2개 제한(full)도 적용하지 않는다
  for (const k of ['B/1', 'B/2', 'B/3', 'B/4']) assert.equal(pick(am, k), 'acct0', k);
});

test('다른 계정에 고정된 세션도 다음 요청에서 집중 계정으로 옮겨진다', () => {
  const am = fleet();
  am.sessionTracker.touch('A/pinned', 1, 'unified7d');
  assert.equal(pick(am, 'A/pinned'), 'acct1', '집중 없음: 고정 유지');
  am.setFocusAccount('acct2');
  assert.equal(pick(am, 'A/pinned'), 'acct2');
});

test('집중 계정이 5h 한도에 걸리면 다른 계정이 이어받고, 풀리면 돌아온다(로그 한 줄씩)', () => {
  const am = fleet();
  am.setFocusAccount('acct0');
  assert.equal(pick(am, 'A/s'), 'acct0');
  assert.equal(am.focusInfo().state, 'on');
  am.accounts[0].quota.unified5h = 0.99;
  let name;
  const away = capture(() => { name = pick(am, 'A/s'); pick(am, 'A/s'); });
  assert.notEqual(name, 'acct0');
  assert.equal(am.focusInfo().state, 'away');
  assert.equal(away.filter(l => /Focus account "acct0" is out of reach/.test(l)).length, 1, '넘어감은 한 줄만');
  assert.equal(am.getStatus().focusState, 'away');
  am.accounts[0].quota.unified5h = 0.2;
  let back;
  const log = capture(() => { back = pick(am, 'A/s'); pick(am, 'A/s'); });
  assert.equal(back, 'acct0', '다음 요청부터 집중 계정으로');
  assert.equal(log.filter(l => /Focus account "acct0" is back/.test(l)).length, 1, '돌아옴은 한 줄만');
  assert.equal(am.focusInfo().state, 'on');
});

test('집중 계정이 rate limit/disabled 여도 일은 멈추지 않는다', () => {
  const am = fleet();
  am.setFocusAccount('acct0');
  am.accounts[0].disabled = true;
  assert.ok(pick(am, 'A/x'));
  assert.notEqual(pick(am, 'A/x'), 'acct0');
});

test('이미 시도한(exclude) 집중 계정은 건너뛴다(failover)', () => {
  const am = fleet();
  am.setFocusAccount('acct0');
  assert.notEqual(pick(am, 'A/f', new Set([0])), 'acct0');
});

test('해제하면 원래 규칙으로 돌아간다', () => {
  const am = fleet([0.50, 0.10, 0.20]);
  am.sessionTracker.touch('A/pinned', 1, 'unified7d');
  am.setFocusAccount('acct0');
  assert.equal(pick(am, 'A/pinned'), 'acct0');
  am.setFocusAccount(null);
  assert.equal(am.focusInfo(), null);
  assert.equal(am.getStatus().focusAccount, null);
  assert.equal(pick(am, 'A/brandnew'), 'acct1', '가장 한가한 계정(원래 규칙)');
});

test('없는 이름의 집중 계정은 아무 효과가 없다', () => {
  const am = fleet();
  am.setFocusAccount('ghost');
  assert.equal(am.focusInfo(), null);
  assert.equal(pick(am, 'A/new'), 'acct1');
});

test('/teamclaude/status JSON 의 focusAccount 와 attach 모드 표시', () => {
  const am = fleet();
  am.setFocusAccount('acct1');
  const st = am.getStatus();
  assert.equal(st.focusAccount, 'acct1');
  assert.equal(st.focusState, 'on');
  const remote = new RemoteAccountManager();
  remote.applyStatus(JSON.parse(JSON.stringify(st)));
  assert.deepEqual(remote.focusInfo(), { name: 'acct1', state: 'on' });
  remote.applyStatus({ ...JSON.parse(JSON.stringify(st)), focusState: 'away' });
  assert.equal(remote.focusInfo().state, 'away');
  remote.applyStatus({ ...JSON.parse(JSON.stringify(st)), focusAccount: null, focusState: null });
  assert.equal(remote.focusInfo(), null);
});

test('config-ops: 없는 계정 거부, 이름 바꾸면 따라간다', () => {
  const cfg = { accounts: [{ name: 'a@x.com' }, { name: 'b@x.com' }] };
  assert.throws(() => setFocusAccount(cfg, 'nobody'), ConfigOpError);
  assert.equal(cfg.focusAccount, undefined);
  assert.deepEqual(setFocusAccount(cfg, 'a@x.com'), { name: 'a@x.com' });
  assert.equal(cfg.focusAccount, 'a@x.com');
  renameAccount(cfg, 'a@x.com', 'alpha');
  assert.equal(cfg.focusAccount, 'alpha');
  setFocusAccount(cfg, null);
  assert.equal(cfg.focusAccount, undefined);
});

// ── TUI ────────────────────────────────────────────────────────

function tuiFor(am, extra = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {}, ...extra,
  });
  tui._paint = () => {};
  tui.running = true;
  return tui;
}
function frame(tui, width = 160) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const drawn = [];
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...a) => { const o = real(...a); drawn.push(strip(o)); return o; };
    tui.render(true);
    tui._renderAcct = real;
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('TUI: f 키(대문자 F 도)로 창이 열리고, Enter 로 집중 지정·같은 계정 다시 고르면 해제', async () => {
  const am = fleet();
  const calls = [];
  const tui = tuiFor(am, { setFocusAccount: async n => { calls.push(n); am.setFocusAccount(n); } });
  tui._key('f');
  assert.equal(tui.mode, 'focus');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  tui._key('F');
  assert.equal(tui.mode, 'focus');
  // 0번 줄은 「집중 끄기」, 커서는 첫 계정에서 시작
  assert.equal(tui.focus.rows[0].off, true);
  tui._key('down'); // acct1
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['acct1']);
  assert.equal(tui.mode, 'normal');
  assert.equal(am.focusInfo().name, 'acct1');
  // 같은 계정을 다시 고르면 해제 — 커서가 집중 계정에서 시작한다
  tui._key('f');
  assert.equal(tui.focus.rows[tui.focus.idx].name, 'acct1');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['acct1', null]);
  assert.equal(am.focusInfo(), null);
  // 맨 위 「집중 끄기」 줄
  am.setFocusAccount('acct2');
  tui._key('f'); tui._key('up'); tui._key('up'); tui._key('up'); tui._key('up');
  assert.equal(tui.focus.idx, 0);
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(am.focusInfo(), null);
});

test('TUI: 대문자 M 도 move 창을 연다', () => {
  const am = fleet();
  const tui = tuiFor(am);
  let opened = 0;
  tui._openMove = () => { opened++; };
  tui._key('M');
  tui._key('m');
  assert.equal(opened, 2);
});

test('TUI: 머리 줄과 계정 줄에 집중 표시, 한도 중이면 꼬리 안내', () => {
  const am = fleet();
  const tui = tuiFor(am);
  am.setFocusAccount('acct0');
  const rows = frame(tui);
  assert.ok(rows[0].trimStart().startsWith('◎'), rows[0]);
  assert.ok(!rows[1].trimStart().startsWith('◎'));
  let buf = '';
  tui._paint = x => { buf = x; };
  frame(tui);
  assert.ok(strip(buf).includes('🎯 집중 acct0'), '머리(Fleet) 줄에 집중 표시');
  am.accounts[0].quota.unified5h = 0.99;
  const seg = strip(tui._focusSeg());
  assert.equal(seg, '🎯 집중 acct0 (한도 — 잠시 다른 계정)');
  am.accounts[0].quota.unified5h = 0.1;
  assert.equal(strip(tui._focusSeg()), '🎯 집중 acct0');
  am.setFocusAccount(null);
  assert.equal(tui._focusSeg(), '');
});

// ── CLI ────────────────────────────────────────────────────────

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function setup(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const dir = await mkdtemp(join(tmpdir(), 'octopus-focus-'));
  const path = join(dir, 'config.json');
  const accounts = [
    { id: 'a-id', name: 'a@x.com', type: 'oauth', accountUuid: 'ua', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
    { id: 'b-id', name: 'b@x.com', type: 'oauth', accountUuid: 'ub', accessToken: 'bt', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
  ];
  await writeFile(path, JSON.stringify({ proxy: { port: server.address().port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com', accounts }));
  return { path, seen };
}

function runCli(configPath, cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit\n${stdout}\n${stderr}`)); }, 20_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('octopus focus: 저장하고 실행 중 서버에 reload 를 알린다(이름·번호), off 로 해제, 인자 없으면 현재 값', async t => {
  const { path, seen } = await setup(t);
  assert.match((await runCli(path, ['focus'])).stdout, /Focus account: none/);
  const set = await runCli(path, ['focus', 'b@x.com']);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).focusAccount, 'b@x.com');
  assert.deepEqual(seen, ['/teamclaude/reload']);
  assert.match((await runCli(path, ['focus'])).stdout, /Focus account: b@x.com/);
  assert.equal((await runCli(path, ['focus', '1'])).code, 0);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).focusAccount, 'a@x.com', '번호는 1부터');
  const off = await runCli(path, ['focus', 'off']);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).focusAccount, undefined);
  assert.equal(seen.length, 3);
});

test('octopus focus: 없는 계정은 거부하고 저장하지 않는다', async t => {
  const { path, seen } = await setup(t);
  const bad = await runCli(path, ['focus', 'nobody@x.com']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not found/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).focusAccount, undefined);
  assert.equal((await runCli(path, ['focus', '9'])).code, 1);
  assert.deepEqual(seen, []);
});
