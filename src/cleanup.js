// 안 쓰는 작업 정리 (원장 2026-10-24): 작업자들이 남기고 간 프로그램을 찾아 TUI 에서
// 한 번에 끈다. Windows 전용이다. 규칙 원본은 C:\Claude\tools\cleanup_leftovers.ps1 이고
// 같은 판정을 순수 함수 classifyLeftovers 로 옮겼다. 프로세스 목록은 비동기로 받아
// (타임아웃 10초) TUI 를 멈추지 않는다.
//
// 끄는 대상은 전부 「화면 없는·주인 없는」 것만이다.
//   1) 화면 없는 테스트용 브라우저: msedge/chrome 중 명령줄에 --headless, --type= 없는 본체
//   2) 주인 없는 파일 검색: find/grep/rg 중 부모가 이미 없고 10분 넘게 도는 것
//   3) 테스트용 웹 서버: python 의 http.server 가 30분 넘게 도는 것
//   4) 멈춘 검사 스크립트: node 가 verify_*.js 또는 --test 를 30분 넘게 돌리는 것
// 절대 안 끈다: Octopus 자신과 그 부모, 이름이 claude 인 프로세스, 명령줄에 octopus 가
// 있는 것, --headless 가 없는 브라우저(원장이 쓰는 창).

import { spawn as nodeSpawn } from 'node:child_process';

export const KIND_BROWSER = '화면 없는 테스트용 브라우저';
export const KIND_SEARCH = '주인 없는 파일 검색';
export const KIND_SERVER = '테스트용 웹 서버';
export const KIND_SCRIPT = '멈춘 검사 스크립트';

const MIN = 60_000;
const SEARCH_AFTER_MS = 10 * MIN;
const SERVER_AFTER_MS = 30 * MIN;
const SCRIPT_AFTER_MS = 30 * MIN;
const SCAN_TIMEOUT_MS = 10_000;
// 프로세스 목록 JSON 은 명령줄까지 합쳐 수백 KB 가 될 수 있다.
const OUTPUT_MAX = 4 * 1024 * 1024;
const MB = 1024 * 1024;

const KIND_ORDER = [KIND_BROWSER, KIND_SEARCH, KIND_SERVER, KIND_SCRIPT];

// 한 번의 PowerShell 실행, 한 줄의 JSON. 시작 시각은 시간대와 무관하게 에포크 밀리초로 받는다.
export const LIST_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '@(Get-CimInstance Win32_Process | ForEach-Object { @{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Name = [string]$_.Name; CommandLine = [string]$_.CommandLine; Created = $(if ($_.CreationDate) { [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); WorkingSetSize = [double]$_.WorkingSetSize } }) | ConvertTo-Json -Compress -Depth 3',
].join('; ');

/** 프로세스 한 줄 (PowerShell JSON 의 한 원소).
 *  @typedef {{ pid: number, ppid: number, name: string, cmd: string, createdMs: number, memBytes: number }} Proc */

/** 한 건의 정리 대상.
 *  @typedef {{ kind: string, pid: number, startedAt: number, memMB: number, cmd: string, children: number[] }} Leftover */

const finite = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** LIST_SCRIPT 의 출력을 프로세스 목록으로. JSON 이 아니면 null.
 *  @param {string} text
 *  @returns {Proc[]|null} */
export function parseProcessList(text) {
  let j;
  try { j = JSON.parse(String(text).trim()); } catch { return null; }
  const rows = Array.isArray(j) ? j : (j && typeof j === 'object' ? [j] : null);
  if (!rows) return null;
  /** @type {Proc[]} */
  const out = [];
  for (const r of rows) {
    const pid = Number(r?.ProcessId ?? r?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      ppid: Number(r?.ParentProcessId ?? r?.ppid) || 0,
      name: typeof r?.Name === 'string' ? r.Name : (typeof r?.name === 'string' ? r.name : ''),
      cmd: typeof r?.CommandLine === 'string' ? r.CommandLine : (typeof r?.cmd === 'string' ? r.cmd : ''),
      createdMs: finite(r?.Created ?? r?.createdMs),
      memBytes: finite(r?.WorkingSetSize ?? r?.memBytes),
    });
  }
  return out;
}

/** 어느 종류의 정리 대상인가. 아니면 null. 자기 자신·claude·octopus 는 호출 쪽에서 먼저 거른다.
 *  @param {Proc} p @param {number} ageMs @param {Set<number>} alive */
