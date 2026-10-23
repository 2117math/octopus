import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRenewalOnDate, subscriptionText } from '../src/subscription.js';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { TUI } from '../src/tui.js';
import { renderDashboardHtml } from '../src/dashboard.js';

// [local patch 2026-10-24 원장] 실제 결제일 renewDate 수동 입력 우선, 프로필 계산값은 「(추정)」.

const KST = 9 * 3600_000;
const CREATED = '2026-07-30T23:01:00Z'; // 프로필 기준: 10/31 로 계산되지만 실제는 10/27
const kstDate = ms => { const d = new Date(ms + KST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');
const NOW = Date.parse('2026-10-24T03:00:00Z'); // KST 10/24 12:00

test('renewDate: 그 날짜의 일로 매달 반복, 과거 기준도 미래 기준도 된다', () => {
  const r = nextRenewalOnDate('2026-09-27', NOW);
  assert.equal(kstDate(r.renewAt), '10/27');
  assert.equal(r.daysLeft, 3);
  assert.equal(r.renewAt, Date.parse('2026-10-26T15:00:00Z'), 'KST 자정');
  // 기준이 한참 전이어도 같은 일이 이어진다
  assert.equal(kstDate(nextRenewalOnDate('2025-01-28', NOW).renewAt), '10/28');
  // 달이 넘어간 뒤에는 다음 달
  assert.equal(kstDate(nextRenewalOnDate('2026-09-27', Date.parse('2026-10-28T03:00:00Z')).renewAt), '11/27');
  // 미래 기준 날짜는 그 날짜 이전 달로 되돌아가지 않는다
  const fut = nextRenewalOnDate('2026-12-05', NOW);
  assert.equal(kstDate(fut.renewAt), '12/5');
  assert.equal(fut.daysLeft, 42);
});

test('renewDate: 당일은 D-day(0), 말일 보정, 윤년, 잘못된 값은 null', () => {
  assert.equal(nextRenewalOnDate('2026-10-24', NOW).daysLeft, 0);
  assert.equal(nextRenewalOnDate('2026-09-24', Date.parse('2026-10-23T20:00:00Z')).daysLeft, 0, 'KST 10/24 05:00 도 같은 날');
  assert.equal(nextRenewalOnDate('2026-08-31', Date.parse('2026-09-05T00:00:00Z')).renewAt, Date.parse('2026-09-29T15:00:00Z'), '9월은 30일');
  assert.equal(kstDate(nextRenewalOnDate('2026-08-31', Date.parse('2027-02-05T00:00:00Z')).renewAt), '2/28');
  assert.equal(kstDate(nextRenewalOnDate('2026-08-31', Date.parse('2028-02-05T00:00:00Z')).renewAt), '2/29');
  assert.equal(kstDate(nextRenewalOnDate('2026-08-31', Date.parse('2026-12-31T20:00:00Z')).renewAt), '1/31', '연말을 넘긴다');
  for (const bad of [null, '', '2026-02-30', '2026-13-01', '10/27', 'garbage', 20261027]) assert.equal(nextRenewalOnDate(bad, NOW), null, String(bad));
});

test('표시: renewDate 가 있으면 확정(source manual), 없으면 (추정) 꼬리(source estimate)', () => {
  const manual = subscriptionText({ createdAt: CREATED, renewDate: '2026-09-27', status: 'active' }, NOW);
  assert.equal(manual.text, '구독 10/27 D-3');
  assert.equal(manual.source, 'manual');
  assert.equal(manual.level, 1, '확정 D-3 은 주황');
  const est = subscriptionText({ createdAt: CREATED, status: 'active' }, NOW);
  assert.equal(est.text, '구독 10/31 D-7 (추정)');
  assert.equal(est.source, 'estimate');
  assert.equal(est.level, 0);
  assert.equal(subscriptionText({ createdAt: CREATED, status: 'active' }, Date.parse('2026-10-31T00:00:00Z')).level, 0, '추정은 D-day 여도 경고색 없음');
  assert.equal(subscriptionText({ createdAt: CREATED, renewDate: '2026-09-24', status: 'active' }, NOW).level, 2, '확정 당일은 빨강');
  // 프로필이 없어도 renewDate 만으로 표시
  assert.equal(subscriptionText({ renewDate: '2026-09-28' }, NOW).text, '구독 10/28 D-4');
  // 잘못된 renewDate 는 무시하고 추정으로
  assert.equal(subscriptionText({ createdAt: CREATED, renewDate: 'oops' }, NOW).source, 'estimate');
  assert.equal(subscriptionText({ renewDate: 'oops' }, NOW), null);
  // 비활성 상태는 그대로 우선
  assert.equal(subscriptionText({ createdAt: CREATED, renewDate: '2026-09-27', status: 'canceled' }, NOW).text, '구독 상태: canceled');
});

test('status JSON subscription 에 source 와 renewDate', () => {
  const am = new AccountManager([
    oauth('m@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active', renewDate: '2026-09-27' }),
    oauth('e@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' }),
    oauth('n@x.com'),
  ], 0.98);
  const sub = am.subscriptionStatus.bind(am);
  const m = sub(am.accounts[0], NOW);
  assert.equal(m.source, 'manual');
  assert.equal(m.renewDate, '2026-09-27');
  assert.equal(m.daysLeft, 3);
  assert.equal(kstDate(m.renewAt), '10/27');
  const e = sub(am.accounts[1], NOW);
  assert.equal(e.source, 'estimate');
  assert.equal(e.renewDate, null);
  assert.equal(kstDate(e.renewAt), '10/31');
  assert.equal(sub(am.accounts[2], NOW), null);
  assert.equal(am.getStatus().accounts[0].subscription.source, 'manual');
});

