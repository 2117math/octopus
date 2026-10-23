import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  classifyLeftovers, killLeftovers, parseProcessList, scanLeftovers, summarizeLeftovers,
  KIND_BROWSER, KIND_SEARCH, KIND_SERVER, KIND_SCRIPT,
} from '../src/cleanup.js';
import { TUI, formatHostLine } from '../src/tui.js';

// 안 쓰는 작업 정리: 가짜 프로세스 목록으로 4종 판정과 「안 끄는 것」, 브라우저 묶음, 정리 창 문자열.

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const MIN = 60_000;
const MB = 1024 * 1024;
const ESC = String.fromCharCode(27);
const plain = s => s.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');

const proc = (pid, ppid, name, cmd, ageMin, memMB = 10) =>
  ({ pid, ppid, name, cmd, createdMs: NOW - ageMin * MIN, memBytes: memMB * MB });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

test('판정 4종: 헤드리스 브라우저·주인 없는 검색·테스트 웹 서버·멈춘 검사 스크립트', () => {
  const list = [
    proc(1, 0, 'explorer.exe', 'explorer.exe', 900),
    proc(100, 1, 'msedge.exe', `"${EDGE}" --headless=new --remote-debugging-port=9222 about:blank`, 5, 80),
    proc(200, 999, 'rg.exe', 'rg -n foo C:\\Claude', 11, 30),
    proc(300, 1, 'python.exe', 'python -m http.server 8123', 31, 20),
    proc(400, 1, 'node.exe', 'node scripts/dev/verify_dashboard/verify_x.js', 45, 60),
    proc(500, 1, 'node.exe', 'node --test test/', 31, 60),
  ];
  const got = classifyLeftovers(list, NOW, [9000]);
  assert.deepEqual(got.map(g => [g.kind, g.pid]), [
    [KIND_BROWSER, 100], [KIND_SEARCH, 200], [KIND_SERVER, 300], [KIND_SCRIPT, 400], [KIND_SCRIPT, 500],
  ]);
  assert.equal(got[0].startedAt, NOW - 5 * MIN);
  assert.match(got[1].cmd, /^rg -n foo/);
});

test('안 끄는 것: 일반 엣지·claude·octopus·부모 살아 있는 find·29분 된 http.server·Octopus 자신', () => {
  const list = [
    proc(1, 0, 'explorer.exe', 'explorer.exe', 900),
    proc(100, 1, 'msedge.exe', `"${EDGE}"`, 300, 200),                                   // 원장이 쓰는 창
    proc(101, 100, 'msedge.exe', `"${EDGE}" --headless --type=renderer`, 300),            // --type= 딸린 것은 본체가 아님
    proc(110, 1, 'claude.exe', 'claude --headless', 600),
    proc(120, 1, 'node.exe', 'node C:\\Claude\\113 Octopus\\src\\index.js --test', 600),
    proc(130, 1, 'chrome.exe', 'chrome --headless C:\\octopus\\x', 10),                  // 명령줄에 octopus
    proc(200, 1, 'find.exe', 'find . -name x', 600),                                      // 부모(1)가 살아 있음
    proc(210, 1, 'rg.exe', 'rg x', 9),                                                    // 10분 미만
    proc(300, 1, 'python.exe', 'python -m http.server', 29),
    proc(400, 1, 'node.exe', 'node verify_a.js', 29),
    proc(9000, 8000, 'node.exe', 'node --test', 600),                                     // Octopus 자신
    proc(9001, 8000, 'node.exe', 'node --test', 600),                                     // 그 부모
  ];
  assert.deepEqual(classifyLeftovers(list, NOW, [9000, 9001]), []);
});

test('브라우저는 딸린 --headless 프로세스까지 묶고 메모리를 합친다', () => {
  const list = [
    proc(100, 1, 'chrome.exe', 'chrome --headless=new', 20, 100),
    proc(101, 100, 'chrome.exe', 'chrome --headless=new --type=gpu-process', 20, 150),
    proc(102, 100, 'chrome.exe', 'chrome --headless=new --type=renderer', 20, 250),
    proc(103, 100, 'crashpad.exe', 'crashpad_handler', 20, 900),                          // --headless 아님: 묶지 않음
    proc(104, 7, 'chrome.exe', 'chrome --headless=new --type=renderer', 20, 700),          // 다른 부모
  ];
  const [b] = classifyLeftovers(list, NOW, []);
  assert.deepEqual(b.children, [101, 102]);
  assert.equal(b.memMB, 500);
  assert.deepEqual(summarizeLeftovers([b, { ...b, memMB: 524 }]), { count: 2, memMB: 1024 });
});

test('parseProcessList: 한 건짜리 객체·배열·깨진 입력', () => {
  const one = '{"ProcessId":5,"ParentProcessId":1,"Name":"a.exe","CommandLine":"a -x","Created":1000,"WorkingSetSize":2048}';
  assert.deepEqual(parseProcessList(one), [{ pid: 5, ppid: 1, name: 'a.exe', cmd: 'a -x', createdMs: 1000, memBytes: 2048 }]);
  assert.equal(parseProcessList(`[${one},${one.replace('5', '6')}]`).length, 2);
  assert.equal(parseProcessList('not json'), null);
  assert.equal(parseProcessList('[{"ProcessId":0}]').length, 0);
});