function kindOf(p, ageMs, alive) {
  const name = p.name.toLowerCase();
  const cmd = p.cmd;
  if ((name === 'msedge.exe' || name === 'chrome.exe') && /--headless/.test(cmd) && !/--type=/.test(cmd)) return KIND_BROWSER;
  if ((name === 'find.exe' || name === 'grep.exe' || name === 'rg.exe') && !alive.has(p.ppid) && ageMs > SEARCH_AFTER_MS) return KIND_SEARCH;
  if (/^python/.test(name) && /http\.server/.test(cmd) && ageMs > SERVER_AFTER_MS) return KIND_SERVER;
  if (name === 'node.exe' && (/verify_[a-z0-9_]+\.js/i.test(cmd) || /\s--test(\s|$)/.test(cmd)) && ageMs > SCRIPT_AFTER_MS) return KIND_SCRIPT;
  return null;
}

/**
 * 프로세스 목록에서 정리 대상을 가려낸다. 순수 함수 — 아무것도 끄지 않는다.
 * 브라우저는 딸린 --headless 프로세스의 pid 를 children 에 담고 메모리를 합친다.
 * @param {Proc[]} list
 * @param {number} now 에포크 밀리초
 * @param {Iterable<number>} [selfPids] 절대 안 끄는 pid (Octopus 자신과 그 부모)
 * @returns {Leftover[]}
 */
export function classifyLeftovers(list, now, selfPids = []) {
  const self = new Set(selfPids);
  const alive = new Set(list.map(p => p.pid));
  /** @type {Leftover[]} */
  const found = [];
  for (const p of list) {
    if (self.has(p.pid)) continue;
    if (/claude/i.test(p.name) || /octopus/i.test(p.cmd)) continue;
    const ageMs = p.createdMs > 0 ? now - p.createdMs : 0;
    const kind = kindOf(p, ageMs, alive);
    if (!kind) continue;
    let mem = p.memBytes;
    /** @type {number[]} */
    const children = [];
    if (kind === KIND_BROWSER) {
      for (const c of list) {
        if (c.ppid === p.pid && c.pid !== p.pid && !self.has(c.pid) && /--headless/.test(c.cmd)) {
          children.push(c.pid);
          mem += c.memBytes;
        }
      }
    }
    found.push({ kind, pid: p.pid, startedAt: p.createdMs, memMB: Math.round(mem / MB), cmd: p.cmd.replace(/\s+/g, ' ').trim(), children });
  }
  return found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.startedAt - b.startedAt);
}

/** 대상 수와 메모리 합(MB). 화면의 `[x] 정리 3개 0.4GB` 에 쓴다.
 *  @param {Leftover[]} items */
export function summarizeLeftovers(items) {
  return { count: items.length, memMB: items.reduce((s, i) => s + i.memMB, 0) };
}

/** `0.4GB` 꼴. @param {number} memMB */
export function formatGB(memMB) {
  return `${(memMB / 1024).toFixed(1)}GB`;
}

/**
 * 지금 프로세스 목록을 받아 정리 대상을 돌려준다. Windows 밖이거나 실패하면 null.
 * 기다리지 않고(비동기) 10초를 넘기면 포기한다.
 * @param {{ platform?: string, spawn?: typeof nodeSpawn, now?: () => number,
 *   selfPids?: number[], timeoutMs?: number }} [opts]
 * @returns {Promise<Leftover[]|null>}
 */
export function scanLeftovers({
  platform = process.platform, spawn = nodeSpawn, now = Date.now,
  selfPids = [process.pid, process.ppid], timeoutMs = SCAN_TIMEOUT_MS,
} = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    /** @type {any} */
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let done = false;
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    const finish = (/** @type {Leftover[]|null} */ v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => { kill(); finish(null); }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (/** @type {string} */ d) => {
      out += d;
      if (out.length > OUTPUT_MAX) { kill(); finish(null); }
    });
    child.on('error', () => finish(null));
    child.on('close', (/** @type {number|null} */ code) => {
      if (code !== 0) { finish(null); return; }
      const list = parseProcessList(out);
      finish(list ? classifyLeftovers(list, now(), selfPids) : null);
    });
  });
}

/**
 * 대상을 끈다. 브라우저는 딸린 프로세스를 먼저, 본체를 나중에. Windows 에서 process.kill 은
 * 곧바로 강제 종료다. 이미 사라진 프로세스는 껐다고 세지 않는다.
 * @param {Leftover[]} items
 * @param {{ kill?: (pid: number) => void }} [opts]
 * @returns {{ killed: number, failed: number, memMB: number }}
 */
export function killLeftovers(items, { kill = pid => { process.kill(pid); } } = {}) {
  let killed = 0;
  let failed = 0;
  let memMB = 0;
  for (const it of items) {
    for (const c of it.children) { try { kill(c); } catch { /* 이미 끝났거나 권한 없음 — 본체가 기준 */ } }
    try { kill(it.pid); killed++; memMB += it.memMB; } catch { failed++; }
  }
  return { killed, failed, memMB };
}
