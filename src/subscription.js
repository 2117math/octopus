// [local patch 2026-10-24 원장] 계정별 월 구독 갱신일 계산·표시.
//
// 기준 = OAuth 프로필의 organization.subscription_created_at. 매달 같은 날·같은
// 시각(UTC 기준 순간)에 갱신되고, 그 달에 그날이 없으면 그 달 말일이다.
// 표시는 KST(M/D)와 D-n(당일 D-day).
//
// 세 함수는 대시보드 페이지에도 fn.toString()으로 실려 가므로(dashboard.js
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
 * [local patch 2026-10-24 원장] 원장이 알려 준 실제 결제일(renewDate) 기준 다음 갱신.
 * renewDate("YYYY-MM-DD", KST 달력) 의 '일'로 매달 되풀이하고, 그 달에 그날이 없으면
 * 말일이다. 오늘(KST)이 갱신일이면 D-day(daysLeft 0). 기준 날짜가 미래면 그 날짜 이전은
 * 건너뛴다. 갱신 시각은 해당 날짜 KST 자정.
 * @param {string|null|undefined} renewDate
 * @param {number} [now]
 * @returns {{ renewAt: number, daysLeft: number }|null}
 */
export function nextRenewalOnDate(renewDate, now) {
  var t = now == null ? Date.now() : now;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof renewDate === 'string' ? renewDate.trim() : '');
  if (!m || !Number.isFinite(t)) return null;
  var y0 = Number(m[1]), mo0 = Number(m[2]) - 1, day = Number(m[3]);
  var anchor = Date.UTC(y0, mo0, day);
  if (new Date(anchor).getUTCMonth() !== mo0) return null; // 2/30 같은 없는 날짜
  var KST = 9 * 3600 * 1000;
  var DAY = 86400000;
  var today = Math.floor((t + KST) / DAY);
  var base = Math.max(today, Math.floor(anchor / DAY));
  var b = new Date(base * DAY);
  var year = b.getUTCFullYear();
  var month = b.getUTCMonth();
  for (var i = 0; i < 14; i++) {
    var last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var candDay = Math.floor(Date.UTC(year, month, Math.min(day, last)) / DAY);
    if (candDay >= base) return { renewAt: candDay * DAY - KST, daysLeft: candDay - today };
    month += 1;
  }
  return null;
}

/**
 * 계정 줄·move 화면·대시보드가 쓰는 한 줄 문구와 경고 단계.
 * 정보가 없으면 null. level: 0 보통, 1 D-3 이하(주황), 2 당일(빨강) 또는 비활성 상태.
 * 원장이 입력한 renewDate(source 'manual')가 있으면 그것이 우선이고 경고색도 그때만 낸다.
 * 없으면 프로필 createdAt 계산값(source 'estimate')을 「(추정)」 꼬리와 함께 보통 단계로 보인다.
 * @param {{ createdAt?: string|number|null, status?: string|null, renewDate?: string|null }|null|undefined} sub
 * @param {number} [now]
 * @returns {{ text: string, level: number, renewAt: number|null, daysLeft: number|null, source: string|null }|null}
 */
export function subscriptionText(sub, now) {
  if (!sub) return null;
  var hasCreated = sub.createdAt != null && sub.createdAt !== '';
  var manual = sub.renewDate ? nextRenewalOnDate(sub.renewDate, now) : null;
  if (!hasCreated && !manual) return null;
  var status = sub.status == null ? '' : String(sub.status).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 24);
  if (status && status !== 'active') {
    return { text: '구독 상태: ' + status, level: 2, renewAt: null, daysLeft: null, source: null };
  }
  var r = manual || nextRenewal(sub.createdAt, now);
  if (!r) return null;
  var d = new Date(r.renewAt + 9 * 3600 * 1000);
  var md = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  var dn = r.daysLeft <= 0 ? 'D-day' : 'D-' + r.daysLeft;
  return {
    text: '구독 ' + md + ' ' + dn + (manual ? '' : ' (추정)'),
    level: !manual ? 0 : r.daysLeft <= 0 ? 2 : r.daysLeft <= 3 ? 1 : 0,
    renewAt: r.renewAt,
    daysLeft: r.daysLeft,
    source: manual ? 'manual' : 'estimate',
  };
}