test('killLeftovers: 딸린 것 먼저, 본체 나중, 실패는 세지 않는다', () => {
  const calls = [];
  const items = [
    { kind: KIND_BROWSER, pid: 100, startedAt: 1, memMB: 500, cmd: 'c', children: [101, 102] },
    { kind: KIND_SERVER, pid: 300, startedAt: 1, memMB: 20, cmd: 'p', children: [] },
  ];
  const r = killLeftovers(items, { kill: pid => { calls.push(pid); if (pid === 300) throw new Error('EPERM'); } });
  assert.deepEqual(calls, [101, 102, 100, 300]);
  assert.deepEqual(r, { killed: 1, failed: 1, memMB: 500 });
});

test('scanLeftovers: Windows 가 아니면 null, 가짜 PowerShell 출력은 판정까지', async () => {
  assert.equal(await scanLeftovers({ platform: 'linux' }), null);
  const json = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: 'msedge.exe', CommandLine: 'msedge --headless', Created: NOW - 5 * MIN, WorkingSetSize: 80 * MB },
  ]);
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.stdout.on('end', () => child.emit('close', 0));
    setImmediate(() => child.stdout.end(json));
    return child;
  };
  const got = await scanLeftovers({ platform: 'win32', spawn, now: () => NOW, selfPids: [] });
  assert.equal(got.length, 1);
  assert.equal(got[0].memMB, 80);
});

test('Host 줄 안내: 대상이 있으면 주황 [x] 정리 N개 용량, 없으면 흐린 [x] 정리, 자리가 없으면 안내만 빠진다', () => {
  const GIB = 1024 ** 3;
  const snap = { totalBytes: 32 * GIB, freeBytes: 16 * GIB, compressedBytes: null, top: [] };
  assert.equal(formatHostLine(snap, 120, null), formatHostLine(snap, 120), '안내 없음이면 기존 줄 그대로');
  const on = formatHostLine(snap, 120, { count: 3, memMB: 410 });
  assert.match(plain(on), /· {2}\[x\] 정리 3개 0\.4GB$/);
  assert.ok(on.includes(`${ESC}[38;5;208m[x] 정리 3개`), '주황');
  assert.match(plain(formatHostLine(snap, 120, {})), /\[x\] 정리$/);
  assert.equal(plain(formatHostLine(snap, 40, { count: 3, memMB: 410 })).includes('정리'), false);
});

function makeTUI(over = {}) {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0, switchThreshold: 0.98, getRoutes() { return []; },
  };
  const config = { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [] };
  const tui = new TUI({
    accountManager: am, config, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    cleanupPlatform: 'win32', ...over,
  });
  tui.render = () => {};
  return tui;
}

test('TUI 정리 창: x 로 열고 목록 문자열을 그린 뒤 y 로 끄고 결과 한 줄을 남긴다', async () => {
  const items = [
    { kind: KIND_BROWSER, pid: 100, startedAt: NOW - 5 * MIN, memMB: 500, cmd: 'msedge --headless=new --remote-debugging-port=9222', children: [101] },
    { kind: KIND_SERVER, pid: 300, startedAt: NOW - 40 * MIN, memMB: 400, cmd: 'python -m http.server 8123', children: [] },
  ];
  const killed = [];
  const tui = makeTUI({ cleanupScan: async () => items, cleanupKill: pid => { killed.push(pid); } });
  tui.running = true;
  tui._key('x');
  assert.equal(tui.mode, 'cleanup');
  await new Promise(r => setImmediate(r));
  assert.equal(tui.cleanup.stage, 'list');
  const lines = [];
  tui._renderCleanup(lines, 120);
  const text = plain(lines.join('\n'));
  assert.match(text, /안 쓰는 작업 정리/);
  assert.match(text, /2개 · 메모리 0\.9GB/);
  assert.match(text, /화면 없는 테스트용 브라우저\s+\d\d\/\d\d \d\d:\d\d\s+500MB\s+msedge --headless=new/);
  assert.match(plain(tui._renderFooter()), /y 모두 끄기\s+Esc 닫기/);

  tui._key('y');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(killed, [101, 100, 300]);
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.log[0].msg, '2개 껐습니다 · 메모리 0.9GB 확보');
});

test('TUI 정리 창: 대상이 없으면 안내하고, 끄기 직전에 사라진 것은 건드리지 않으며, Windows 밖·attach 에서는 키가 없다', async () => {
  const none = makeTUI({ cleanupScan: async () => [] });
  none._key('x');
  await new Promise(r => setImmediate(r));
  const lines = [];
  none._renderCleanup(lines, 100);
  assert.match(plain(lines.join('\n')), /정리할 작업이 없습니다/);
  none._key('esc');
  assert.equal(none.mode, 'normal');

  // 창을 연 뒤 다른 프로그램이 같은 pid 를 얻은 경우(시작 시각이 다름): 끄지 않는다.
  const item = { kind: KIND_SERVER, pid: 300, startedAt: 1000, memMB: 20, cmd: 'p', children: [] };
  let n = 0;
  const killed = [];
  const reused = makeTUI({
    cleanupScan: async () => (n++ === 0 ? [item] : [{ ...item, startedAt: 2000 }]),
    cleanupKill: pid => { killed.push(pid); },
  });
  reused._key('x');
  await new Promise(r => setImmediate(r));
  reused._key('y');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(killed, []);

  assert.equal(makeTUI({ cleanupPlatform: 'linux' })._cleanupAvailable(), false);
  assert.equal(makeTUI({ remote: true })._cleanupAvailable(), false);
  const linux = makeTUI({ cleanupPlatform: 'linux' });
  linux._key('x');
  assert.equal(linux.mode, 'normal');
  assert.doesNotMatch(plain(linux._renderFooter()), /정리/);
  assert.match(plain(makeTUI()._renderFooter()), /x 정리/);
});
