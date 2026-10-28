// 로그인 토큰을 잃지 않게: 끄기 전 갱신·저장 기다리기, 토큰 기록 (원장 2026-10-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createTokenLog, oauthErrorOf, settleTokenWork, tokenLogPathFor } from '../src/token-safety.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 'at-' + name, refreshToken: 'rt-' + name, expiresAt: Date.now() - 1000, ...extra };
}

test('토큰 기록 파일은 설정 파일 옆', () => {
  assert.equal(tokenLogPathFor('/x/teamclaude.json'), '/x/teamclaude-token.log');
  assert.equal(tokenLogPathFor('/x/conf'), '/x/conf-token.log');
});

test('토큰 기록: 시각을 붙여 한 줄씩, 줄바꿈 같은 제어 문자는 공백으로, 쓸 수 없어도 던지지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-tokenlog-'));
  const path = join(dir, 'teamclaude-token.log');
  const log = createTokenLog(path, { now: () => new Date(2026, 9, 27, 21, 42, 5) });
  log('a@gmail.com 갱신 거절 400 invalid_grant\n가짜 둘째 줄');
  log('서버 종료');
  assert.equal(await readFile(path, 'utf8'),
    '2026-10-27 21:42:05  a@gmail.com 갱신 거절 400 invalid_grant 가짜 둘째 줄\n2026-10-27 21:42:05  서버 종료\n');
  assert.doesNotThrow(() => createTokenLog(join(dir, 'no', 'such', 'dir', 'x.log'))('x'));
});

test('토큰 기록: 상한을 넘으면 .old 로 하나 남기고 새로 쓴다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-tokenlog-'));
  const path = join(dir, 'teamclaude-token.log');
  await writeFile(path, 'x'.repeat(50));
  createTokenLog(path, { maxBytes: 10 })('새 줄');
  assert.ok(existsSync(`${path}.old`));
  assert.match(await readFile(path, 'utf8'), /^\S+ \S+ {2}새 줄\n$/);
});

test('oauthErrorOf: 거절 본문의 OAuth 오류 코드와 설명', () => {
  const err = Object.assign(new Error('Token refresh failed (400): {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}'), { status: 400 });
  assert.deepEqual(oauthErrorOf(err), { code: 'invalid_grant', description: 'Refresh token not found or invalid' });
  assert.deepEqual(oauthErrorOf(new Error('Token refresh failed (403): {"error":{"type":"permission_error","message":"nope"}}')), { code: 'permission_error', description: 'nope' });
  assert.equal(oauthErrorOf(new Error('fetch failed')), null);
  assert.equal(oauthErrorOf(new Error('Token refresh failed (403): <html>blocked</html>')), null);
});

test('끄기: 진행 중인 갱신과, 그 갱신이 남기는 새 토큰 저장까지 기다린다', async () => {
  /** @type {(v: any) => void} */
  let mint = () => {};
  const am = new AccountManager([oauth('a')], 0.98, {
    refreshFn: () => new Promise(resolve => { mint = resolve; }),
  });
  /** @type {Set<Promise<unknown>>} */
  const saves = new Set();
  let saved = null;
  am.onTokenRefresh((idx, tokens) => {
    const save = new Promise(resolve => setTimeout(() => { saved = tokens.refreshToken; resolve(undefined); }, 30));
    saves.add(save);
    save.finally(() => saves.delete(save));
  });
  const renewing = am.ensureTokenFresh(0);
  const settling = settleTokenWork(am.accounts, saves, 5_000);
  // 갱신 응답이 늦게 와도
  setTimeout(() => mint({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 8 * 3600e3 }), 20);
  const r = await settling;
  assert.equal(saved, 'rt-new', '새 토큰이 저장된 뒤에야 끝난다');
  assert.deepEqual(r, { pending: 1, timedOut: false });
  await renewing;
});

test('끄기: 기다릴 것이 없으면 바로, 끝나지 않는 일은 상한에서 끊는다', async () => {
  assert.deepEqual(await settleTokenWork([{}, null], new Set(), 5_000), { pending: 0, timedOut: false });
  const t0 = Date.now();
  const r = await settleTokenWork([{ _refreshPromise: new Promise(() => {}) }], new Set(), 50);
  assert.deepEqual(r, { pending: 1, timedOut: true });
  assert.ok(Date.now() - t0 < 2_000);
});

test('onRefreshFailed: 토큰 거절(400)은 rejected, 일시 오류(503)는 아님 — 기록용', async () => {
  const fail = (/** @type {number} */ status, /** @type {string} */ body) => () => Promise.reject(Object.assign(new Error(`Token refresh failed (${status}): ${body}`), { status }));
  for (const [status, body, rejected, finalStatus] of [
    [400, '{"error":"invalid_grant"}', true, 'error'],
    [503, 'busy', false, 'active'],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98, { refreshFn: fail(status, body) });
    const seen = [];
    am.onRefreshFailed((account, err, info) => seen.push([account.name, err.status, info.rejected]));
    await am.ensureTokenFresh(0);
    assert.deepEqual(seen, [['a', status, rejected]]);
    assert.equal(am.accounts[0].status, finalStatus);
  }
});

test('onRefreshFailed 가 던져도 갱신 처리는 그대로(계정은 다시 로그인 필요로)', async () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    refreshFn: () => Promise.reject(Object.assign(new Error('Token refresh failed (400): {"error":"invalid_grant"}'), { status: 400 })),
  });
  am.onRefreshFailed(() => { throw new Error('log broke'); });
  await am.ensureTokenFresh(0);
  assert.equal(am.accounts[0].status, 'error');
});
