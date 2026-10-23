// [local patch 2026-10-24 원장] 계정별 월 구독 갱신일 계산·표시.
//
// 기준 = OAuth 프로필의 organization.subscription_created_at. 매달 같은 날·같은
// 시각(UTC 기준 순간)에 갱신되고, 그 달에 그날이 없으면 그 달 말일이다.
// 표시는 KST(M/D)와 D-n(당일 D-day).
//
// 두 함수는 대시보드 페이지에도 fn.toString()으로 실려 가므로(dashboard.js
// SHARED_HELPERS) 바깥 스코프를 참조하지 않는 자기완결 함수여야 한다.

/**
 * 지금 이후 가장 가까운 월 갱신 시각.
 * @param {string|number|null|undefined} createdAt  subscription_created_at (ISO 또는 ms)
 * @param {number} [now]
 * @returns {{ renewAt: number, daysLeft: number }|null}
 */
export function nextRenewal(createdAt, now) {
  var t = now == null ? Date.now() : now;
  var created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(t)) return null;
  var c = new Date(created);
  var day = c.getUTCDate();
  var year = new Date(t).getUTCFullYear();
  var month = new Date(t).getUTCMonth();
  var renewAt = NaN;
  // 이번 달 후보가 이미 지났거나 가입 시각 이전이면 다음 달로. 12번이면 충분하다.
  for (var i = 0; i < 14; i++) {
    var last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var cand = Date.UTC(year, month, Math.min(day, last),
      c.getUTCHours(), c.getUTCMinutes(), c.getUTCSeconds(), c.getUTCMilliseconds());
    if (cand > t && cand > created) { renewAt = cand; break; }
    month += 1;
  }
  if (!Number.isFinite(renewAt)) return null;
  var KST = 9 * 3600 * 1000;
  var DAY = 86400000;
  var daysLeft = Math.floor((renewAt + KST) / DAY) - Math.floor((t + KST) / DAY);
  return { renewAt: renewAt, daysLeft: daysLeft };
}

/**
 * 계정 줄·move 화면·대시보드가 쓰는 한 줄 문구와 경고 단계.
 * 정보가 없으면 null. level: 0 보통, 1 D-3 이하(주황), 2 당일(빨강) 또는 비활성 상태.
 * @param {{ createdAt?: string|number|null, status?: string|null }|null|undefined} sub
 * @param {number} [now]
 * @returns {{ text: string, level: number, renewAt: number|null, daysLeft: number|null }|null}
 */
export function subscriptionText(sub, now) {
  if (!sub || sub.createdAt == null || sub.createdAt === '') return null;
  var status = sub.status == null ? '' : String(sub.status).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 24);
  if (status && status !== 'active') {
    return { text: '구독 상태: ' + status, level: 2, renewAt: null, daysLeft: null };
  }
  var r = nextRenewal(sub.createdAt, now);
  if (!r) return null;
  var d = new Date(r.renewAt + 9 * 3600 * 1000);
  var md = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  var dn = r.daysLeft <= 0 ? 'D-day' : 'D-' + r.daysLeft;
  return {
    text: '구독 ' + md + ' ' + dn,
    level: r.daysLeft <= 0 ? 2 : r.daysLeft <= 3 ? 1 : 0,
    renewAt: r.renewAt,
    daysLeft: r.daysLeft,
  };
}
