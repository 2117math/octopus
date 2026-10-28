// [local patch 2026-10-24 원장] 구독 갱신일용 프로필 갱신기.
//
// 프로브(quotaProbeSeconds)와 무관하다: 프로브를 켜면 사용량 탐지 요청이 늘어나므로
// 꺼 둔 채로도 OAuth 프로필(/api/oauth/profile)의 구독 필드만 가끔 읽는다.
// 서버 시작 직후 한 번, 그 뒤 6시간마다 anthropic OAuth 계정마다 fetchProfile 을
// 불러 applyProfileData 로 저장한다(상태 파일에는 exportQuotaState 가 함께 남긴다).
// 토큰 갱신은 기존 경로(ensureTokenFresh)를 그대로 쓴다. 실패는 로그 한 줄뿐이다.
//
// [local patch 2026-10-28 원장] 결제 전(pendingPlan) 계정은 따로 10분마다 더 읽는다 — 결제가
// 되면 applyProfileData 가 자동으로 켜 주는데 6시간은 너무 길다. R(새로고침)·로그인 뒤에도
// 한 번(index.js reloadAccounts → refreshPending).

import { isAnthropicProbeTarget } from './prober.js';
import { safeLine } from './safe-text.js';

export const SUBSCRIPTION_REFRESH_MS = 6 * 60 * 60 * 1000;
export const SUBSCRIPTION_START_DELAY_MS = 5_000;
export const PENDING_PLAN_REFRESH_MS = 10 * 60 * 1000;

export class SubscriptionRefresher {
  /**
   * @param {any} accountManager
   * @param {{ profileFn: Function, intervalMs?: number, pendingIntervalMs?: number, startDelayMs?: number, concurrency?: number, timeoutMs?: number, log?: (line: string) => void }} opts
   */
  constructor(accountManager, { profileFn, intervalMs = SUBSCRIPTION_REFRESH_MS, pendingIntervalMs = PENDING_PLAN_REFRESH_MS, startDelayMs = SUBSCRIPTION_START_DELAY_MS, concurrency = 2, timeoutMs = 10_000, log = (/** @type {string} */ line) => console.log(line) } = /** @type {any} */ ({})) {
    this.am = accountManager;
    this.profileFn = profileFn;
    this.intervalMs = intervalMs;
    this.pendingIntervalMs = pendingIntervalMs;
    this.startDelayMs = startDelayMs;
    this.concurrency = Math.max(1, concurrency);
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** @type {any} */
    this._startTimer = null;
    /** @type {any} */
    this._timer = null;
    /** @type {any} */
    this._pendingTimer = null;
    this._running = null;
    this._runningPendingOnly = false;
    this._stopped = false;
  }

  /** 시작 직후 한 번(몇 초 뒤), 이어서 intervalMs 마다. 결제 전 계정은 pendingIntervalMs 마다 더. */
  start() {
    if (this._startTimer || this._timer) return;
    this._stopped = false;
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      this.refreshAll().catch(() => {});
      if (this._stopped) return;
      this._timer = setInterval(() => { this.refreshAll().catch(() => {}); }, this.intervalMs);
      this._timer.unref?.();
      this._pendingTimer = setInterval(() => { this.refreshPending().catch(() => {}); }, this.pendingIntervalMs);
      this._pendingTimer.unref?.();
    }, this.startDelayMs);
    this._startTimer.unref?.();
  }

  stop() {
    this._stopped = true;
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this._timer) clearInterval(this._timer);
    if (this._pendingTimer) clearInterval(this._pendingTimer);
    this._startTimer = null;
    this._timer = null;
    this._pendingTimer = null;
  }

  /** 결제 전 계정이 있을 때만 그 계정들의 프로필을 다시 읽는다(없으면 아무 일도 안 함). */
  refreshPending() {
    if (!this.am.accounts.some((/** @type {any} */ a) => a.pendingPlan && this._eligible(a))) return Promise.resolve();
    return this.refreshAll({ pendingOnly: true });
  }

  /** 대상 계정마다 한 번씩, 동시 concurrency 개. 이미 도는 중이면 그 실행을 돌려준다.
   *  @param {{ pendingOnly?: boolean }} [opts]  결제 전 계정만 */
  refreshAll({ pendingOnly = false } = {}) {
    if (this._running) {
      // 전체 갱신이 도는 중이면 그것이 결제 전 계정도 덮는다. 결제 전만 도는 중에 전체가
      // 요청되면 그 뒤에 이어서 돈다(6시간 주기를 건너뛰지 않게).
      return this._runningPendingOnly && !pendingOnly
        ? this._running.then(() => this.refreshAll({ pendingOnly }))
        : this._running;
    }
    this._runningPendingOnly = pendingOnly;
    this._running = (async () => {
      const targets = this.am.accounts.filter((/** @type {any} */ a) => this._eligible(a) && (!pendingOnly || a.pendingPlan));
      let next = 0;
      const worker = async () => {
        while (!this._stopped && next < targets.length) {
          const account = targets[next++];
          await this.refreshAccount(account);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, targets.length) }, worker));
    })().finally(() => { this._running = null; this._runningPendingOnly = false; });
    return this._running;
  }

  /** anthropic OAuth·자격 있음·죽은 refresh token 아님. Codex 등은 제외.
   *  꺼 둔(disabled) 계정도 포함 — 원장 2026-10-28, prober.js 의 같은 패치 참고. */
  _eligible(/** @type {any} */ account) {
    if (!isAnthropicProbeTarget(account)) return false;
    if (account._deadRefreshToken && account._deadRefreshToken === account.refreshToken) return false;
    return true;
  }

  async refreshAccount(/** @type {any} */ account) {
    try {
      await this.am.ensureTokenFresh(account.index);
      let profile = await this._withTimeout(this.profileFn(account.credential, account.routing ?? null));
      if (profile?.status === 401) {
        // 거부된 토큰: 강제 갱신 뒤 한 번만 다시(프로버와 같은 규칙).
        await this.am.ensureTokenFresh(account.index, true);
        profile = await this._withTimeout(this.profileFn(account.credential, account.routing ?? null));
      }
      if (!profile || profile.error) {
        this.log(`[Octopus] subscription refresh: "${safeLine(account.name, 64)}" skipped (${profile?.error || 'timed out'})`);
        return;
      }
      this.am.applyProfileData(account.index, profile);
    } catch (err) {
      this.log(`[Octopus] subscription refresh: "${safeLine(account?.name, 64)}" failed (${/** @type {any} */ (err)?.message || err})`);
    }
  }

  _withTimeout(/** @type {Promise<any>} */ promise) {
    return Promise.race([
      promise,
      new Promise(resolve => {
        const t = setTimeout(() => resolve(null), this.timeoutMs);
        t.unref?.();
      }),
    ]);
  }
}
