// Host load for the dashboard's Host line: how much memory is in use, how much
// of it Windows has compressed, and the processes taking the most CPU. Sampled
// on a timer and cached. snapshot() never waits: the render path reads what the
// last sample left, and a sample that fails or times out keeps the one before.
//
// CPU is reported per process in units of one logical core (100 = one core
// fully busy), the way `ps` and `top` count it, so a runaway single-threaded
// process reads 100% whatever the core count. A process at HOG_CPU_PCT or more
// for HOG_AFTER_MS is flagged as a hog.

import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { safeLine } from './safe-text.js';

export const HOST_SAMPLE_MS = 60_000; // a PowerShell sample costs ~4 s of work on Windows; once a minute is plenty for a status line
export const HOG_CPU_PCT = 90;
export const HOG_AFTER_MS = 10 * 60_000;
const SAMPLE_TIMEOUT_MS = 10_000;
const TOP_N = 3;
const NAME_MAX = 32;
// A process listing is a few KB; anything past this is not one.
const OUTPUT_MAX = 256 * 1024;

// One PowerShell run, one JSON line out: the top processes by CPU from the
// formatted perf counters (PercentProcessorTime is per core, so it can pass
// 100 on a multi-threaded process), the logical core count, and the working
// set of the Memory Compression process (the compressed store), null when it
// cannot be read.
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$top = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 3 | ForEach-Object { @{ name = [string]$_.Name; pid = [int]$_.IDProcess; cpu = [double]$_.PercentProcessorTime } })",
  "$mc = Get-Process -Name 'Memory Compression' | Select-Object -First 1",
  '$compressed = $null',
  'if ($mc) { $compressed = [double]$mc.WorkingSet64 }',
  '@{ cores = [Environment]::ProcessorCount; top = $top; compressed = $compressed } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A process name fit to draw: a perf-counter instance suffix (`chrome#3`)
 *  and an `.exe` dropped, a path cut to its last segment, controls stripped.
 *  @param {unknown} name */
