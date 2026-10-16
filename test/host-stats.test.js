import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HostStats, HOG_AFTER_MS, parsePsSample, normalizeHostSnapshot } from '../src/host-stats.js';
import { formatHostLine, TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The Host line: memory in use (coloured like the quota bars), how much is
// compressed, and the busiest processes, a long-running hog in red. The
// sampler runs one process listing per tick and caches what it read.

const GIB = 1024 ** 3;
const ESC = String.fromCharCode(27);
const SGR = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const plain = s => s.replace(SGR, '');

const snap = (over = {}) => ({
  totalBytes: 32 * GIB, freeBytes: 8.9 * GIB, compressedBytes: 3.9 * GIB,
  top: [
    { name: 'find', pid: 11, cpuPct: 100, hog: true },
    { name: 'python', pid: 12, cpuPct: 99.6, hog: false },
    { name: 'OneDrive', pid: 13, cpuPct: 6.2, hog: false },
  ],
  ...over,
});

test('the RAM figure takes the four bar colours by the share in use', () => {
  const colourOf = (/** @type {number} */ usedShare) => {
    const line = formatHostLine(snap({ freeBytes: (1 - usedShare) * 32 * GIB, top: [] }), 120);
    return new RegExp(`RAM ${ESC}\\[([0-9;]+)m`).exec(line)?.[1];
  };
  assert.equal(colourOf(0.40), '32', 'under half: green');
  assert.equal(colourOf(0.60), '33', 'under three quarters: yellow');
  assert.equal(colourOf(0.80), '38;5;208', 'under nine tenths: orange');
  assert.equal(colourOf(0.95), '31', 'the rest: red');
});

test('the line reads RAM, free and compressed, then the CPU list; a hog is red with a mark', () => {
  const line = formatHostLine(snap(), 120);
  assert.equal(plain(line), ' Host  RAM 72% (8.9 GB free · 3.9 GB compressed)  ·  CPU  find 100%!  python 100%  OneDrive 6%');
  assert.ok(line.includes(`${ESC}[31mfind 100%!`), 'the hog is red');
  assert.ok(!line.includes(`${ESC}[31mpython`), 'a busy process that is not a hog is not');
});

test('no compressed figure, no compressed text', () => {
  const line = plain(formatHostLine(snap({ compressedBytes: null }), 120));
  assert.match(line, /RAM 72% \(8\.9 GB free\)  ·  CPU/);
  assert.doesNotMatch(line, /compressed/);
});

test('a narrow line drops CPU entries from the end first, then the details', () => {
  const full = plain(formatHostLine(snap(), 200));
  const at = (/** @type {number} */ w) => plain(formatHostLine(snap(), w));
  assert.equal(at(full.length + 1), full, 'fits: whole');
  assert.match(at(full.length), /CPU  find 100%!  python 100%$/, 'one column short: the last process goes');
  assert.match(at(72), /compressed\)  ·  CPU  find 100%!$/);
  assert.equal(at(55), ' Host  RAM 72% (8.9 GB free · 3.9 GB compressed)', 'no process fits: no CPU segment');
  assert.equal(at(40), ' Host  RAM 72% (8.9 GB free)');
  assert.equal(at(20), ' Host  RAM 72%');
  assert.equal(at(10), '', 'nothing fits: no line');
  assert.equal(formatHostLine(null, 120), '', 'no snapshot: no line');
});

/** A spawn stand-in whose child prints `out` and exits with `code`. */
function fakeSpawn(out, code = 0) {
  const calls = [];
  const spawn = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    calls.push([cmd, args]);
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.pid = 4242;
    child.stdout.on('end', () => child.emit('close', code));
    setImmediate(() => child.stdout.end(typeof out === 'function' ? out() : out));
    return child;
  };
  return { spawn, calls };
}

test('the Windows sampler reads the PowerShell JSON line into a snapshot', async () => {
  const json = JSON.stringify({
    cores: 16,
    top: [
      { name: 'python#1', pid: 32184, cpu: 103 },
      { name: 'OneDrive.Sync.Service', pid: 2136, cpu: 6 },
      { name: 'evil\u001b[2Jname', pid: 7, cpu: 1 },
    ],
    compressed: 745824256,
  });
  const { spawn, calls } = fakeSpawn(json);
  const hs = new HostStats({ platform: 'win32', spawn: /** @type {any} */ (spawn), totalmem: () => 32 * GIB, freemem: () => 16 * GIB, now: () => 1000 });
  assert.equal(hs.snapshot(), null, 'nothing before the first sample');
  await hs.sample();
  assert.equal(calls[0][0], 'powershell.exe');
  assert.deepEqual(calls[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const s = hs.snapshot();
  assert.equal(s.totalBytes, 32 * GIB);
  assert.equal(s.freeBytes, 16 * GIB);
  assert.equal(s.compressedBytes, 745824256);
  assert.equal(s.cores, 16);
  assert.deepEqual(s.top.map(p => [p.name, p.pid, p.cpuPct, p.hog]), [
    ['python', 32184, 103, false],
    ['OneDrive.Sync.Service', 2136, 6, false],
    ['evil name', 7, 1, false],
  ], 'instance suffix dropped, controls stripped, highest first');
});

test('a process held at a core for ten minutes becomes a hog; a failed run keeps the last snapshot', async () => {
  const clock = { t: 0 };
  let out = JSON.stringify({ cores: 8, top: [{ name: 'find', pid: 5, cpu: 100 }, { name: 'idle', pid: 6, cpu: 2 }], compressed: null });
  const { spawn } = fakeSpawn(() => out);
  const hs = new HostStats({ platform: 'win32', spawn: /** @type {any} */ (spawn), totalmem: () => 8 * GIB, freemem: () => 4 * GIB, now: () => clock.t });
  await hs.sample();
  assert.equal(hs.snapshot().top[0].hog, false, 'just started');
  clock.t += HOG_AFTER_MS;
  await hs.sample();
  assert.equal(hs.snapshot().top[0].hog, true, 'ten minutes on');
  out = 'not json';
  await hs.sample();
  assert.equal(hs.snapshot().top[0].hog, true, 'a bad run changes nothing');
  out = JSON.stringify({ cores: 8, top: [{ name: 'find', pid: 5, cpu: 40 }], compressed: null });
  await hs.sample();
  assert.equal(hs.snapshot().top[0].hog, false, 'below the line: forgotten');
});

test('the POSIX listing parses ps output and leaves the ps run out', () => {
  const ps = '  PID %CPU COMMAND\n  901 99.5 /usr/bin/python3\n 4242 50.0 ps\n  77  3.1 node\n';
  assert.deepEqual(parsePsSample(ps, 4242).top.map(p => [p.name, p.pid, p.cpuPct]), [['python3', 901, 99.5], ['node', 77, 3.1]]);
});

test('attach mode draws the Host line from the server\'s snapshot', () => {
  assert.equal(normalizeHostSnapshot({ totalBytes: 'x' }), null, 'no memory figures: nothing');
  const am = new RemoteAccountManager();
  am.applyStatus({ accounts: [{ name: 'a@x.com', quota: {} }], host: snap({ top: [{ name: 'find\u001b[2J', pid: 11, cpuPct: 100, hog: true }] }) });
  const tui = new TUI({
    accountManager: am, remote: true, config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  assert.equal(plain(tui._hostLine(120)), ' Host  RAM 72% (8.9 GB free · 3.9 GB compressed)  ·  CPU  find 100%!');
  tui.config.hostLine = false;
  assert.equal(tui._hostLine(120), '', 'hostLine: false turns it off');
});