test('TUI: 확정은 색 단계 · 추정은 회색 꼬리', () => {
  const am = new AccountManager([
    oauth('m@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active', renewDate: '2026-09-27' }),
    oauth('e@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' }),
  ], 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const real = Date.now;
  Date.now = () => NOW;
  try {
    const row = i => tui._renderAcct(i, 10, true, [], [], {}, false);
    assert.ok(row(0).includes('\x1b[38;5;208m · 구독 10/27 D-3'), '확정 D-3 주황');
    assert.ok(plain(row(1)).endsWith(' · 구독 10/31 D-7 (추정)'));
    assert.ok(!row(1).includes('\x1b[38;5;208m'), '추정은 주황 아님');
  } finally { Date.now = real; }
});

test('reload: 디스크의 renewDate 를 실행 중 계정에 바로 반영하고, 지우면 추정으로 돌아간다', async () => {
  const am = new AccountManager([oauth('a@x.com', { subscriptionCreatedAt: CREATED, subscriptionStatus: 'active' })], 0.98);
  const id = am.accounts[0].id;
  assert.equal(am.subscriptionStatus(am.accounts[0], NOW).source, 'estimate');
  const withDate = { accounts: [{ ...oauth('a@x.com'), id, renewDate: '2026-09-27' }] };
  const cfg = { accounts: withDate.accounts.map(a => ({ ...a })) };
  await syncAccountsFromDisk(withDate, cfg, am);
  assert.equal(am.accounts[0].renewDate, '2026-09-27');
  assert.equal(am.subscriptionStatus(am.accounts[0], NOW).source, 'manual');
  assert.equal(cfg.accounts[0].renewDate, '2026-09-27', '저장용 설정 사본에도 남는다');
  const cleared = { accounts: [{ ...oauth('a@x.com'), id }] };
  const cfg2 = { accounts: [{ ...cfg.accounts[0] }] };
  await syncAccountsFromDisk(cleared, cfg2, am);
  assert.equal(am.accounts[0].renewDate, null);
  assert.equal(cfg2.accounts[0].renewDate, undefined);
  assert.equal(am.subscriptionStatus(am.accounts[0], NOW).source, 'estimate');
});

test('대시보드 페이지가 날짜 계산 헬퍼를 싣는다', () => {
  assert.ok(renderDashboardHtml().includes('function nextRenewalOnDate'));
});

// ── CLI: octopus renew ──────────────────────────────────────────

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function setup(t, accounts) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const dir = await mkdtemp(join(tmpdir(), 'octopus-renew-'));
  const path = join(dir, 'config.json');
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

const accts = () => [
  { id: 'a-id', name: 'a@x.com', type: 'oauth', accountUuid: 'ua', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
  { id: 'b-id', name: 'b@x.com', type: 'oauth', accountUuid: 'ub', accessToken: 'bt', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
];

test('octopus renew: 이름으로 저장하고 실행 중 서버에 reload 를 알린다', async t => {
  const { path, seen } = await setup(t, accts());
  const res = await runCli(path, ['renew', 'a@x.com', '2026-10-27']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Set the renewal date of "a@x.com" to 2026-10-27/);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.accounts[0].renewDate, '2026-10-27');
  assert.equal(saved.accounts[1].renewDate, undefined);
  assert.deepEqual(seen, ['/teamclaude/reload']);
});

test('octopus renew: 번호(1부터)로 지정, clear 로 지움, 잘못된 입력은 거절', async t => {
  const { path } = await setup(t, accts());
  assert.equal((await runCli(path, ['renew', '2', '2026-10-28'])).code, 0);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).accounts[1].renewDate, '2026-10-28');
  const cleared = await runCli(path, ['renew', 'b@x.com', 'clear']);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).accounts[1].renewDate, undefined);
  const bad = await runCli(path, ['renew', 'a@x.com', '2026-02-30']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a date/);
  assert.equal((await runCli(path, ['renew', 'nobody', '2026-10-27'])).code, 1);
  assert.equal((await runCli(path, ['renew'])).code, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).accounts[0].renewDate, undefined, '거절된 입력은 저장하지 않는다');
});