function cleanName(name) {
  if (typeof name !== 'string') return '';
  const base = name.split(/[\\/]/).pop() || '';
  return safeLine(base.replace(/#\d+$/, '').replace(/\.exe$/i, ''), NAME_MAX);
}

/** The top-process list off any source, held to its shape: a named process
 *  with a positive pid and a CPU figure, highest first, at most TOP_N.
 *  @param {unknown} list
 *  @returns {{ name: string, pid: number, cpuPct: number }[]} */
function cleanTop(list) {
  const rows = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
  return rows
    .map((/** @type {any} */ p) => ({ name: cleanName(p?.name), pid: Number(p?.pid), cpuPct: Number(p?.cpuPct ?? p?.cpu) }))
    .filter(p => p.name && Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(p.cpuPct) && p.cpuPct >= 0)
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, TOP_N);
}

/** The Windows script's output, or null when it is not the JSON it prints.
 *  @param {string} text */
export function parseWindowsSample(text) {
  let j;
  try { j = JSON.parse(String(text).trim()); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const compressed = num(j.compressed);
  const cores = num(j.cores);
  return {
    top: cleanTop(j.top),
    compressedBytes: compressed != null && compressed > 0 ? compressed : null,
    cores: cores != null && cores > 0 ? Math.round(cores) : null,
  };
}

/** `ps` output (`PID %CPU COMMAND` under a header line), top processes first.
 *  @param {string} text
 *  @param {number|null} [skipPid] the ps run itself */
export function parsePsSample(text, skipPid = null) {
  const rows = [];
  for (const line of String(text).split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+([\d.,]+)\s+(.+?)\s*$/.exec(line);
    if (!m || Number(m[1]) === skipPid) continue;
    rows.push({ pid: Number(m[1]), cpuPct: Number(m[2].replace(',', '.')), name: m[3] });
  }
  return { top: cleanTop(rows), compressedBytes: null };
}

/** MemAvailable from /proc/meminfo, in bytes, or null.
 *  @param {string} text */
export function parseMeminfo(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text));
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * A host snapshot off the wire (the attached TUI reads the server's), held to
 * the shape this module produces; null when it has no memory figures.
 * @param {unknown} raw
 */
export function normalizeHostSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {any} */ (raw);
  const total = num(r.totalBytes);
  const free = num(r.freeBytes);
  if (total == null || total <= 0 || free == null || free < 0) return null;
  const compressed = num(r.compressedBytes);
  const hogs = new Set((Array.isArray(r.top) ? r.top : []).filter((/** @type {any} */ p) => p?.hog === true).map((/** @type {any} */ p) => Number(p.pid)));
  return {
    at: num(r.at),
    totalBytes: total,
    freeBytes: Math.min(free, total),
    compressedBytes: compressed != null && compressed > 0 ? compressed : null,
    cores: num(r.cores),
    top: cleanTop(r.top).map(p => ({ ...p, hog: hogs.has(p.pid) })),
  };
}

export class HostStats {
  /**
   * Everything the sampler touches is injectable, so a test can feed it a
   * process listing without spawning one.
   * @param {{ platform?: string, spawn?: typeof nodeSpawn, now?: () => number,
   *   totalmem?: () => number, freemem?: () => number, cpuCount?: () => number,
   *   readFile?: (path: string, enc: 'utf8') => Promise<string>,
   *   enabled?: () => boolean, timeoutMs?: number }} [opts]
   */
  constructor({
    platform = process.platform, spawn = nodeSpawn, now = Date.now,
    totalmem = os.totalmem, freemem = os.freemem, cpuCount = () => os.cpus().length,
    readFile = nodeReadFile, enabled = () => true, timeoutMs = SAMPLE_TIMEOUT_MS,
  } = {}) {
    this._platform = platform;
    this._spawn = spawn;
    this._now = now;
    this._totalmem = totalmem;
    this._freemem = freemem;
    this._cpuCount = cpuCount;
    this._readFile = readFile;
    this._enabled = enabled;
    this._timeoutMs = timeoutMs;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._timer = null;
    /** @type {import('node:child_process').ChildProcess | null} */
    this._child = null;
    this._sampling = false;
    // The last `ps` run's pid, so the listing leaves itself out.
    /** @type {number|null} */
    this._lastPid = null;
    // `${pid}:${name}` → when that process was first seen at HOG_CPU_PCT or
    // more, continuously. Keyed with the name so a reused pid starts over.
    /** @type {Map<string, number>} */
    this._highSince = new Map();
    /** @type {{ at: number, totalBytes: number, freeBytes: number, compressedBytes: number|null, cores: number|null, top: { name: string, pid: number, cpuPct: number, hog: boolean }[] } | null} */
    this._snap = null;
  }

  /** Sample now (memory at once, processes when the run returns), then every
   *  `intervalMs`. The timer does not hold the process open. */
  start(intervalMs = HOST_SAMPLE_MS) {
    if (this._timer) return;
    this._memoryOnly();
    this.sample();
    this._timer = setInterval(() => { this.sample(); }, intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._child) { try { this._child.kill(); } catch { /* already gone */ } this._child = null; }
  }

  /** The last sample, or null before the first. Never waits. */
  snapshot() {
    return this._snap;
  }

  /** Memory figures alone, so the line has something to show before the first
   *  process listing lands. */
  _memoryOnly() {
    const total = this._totalmem();
    const free = this._freemem();
    if (!(total > 0) || !(free >= 0)) return;
    this._snap = {
      at: this._now(),
      totalBytes: total,
      freeBytes: Math.min(free, total),
      compressedBytes: this._snap?.compressedBytes ?? null,
      cores: this._snap?.cores ?? null,
      top: this._snap?.top ?? [],
    };
  }

  /** One sample. Resolves once it is in (or has failed); one at a time. */
  async sample() {
    if (this._sampling || !this._enabled()) return;
    this._sampling = true;
    try {
      const total = this._totalmem();
      let free = this._freemem();
      let procs = null;
      if (this._platform === 'win32') {
        const out = await this._run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]);
        procs = out == null ? null : parseWindowsSample(out);
      } else {
        if (this._platform === 'linux') {
          try { free = parseMeminfo(await this._readFile('/proc/meminfo', 'utf8')) ?? free; } catch { /* os.freemem stands */ }
        }
        const args = this._platform === 'darwin' ? ['-Ao', 'pid,pcpu,comm', '-r'] : ['-eo', 'pid,pcpu,comm', '--sort=-pcpu'];
        const out = await this._run('ps', args);
        procs = out == null ? null : parsePsSample(out, this._lastPid);
      }
      const now = this._now();
      const prev = this._snap;
      const top = procs ? this._track(procs.top, now) : (prev?.top ?? []);
      if (!(total > 0) || !(free >= 0)) return;
      this._snap = {
        at: now,
        totalBytes: total,
        freeBytes: Math.min(free, total),
        compressedBytes: procs ? (procs.compressedBytes ?? null) : (prev?.compressedBytes ?? null),
        cores: (procs && 'cores' in procs ? procs.cores : null) ?? prev?.cores ?? (this._cpuCount() || null),
        top,
      };
    } catch {
      // A sampler that throws keeps the previous snapshot.
    } finally {
      this._sampling = false;
    }
  }

  /** Mark each listed process a hog once it has held HOG_CPU_PCT for
   *  HOG_AFTER_MS; forget a process that dropped below or left the list.
   *  @param {{ name: string, pid: number, cpuPct: number }[]} top
   *  @param {number} now */
  _track(top, now) {
    const seen = new Set();
    const out = top.map(p => {
      const key = `${p.pid}:${p.name}`;
      seen.add(key);
      if (p.cpuPct < HOG_CPU_PCT) { this._highSince.delete(key); return { ...p, hog: false }; }
      if (!this._highSince.has(key)) this._highSince.set(key, now);
      return { ...p, hog: now - /** @type {number} */ (this._highSince.get(key)) >= HOG_AFTER_MS };
    });
    for (const key of this._highSince.keys()) if (!seen.has(key)) this._highSince.delete(key);
    return out;
  }

  /** Run a command to completion: its stdout, or null when it failed, ran past
   *  the timeout or printed more than a listing would. Never rejects.
   *  @param {string} cmd
   *  @param {string[]} args
   *  @returns {Promise<string|null>} */
  _run(cmd, args) {
    return new Promise(resolve => {
      /** @type {any} */
      let child;
      try {
        child = this._spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve(null);
        return;
      }
      this._child = child;
      this._lastPid = child?.pid ?? null;
      let out = '';
      let done = false;
      const finish = (/** @type {string|null} */ v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this._child === child) this._child = null;
        resolve(v);
      };
      const kill = () => { try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(() => { kill(); finish(null); }, this._timeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (/** @type {string} */ d) => {
        out += d;
        if (out.length > OUTPUT_MAX) { kill(); finish(null); }
      });
      child.on('error', () => finish(null));
      child.on('close', (/** @type {number|null} */ code) => finish(code === 0 ? out : null));
    });
  }
}
