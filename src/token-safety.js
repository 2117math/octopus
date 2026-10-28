// [local patch 2026-10-28 원장 「bluejin911 다시 로그인했는데 저녁에 로그인이 없어졌다」]
//
// 로그인 토큰은 갱신할 때마다 새것으로 바뀌고 옛것은 그 자리에서 죽는다. 그래서
// 새 토큰을 받고도 설정 파일에 못 남기면, 파일에는 죽은 옛 토큰만 남고 다음에
// 그것으로 갱신하는 순간 거절돼 그 계정이 「다시 로그인 필요」가 된다.
//
// - settleTokenWork: 서버를 끌 때 진행 중인 갱신과 새 토큰 저장이 끝날 때까지
//   (상한까지) 기다린다. 전에는 끄기가 이것들을 기다리지 않고 바로 나갔다.
// - createTokenLog: 갱신 성공·실패·거절, 설정 파일에서 받은 새 토큰(로그인·새로고침),
//   서버 시작·종료를 설정 파일 옆 `teamclaude-token.log` 에 한 줄씩 남긴다. 화면의
//   알림은 서버를 다시 켜면 사라져서, 언제 왜 풀렸는지 나중에 알 길이 없었다.
//   토큰 값은 남기지 않는다.

import { appendFileSync, renameSync, statSync } from 'node:fs';

/** 끄기가 갱신·저장을 기다리는 상한. 갱신 한 번은 보통 1초 안에 끝난다. */
export const TOKEN_SETTLE_MS = 15_000;

/** 이 크기를 넘으면 `.old` 로 하나만 남기고 새로 쓴다. */
const TOKEN_LOG_MAX_BYTES = 1_000_000;

/**
 * The token log beside a config file: `teamclaude.json` → `teamclaude-token.log`.
 * @param {string} configPath
 */
export function tokenLogPathFor(configPath) {
  return configPath.endsWith('.json') ? configPath.replace(/\.json$/, '-token.log') : `${configPath}-token.log`;
}

/**
 * A line writer for the token log. Never throws: a log that cannot be written
 * must not take a renewal or a shutdown down with it.
 * @param {string} path
 * @param {{ now?: () => Date, maxBytes?: number }} [opts]
 * @returns {(line: string) => void}
 */
export function createTokenLog(path, { now = () => new Date(), maxBytes = TOKEN_LOG_MAX_BYTES } = {}) {
  return (line) => {
    try {
      try { if (statSync(path).size > maxBytes) renameSync(path, `${path}.old`); } catch { /* not there yet */ }
      appendFileSync(path, `${localStamp(now())}  ${String(line).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 400)}\n`, { mode: 0o600 });
    } catch { /* see above */ }
  };
}

/** @param {Date} d */
function localStamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The OAuth error a rejected renewal carried (`invalid_grant`, ...), read from
 * the body refreshAccessToken puts in its message. Null when there is none.
 * @param {unknown} err
 * @returns {{ code: string|null, description: string|null } | null}
 */
export function oauthErrorOf(err) {
  const m = String(/** @type {any} */ (err)?.message || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const code = typeof j.error === 'string' ? j.error : typeof j.error?.type === 'string' ? j.error.type : null;
    const description = typeof j.error_description === 'string' ? j.error_description
      : typeof j.error?.message === 'string' ? j.error.message : null;
    return code || description ? { code, description } : null;
  } catch {
    return null;
  }
}

/**
 * Wait, up to `ms`, for every renewal in flight and every save of a renewed
 * token. A renewal that lands queues its save before its own promise settles
 * (the account manager calls the persist listener first), so the saves are
 * read after the renewals.
 * @param {Array<{ _refreshPromise?: Promise<unknown> | null } | null | undefined>} accounts
 * @param {Set<Promise<unknown>>} saves
 * @param {number} ms
 * @returns {Promise<{ pending: number, timedOut: boolean }>}
 */
export async function settleTokenWork(accounts, saves, ms) {
  const deadline = Date.now() + ms;
  const refreshing = accounts.map(a => a?._refreshPromise).filter(Boolean);
  const pending = refreshing.length + saves.size;
  if (pending === 0) return { pending, timedOut: false };
  let timedOut = false;
  const within = async (/** @type {Promise<unknown>} */ p) => {
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; return; }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(undefined); }, left); });
    try { await Promise.race([p, late]); } finally { clearTimeout(timer); }
  };
  if (refreshing.length) await within(Promise.allSettled(refreshing));
  if (saves.size) await within(Promise.allSettled([...saves]));
  return { pending, timedOut };
}
