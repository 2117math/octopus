// 고정 서버(remoteServer) — 원장 2026-10-28 「최우선으로 PC2 로 가게 하고, PC1 에 옥토퍼스가 열려 있으면 물어보기」.
// 노트북에서 `octopus server` 를 켰다 끄면 그 사이에 띄운 claude 창이 노트북 서버를 보다가 전부 끊기던 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteServerOf, remoteClientEnv, remoteEnvLines } from '../src/claude-env.js';

const R = { url: 'http://192.168.68.20:3456', apiKey: 'tc-abc' };

test('remoteServerOf: 모양 검사·끝 슬래시 제거·없으면 null', () => {
  assert.deepEqual(remoteServerOf({ remoteServer: { url: 'http://192.168.68.20:3456/', apiKey: ' tc-abc ' } }), R);
  assert.deepEqual(remoteServerOf({ remoteServer: { url: 'https://octo.example.com' } }), { url: 'https://octo.example.com', apiKey: '' });
  assert.equal(remoteServerOf({}), null);
  assert.equal(remoteServerOf({ remoteServer: null }), null);
  assert.equal(remoteServerOf({ remoteServer: { url: '192.168.68.20:3456' } }), null, '스킴 없음');
  assert.equal(remoteServerOf({ remoteServer: { url: 'ftp://x' } }), null);
  assert.equal(remoteServerOf({ remoteServer: { url: 'http://x:1?y=1' } }), null, '쿼리 금지');
});

test('remoteClientEnv: base-URL + 키, 이 PC 의 loopback 프록시 변수만 걷어 냄, 계정 고정은 /tc-acct/', () => {
  const base = {
    PATH: 'p', HTTPS_PROXY: 'http://127.0.0.1:3456', http_proxy: 'http://localhost:3456',
    HTTP_PROXY: 'http://corp-proxy:8080', NODE_EXTRA_CA_CERTS: 'c.pem', TC_ACCT: 'a@x.com', ANTHROPIC_BASE_URL: 'http://localhost:3456',
  };
  const env = remoteClientEnv(R, base, { account: null, localPort: 3456 });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://192.168.68.20:3456');
  assert.equal(env.ANTHROPIC_API_KEY, 'tc-abc');
  assert.equal('HTTPS_PROXY' in env, false, '이 PC 프록시는 뺀다');
  assert.equal('http_proxy' in env, false);
  assert.equal(env.HTTP_PROXY, 'http://corp-proxy:8080', '다른 프록시는 그대로');
  assert.equal(env.NODE_EXTRA_CA_CERTS, 'c.pem');
  assert.equal('TC_ACCT' in env, false);
  assert.equal(base.HTTPS_PROXY, 'http://127.0.0.1:3456', '원본은 안 건드림');
  const pinned = remoteClientEnv(R, {}, { account: 'a b@x.com', localPort: 3456 });
  assert.equal(pinned.ANTHROPIC_BASE_URL, 'http://192.168.68.20:3456/tc-acct/a%20b%40x.com');
  const noKey = remoteClientEnv({ url: R.url, apiKey: '' }, { ANTHROPIC_API_KEY: 'keep' }, {});
  assert.equal(noKey.ANTHROPIC_API_KEY, 'keep', '키가 없으면 있던 값 그대로');
});

test('remoteEnvLines: export 줄 + 이 PC 프록시 unset', () => {
  const lines = remoteEnvLines(R, { account: null, localPort: 3456, env: { HTTPS_PROXY: 'http://127.0.0.1:3456', HTTP_PROXY: 'http://corp:8080' } });
  assert.deepEqual(lines, [
    "export ANTHROPIC_BASE_URL='http://192.168.68.20:3456'",
    "export ANTHROPIC_API_KEY='tc-abc'",
    'unset HTTPS_PROXY',
  ]);
  const pinned = remoteEnvLines(R, { account: 'a@x.com', env: {} });
  assert.equal(pinned[0], "export ANTHROPIC_BASE_URL='http://192.168.68.20:3456/tc-acct/a%40x.com'");
  assert.equal(pinned.at(-1), 'unset TC_ACCT');
});
