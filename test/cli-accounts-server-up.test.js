// `octopus accounts` 는 서버가 켜져 있으면 토큰을 갱신하지 않는다 (원장 2026-10-28).
// 갱신하면 서버가 들고 있는 토큰이 죽어 그 계정이 「다시 로그인 필요」가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 20_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('서버가 켜져 있으면 만료된 토큰을 갱신하지 않고, 설정 파일의 요금제로 보여 준다', async () => {
  // Only a listener on the port: `accounts` tells a running server by a TCP connect.
  const server = createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const dir = await mkdtemp(join(tmpdir(), 'octopus-accounts-'));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      proxy: { port, apiKey: 'tc-test' },
      upstream: 'https://api.anthropic.com',
      upstreamProxy: false,
      accounts: [{
        id: '11111111-1111-4111-8111-111111111111', name: 'held@example.com', type: 'oauth', source: 'login',
        accessToken: 'at-held', refreshToken: 'rt-held', expiresAt: Date.now() - 60_000, hasClaudeMax: true,
      }],
    }));
    const res = await runCli(configPath, ['accounts']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /held@example\.com \(Claude Max, token renewed by the running server, login\)/);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(disk.accounts[0].refreshToken, 'rt-held');
    assert.equal(disk.accounts[0].accessToken, 'at-held');
  } finally {
    await new Promise(resolve => server.close(() => resolve(undefined)));
  }
});
