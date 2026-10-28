import { createWriteStream } from 'node:fs';
import { gatingUtilization } from './model.js';
import { importCredentials, fetchProfile, formatMoney } from './oauth.js';
import {
  sameIdentity,
  findUpsertTarget,
  updateAccountEntry,
  canUpsertOAuthAccount,
  oauthIdentityFields,
} from './identity.js';
import { configIndexFor, managerAccountFor, markAccountRemoved, markAccountAdded } from './account-pairing.js';
import { PROVIDERS, providerOf, isSubscriptionAccount, upstreamFor } from './provider.js';
import { mintAccountId } from './account-id.js';
import { formatPercent, heldResetCredits, showSessionRow } from './status-renderer.js';
import { subscriptionText, isPrePlanProfile } from './subscription.js';
import { scanLeftovers, killLeftovers, summarizeLeftovers, formatGB } from './cleanup.js';
import { resolveMaxUsage, resolveMaxSpendMinor, switchThresholdDiffs, modelLabel, EFFORT_SEP, weeklyBucketForModel, modelFamily } from './model.js';
import { parseProxyUrl, proxyToUrl, describeProxy, describeSelfProxy, resolveUpstreamProxy, setUpstreamProxy, getUpstreamProxy, localListener, isSelfProxy } from './upstream-proxy.js';
import { describeRouting, parseRoutingUrl, routingToUrl, checkRouting } from './account-routing.js';
import { sanitizeText, safeLine } from './safe-text.js';
// The setting rules live in one module; the CLI, the MCP tools and this screen
// all read them from there, so they cannot drift apart (#426).
import { MAX_PROBE_SECONDS, ROUTE_COLORS, ConfigOpError, setRebalance } from './config-ops.js';
import { rebalanceSetting } from './account-manager.js';
import { sessionColorCode } from './session-color.js';
import { DEFAULT_WIDTH as DEFAULT_TITLE_WIDTH } from './session-titles.js';
import { isLocalUpstream } from './provider.js';
import { hyperlink, clipboardSequence } from './osc.js';
/** @typedef {import('./login-flow.js').LoginPrompt} LoginPrompt */

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');

// Repaint cadence.
//
// The spinner is drawn only alongside in-flight requests, so animating it while
// the proxy is idle wakes the process twice a second to redraw a frame nobody
// can tell apart from the last one. On a laptop that is enough to keep the
// machine from going to sleep (#134), which is a poor trade for animating
// nothing. Tick fast only while there is something to animate; otherwise tick
// slowly, just often enough that elapsed times and quota countdowns stay honest.
const SPIN_MS = 500;
const IDLE_TICK_MS = 5_000;
// Even when the composed frame is unchanged, repaint occasionally: the terminal
// is shared state, and anything that writes over it (a stray warning, a resumed
// job) would otherwise leave the screen corrupted until the next real change.
const FORCE_REPAINT_MS = 60_000;
// Longest quota-probe interval the settings screen accepts. Node's timers take
// a 32-bit millisecond delay: past 2,147,483 s setInterval overflows and fires
// every millisecond, which is a probe storm rather than a slow probe. A week
// is far under that and already longer than any quota window.
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REV = `${ESC}7m`;   // reverse video — used for the BIOS-style settings cursor

// [local patch 2026-10-27 원장] 한/영·Shift 상태와 상관없이 단축키가 먹게:
// 두벌식 자모를 그 자리의 영문 소문자로, 대문자는 소문자로 바꾼다.
// 글자 입력 화면(input·login)에는 쓰지 않는다.
const HANGUL_KEYS = {
  'ㅂ': 'q', 'ㅃ': 'q', 'ㅈ': 'w', 'ㅉ': 'w', 'ㄷ': 'e', 'ㄸ': 'e', 'ㄱ': 'r', 'ㄲ': 'r',
  'ㅅ': 't', 'ㅆ': 't', 'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅒ': 'o', 'ㅔ': 'p', 'ㅖ': 'p',
  'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g', 'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
  'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b', 'ㅜ': 'n', 'ㅡ': 'm',
};
export function normalizeHotkey(k) {
  if (typeof k !== 'string' || k.length !== 1) return k;
  if (HANGUL_KEYS[k]) return HANGUL_KEYS[k];
  return k >= 'A' && k <= 'Z' ? k.toLowerCase() : k;
}

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);
const orange = s => fg('38;5;208', s);
// 꺼 둔 계정 줄(한글 화면): 막대·구독은 그대로, 색만 진한 회색 — 원장 2026-10-28.
const offGray = s => fg('38;5;242', s);

// Named foreground colors selectable per route (config `color`). Bright variants
// let a user distinguish several routes at a glance.
const NAMED_FG = {
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightred: 91, brightgreen: 92, brightyellow: 93, brightblue: 94,
  brightmagenta: 95, brightcyan: 96,
};
// Ordered list of the plain names, offered in the editor prompt / help.
const isRouteColor = name => Object.prototype.hasOwnProperty.call(NAMED_FG, String(name || '').toLowerCase());
// A paint function for a route's color, falling back to cyan for blank/unknown.
const routeColorFn = name => {
  const code = NAMED_FG[String(name || '').toLowerCase()];
  return code ? (s => fg(code, s)) : cyan;
};

// Per-session coloring for the activity log: SESSION_FG and sessionColorCode
// live in session-color.js, shared with GET /teamclaude/session.
const SESSION_ID_LEN = 6; // first 6 hex chars — plenty to distinguish a handful
// Fixed-width colored session label: the name Claude Code holds on disk for the
// session (see session-titles.js), else the short id. Blank-padded when there's
// no session (e.g. a telemetry request). One width for every row, named or not,
// keeps the columns after it aligned. Measured in display columns, not UTF-16
// units, so a CJK title takes the same room as an ASCII one.
// The id is a client header. Node's parser lets C1 bytes (U+009B is a CSI on
// its own) through, so only an id of the shape Claude Code actually sends is
// shown as-is; anything else is stripped down before it reaches the frame.
const SAFE_SID = /^[A-Za-z0-9._-]+$/;
const shortSid = sid => (SAFE_SID.test(sid) ? sid : safeLine(sid, 64) || '?').slice(0, SESSION_ID_LEN);
const sessionTag = (sid, title = null, width = SESSION_ID_LEN) =>
  sid ? fg(sessionColorCode(sid), rpad(truncate(title || shortSid(sid), width), width)) : ' '.repeat(width);

// An account's name is painted in the colours of the sessions pinned there
// that made a request this recently. Longer than the tracker's active window,
// so a session between turns keeps its colour, and far shorter than its known
// hour, so the colours are about what is running rather than what lingers.
const SESSION_ROW_WINDOW_MS = 10 * 60 * 1000;
// The Sessions panel under the account list: at most this many session lines
// (the rest are counted), and the widest an account or model column may get.
const SESSIONS_PANEL_MAX = 8;
// [local patch 2026-10-27 원장] 한글 화면의 세션 색: 시작 순서대로 하나씩 — 겹치지 않게(9개 넘으면 돌아감).
const KO_SESSION_FG = [36, 35, 33, 32, 94, 95, 96, 93, 92];
const KO_DOMAIN_RE = /@(gmail\.com|2117academy\.com)$/;
/** 한글 화면용 「n초 전」. */
function koAgo(/** @type {number} */ ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초 전`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}
/** 시각: 오늘이면 `21:42`, 아니면 `10/27 21:42`. */
function koClock(/** @type {number} */ at, now = Date.now()) {
  const d = new Date(at);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
// How far apart two like requests may finish and still share an activity row.
const ACTIVITY_FOLD_MS = 60_000;
const SESSIONS_PANEL_ACCT_W = 32;
const SESSIONS_PANEL_MODEL_W = 12;
const strike = s => `${ESC}9m${s}${RESET}`;
// "3m ago" for a session's last request; the tracker forgets one after an hour.
function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
// The family a session last asked for, else its (client-supplied) model id.
function modelTag(model) {
  const family = modelFamily(model);
  if (family !== 'other') return family;
  return typeof model === 'string' ? safeLine(model, 20) : '';
}
// A utilization as a fixed-width whole percentage, '-' when unreported.
const pctCell = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '-').padStart(4);

// A session's colour as a background (SESSION_FG + 10) with a text colour that
// stays readable on it: white on the dark blue and magenta, black on the rest.
const sessionBg = code => `${code + 10};${code === 34 || code === 35 ? 97 : 30}`;
// Most runs the account name is split into. Past this many sessions the last
// run stands for the rest, which the session line's `+N` counts.
const NAME_RUNS_MAX = 4;

/**
 * The account name cell, `w` columns, with the colours of the sessions pinned
 * to the account running under it: one session paints the whole cell, several
 * split it into equal runs left to right, newest first, the first run taking
 * the leftover columns. The split is in display columns; a wide glyph on a
 * boundary stays whole in the run it starts in, and the next run gives the
 * column back. Each run ends in a reset, so nothing bleeds into the type cell.
 * @param {string} name
 * @param {number} w
 * @param {{ id: string }[]} sessions newest first, at least one
 */
function sessionNameCell(name, w, sessions) {
  const text = rpad(strip(truncate(name, w)), w);
  const n = Math.min(NAME_RUNS_MAX, sessions.length, Math.max(1, w));
  const base = Math.floor(w / n);
  // Where each run ends, counted from the start of the cell.
  const ends = Array.from({ length: n }, (_, i) => base * (i + 1) + (w - base * n));
  let out = '';
  let run = '';
  let seg = 0;
  let used = 0;
  const flush = () => {
    if (run) out += `${ESC}${sessionBg(sessionColorCode(sessions[seg].id))}m${run}${RESET}`;
    run = '';
  };
  for (const ch of text) {
    if (seg < n - 1 && used >= ends[seg]) { flush(); seg++; }
    run += ch;
    used += vw(ch);
  }
  flush();
  return out;
}

// Which quota-family bar (F7/S7) a route binds to, or null for a general route.
// Auto routes are named 'fable'/'sonnet'; a configured route is classified by its
// globs so e.g. `*fable*` sits next to the F7 bar.
const routeFamily = route => {
  const hay = `${route.name} ${(route.match || []).join(' ')}`.toLowerCase();
  if (/fable/.test(hay)) return 'fable';
  if (/sonnet/.test(hay)) return 'sonnet';
  return null;
};

// The inline ► for a route on an account: bold when it's the route's manual pin,
// plain when an eligible member, dim when the member is currently ineligible. The
// route's own color is kept in every case so the marker stays identifiable.
const routeGlyph = (paint, eligible, pinned) =>
  pinned ? bold(paint('►')) : eligible ? paint('►') : dim(paint('►'));

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');

// What a composed line may still carry when it reaches the frame: the SGR
// colour this file adds, and nothing else that a terminal would act on. Every
// other escape form (an OSC 52 clipboard write, a CSI erase, a bare C0/C1
// control) came from a value that was not ours, and unlike sanitizeText this
// keeps the colour, so it can run on a line after it has been painted.
// Alternatives, in order: SGR (kept), OSC through its BEL/ST terminator, any
// other CSI, any remaining control or format character.
const NON_SGR_CONTROL = /(\x1b\[[0-9;]*m)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu;
export const scrubLine = s => String(s).replace(NON_SGR_CONTROL, (m, sgr) => sgr || '');
const SGR_AT = /\x1b\[[0-9;]*m/y;   // sticky: "an SGR starting exactly here"

// Terminal display width of one code point: 0 for combining and zero-width
// marks, 2 for East Asian wide/fullwidth characters and emoji, 1 otherwise.
// A compact subset of Unicode's East_Asian_Width and combining ranges, enough
// to keep the account table aligned for CJK and accented names without a full
// property database. It does not resolve emoji ZWJ sequences, so a multi-part
// emoji is counted per component; names rarely contain those.
function charWidth(cp) {
  if (cp === 0) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) || (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) || (cp >= 0x0e31 && cp <= 0x0e3a) ||
    cp === 0x200b || (cp >= 0x200d && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

// Visible terminal width of a string: ANSI escapes stripped, then each code
// point measured by charWidth. Replaces a bare .length, which miscounts CJK
// (1 unit, 2 columns) and combining marks (1 unit, 0 columns) and so would
// misalign the table for non-ASCII names.
export function displayWidth(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
const vw = displayWidth;

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

// Split a comma-separated input (route globs / account names) into trimmed,
// non-empty tokens. Shared by the routes editor prompts.
function splitCsv(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Truncate a string with ANSI codes to at most w display columns, then reset. */
export function truncate(s, w) {
  let width = 0;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      // Only a well-formed SGR is copied through. Copying "ESC up to the next
      // m" carried an erase or a clipboard write into the frame whole.
      SGR_AT.lastIndex = i;
      const m = SGR_AT.exec(s);
      if (m) { out += m[0]; i += m[0].length; continue; }
      i++; continue;
    }
    const cp = s.codePointAt(i);
    // A stray control (BEL, a C1 byte) is dropped, not drawn.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) { i++; continue; }
    const cw = charWidth(cp);
    // A wide glyph that would cross the limit is dropped whole rather than split;
    // the one leftover column is filled by the caller's padding.
    if (width + cw > w) break;
    const len = cp > 0xffff ? 2 : 1;
    out += s.slice(i, i + len);
    width += cw;
    i += len;
  }
  return out + RESET;
}

// Quota bar width bounds: narrow enough that a `2d14h` label still fits, wide
// enough that a very wide terminal doesn't turn the row into one long bar.
const BAR_MIN = 5;
const BAR_MAX = 20;

// Floor for the account name column. It grows past this toward the longest name
// when the row has width to spare, but never drops below it, so a narrow
// terminal lays the table out exactly as it did before the column could grow.
const NAME_MIN = 12;
// Providers in declaration order: the order rows and panes are drawn in.
const PROVIDER_ORDER = Object.keys(PROVIDERS);
// Two provider pools side by side: the gutter between the panes.
const PANE_GUTTER = ' │ ';
// Pane bars: at least wide enough for `10h23m`, and past that only once every
// name is whole. From there they grow to BAR_MAX, as the list's bars do: a
// narrower cap left a 600-column terminal drawing 12-column bars beside
// hundreds of blank columns.
const PANE_BAR_FLOOR = 8;
// The narrowest a list draws both shared bars in, full width and in a pane.
const LIST_MIN = 70;
const PANE_MIN = 62;

// Clear space the centred version label needs on each side before it is drawn
// at all. Below that it reads as a collision with the title or the port block,
// so the whole label is dropped rather than squeezed.
const HEAD_GAP = 2;

// Where an account sits in the list the operator arranged — the sort key behind
// _displayOrder, written by _doMoveAccount and by nothing else.
//
// An account with no `displayOrder` has never been placed: every account on a
// config that predates the field, and every account added since the last
// arrangement. Those list after every account that has one, which is where a
// new account already appeared back when this list was array order — so the
// answer to "where does the one I just logged in with go" does not change with
// the feature, and there is nothing to migrate.
const listRank = (/** @type {any} */ a) => (Number.isFinite(a?.displayOrder) ? a.displayOrder : Infinity);

// How the account list is ordered inside each provider group (`accountSort`).
// `arranged` is the operator's own order (listRank). Each of the others puts
// the account whose window ends soonest first, so quota that is about to
// expire unspent is at the top of the list.
//
// The window each sort reads. S7 and F7 are the family's own weekly bucket
// where the account has one, else the all-models weekly, which is what governs
// that family on such an account — the rule quota-summary.js resolves a
// family's window by.

// The window the weekly sorts read, backend windows included (a backend row
// draws these same resets). A live window without a reset stays unknown: it
// does not fall through to the monthly one, which the row draws separately.
const weeklyResetOf = (/** @type {any} */ q) => {
  if (q.unified7dReset != null) return q.unified7dReset;
  const bw = q.backend?.windows;
  const weekly = bwLive(bw?.weekly);
  if (weekly) return weekly.resetAt;
  return bwLive(bw?.monthly)?.resetAt;
};
/** @type {Record<string, (q: any) => any>} */
const SORT_RESET = {
  'session-reset': q => q.unified5hReset ?? bwLive(q.backend?.windows?.fiveHour)?.resetAt,
  'weekly-reset': weeklyResetOf,
  'sonnet-reset': q => (q.unified7dSonnet != null ? q.unified7dSonnetReset : weeklyResetOf(q)),
  'fable-reset': q => (q.unified7dFable != null ? q.unified7dFableReset : weeklyResetOf(q)),
};
export const ACCOUNT_SORTS = ['arranged', ...Object.keys(SORT_RESET)];
/** @type {Record<string, string>} */
const ACCOUNT_SORT_LABELS = {
  arranged: 'arranged',
  'session-reset': 'session reset',
  'weekly-reset': 'weekly reset',
  'sonnet-reset': 'S7 reset',
  'fable-reset': 'F7 reset',
};

// The sort key: when the window resets. No reading (an API-key account, one
// that has not reported, a five-hour window nothing has opened) and a reset
// that has already passed both sort last: the second is a window that has just
// started over, so its next reset is the one furthest away.
const resetRank = (/** @type {any} */ t, /** @type {number} */ now) => (Number.isFinite(t) && t > now ? t : Infinity);

// How long a reorder waits after the last move before it is written. Longer
// than a terminal's key-repeat interval, so a held arrow is one write; short
// enough that the file is current by the time anyone looks at it.
const ORDER_SAVE_DELAY_MS = 400;

// Which bars a row draws: the subscription buckets (Ses/Wk, plus the S7/F7
// family bars) for a subscription or any unified reading; the same slots filled
// from the probed windows (plus Mon) for a third-party backend; else the
// metered Tok/Req pair an API-key account reports. The account row budget is
// drawn per category (#234): the three kinds of row share no bar, so sizing a
// backend row for the family bars it never draws — or a Claude row for a
// backend's Mon bar — only leaves the others short of the edge.
function rowCategory(/** @type {any} */ account) {
  const q = account.quota;
  if (isSubscriptionAccount(account) || q.unified5h != null || q.unified7d != null || q.unified7dSonnet != null || q.unified7dFable != null) return 'unified';
  if (q.backend?.windows != null) return 'backend';
  return 'metered';
}

// Families this account can't serve right now: a family whose own weekly bucket
// is over the switch threshold is barred from that model while the account is
// otherwise active. Shared by the row renderer (which draws the `⊘` tag) and the
// column layout (which reserves the width that tag needs).
// `threshold` is a number, or a per-bucket lookup (bucket → number) so a family
// is judged against its OWN configured threshold rather than the global one.
/**
 * Short row tag for an account that bills real money past its plan limits: the
 * month-to-date amount once something has actually been billed (`$14.35`), `$`
 * while it merely can be, '' when it cannot. With a money cap configured
 * (accounts[].maxSpend) the cap trails it, `$14.35/20`, so the row shows how
 * much of the budget is gone without a trip to the status screen. ASCII on
 * purpose — the row is width-budgeted to the cell, and a glyph whose width
 * varies by terminal would push it past the edge; the budget takes this tag's
 * width from the same call, so a longer amount widens the column, never the row.
 *
 * Deliberately not shown for an account that spent earlier and has since been
 * switched off: the row reports what rotating onto this account costs now, and
 * the status screen carries the fuller history.
 *
 * @param {any} quota
 * @param {number | null} [maxSpend] the account's accounts[].maxSpend, if any
 */
export function spendTag(quota, maxSpend = null) {
  const spend = quota?.spend;
  if (!spend?.enabled) return '';
  const used = spend.usedMinor || 0;
  const capMinor = resolveMaxSpendMinor(maxSpend, spend);
  const cap = capMinor == null ? '' : `/${compactMoney(capMinor, spend)}`;
  if (used <= 0) return `$${cap}`;
  return `${formatMoney({ ...spend, limitMinor: null })}${cap}`;
}

// `20` for a whole-unit cap, `12.5` otherwise: the cap is the operator's own
// round number, so the cents that formatMoney always carries would only be
// noise after the slash.
/** @param {number} minor @param {{ exponent?: number } | null | undefined} spend */
function compactMoney(minor, spend) {
  return String(minor / 10 ** (spend?.exponent ?? 2));
}

// The type column: the auth kind (7 columns), or the provider in a mixed pool.
// The row and the width budget both take its width from here.
function typeColumn(/** @type {any[]} */ accounts) {
  /** @type {Set<keyof typeof PROVIDERS>} */
  const pooled = new Set(accounts.map(providerOf));
  const mixed = pooled.size > 1;
  return { mixed, width: mixed ? Math.max(...[...pooled].map(id => PROVIDERS[id].label.length)) : 7 };
}

/**
 * Short row tag for an account holding free Codex rate-limit reset credits:
 * `RC1` for one, `RC2` for two, '' for none. ASCII for the same reason spendTag
 * is — the row is budgeted to the cell, and a glyph whose width varies by
 * terminal pushes it past the edge.
 *
 * The number is what the account HOLDS. It is deliberately not the number that
 * could be redeemed right now: only the detail rows say whether a given credit
 * is supported by the plan, and they cost a request nobody should make to draw
 * a badge. See codex-reset-credits.js.
 *
 * A reading older than RESET_CREDIT_MAX_AGE_MS draws nothing: the row has no
 * room to say how old the count is, so past the point where it stops being
 * worth anything the honest tag is no tag.
 *
 * @param {Record<string, any>|null|undefined} quota
 * @param {number} [now]  ms epoch the reading's age is measured from
 */
export function resetCreditTag(quota, now = Date.now()) {
  const available = heldResetCredits(quota, now);
  return available ? `RC${available}` : '';
}

/**
 * Short row tag for the extra-usage fallback (`accounts[].allowExtraUsage`):
 * `xu!` while the account is serving past its quota and billing for it, `xu`
 * while it is merely allowed to, '' otherwise. Same shape and colours as the
 * money tag beside it, for the same width-budget reason.
 * @param {boolean} allowed
 * @param {boolean} serving
 */
export function extraUsageTag(allowed, serving) {
  if (serving) return 'xu!';
  return allowed ? 'xu' : '';
}

export function blockedFamilies(quota, threshold) {
  const at = typeof threshold === 'function' ? threshold : () => threshold;
  const out = [];
  for (const [label, key] of [['Sonnet', 'unified7dSonnet'], ['Fable', 'unified7dFable']]) {
    if (quota[key] == null) continue;      // family not metered separately here
    // Compared against gatingUtilization — the value the ROUTER gates on — not
    // against the family bucket alone. Family spend meters into the shared
    // weekly too, so an account under its family cap can be over the shared one
    // and unable to serve that family at all (#175). This tag displays a routing
    // decision, so deriving it a second way here would be a copy that drifts.
    const gating = gatingUtilization(quota, key);
    if (gating != null && gating >= at(key)) out.push(label);
  }
  return out;
}

/**
 * [local patch 2026-10-27 원장] 계정 줄들의 구독 꼬리를 같은 열에 맞춘다. `items` 는 줄마다
 * { body: 꼬리 앞까지의 줄, droppable: 모자랄 때 먼저 빼는 칸(F7·S7, 뒤에서부터), tail: 꼬리(없으면 ''),
 * width: 줄 너비(0 이면 제한 없음) }. 꼬리가 있는 줄 중 가장 긴 몸통이 열이 되고, 짧은 줄은 빈칸으로 채운다.
 * 열 + 꼬리가 줄 너비를 넘으면 가장 긴 줄(들)에서 칸을 하나씩 빼 열을 줄이고, 뺄 칸이 없는 가장 긴 줄은
 * 꼬리를 통째로 뺀다(반쪽 꼬리 없음 — 넘치는 줄의 꼬리만). 꼬리가 남은 줄들은 모두 같은 열이다.
 * @param {{ body: string, droppable: string[], tail: string, width: number }[]} items
 * @returns {string[]}
 */
export function alignSubTails(items) {
  const cur = items.map(it => ({ ...it, droppable: [...it.droppable] }));
  for (;;) {
    const withTail = cur.filter(it => it.tail);
    if (!withTail.length) break;
    const col = Math.max(...withTail.map(it => vw(it.body)));
    if (!withTail.some(it => it.width > 0 && col + vw(it.tail) > it.width)) break;
    const widest = withTail.filter(it => vw(it.body) === col);
    let dropped = false;
    for (const it of widest) {
      const seg = it.droppable.pop();
      if (seg) { it.body = it.body.replace(seg, ''); dropped = true; }
    }
    if (!dropped) {
      const over = (/** @type {any} */ it) => it.width > 0 && col + vw(it.tail) > it.width;
      const hard = widest.filter(over);
      for (const it of hard.length ? hard : withTail.filter(over)) it.tail = '';
    }
  }
  const col = Math.max(0, ...cur.filter(it => it.tail).map(it => vw(it.body)));
  return cur.map(it => (it.tail ? it.body + ' '.repeat(col - vw(it.body)) + it.tail : it.body));
}

/**
 * [local patch 2026-10-27 원장] TUI 에 그리는 「막힌 계열」 — Fable·Sonnet 둘 다 뺀다(원장: 「어차피
 * 100%라고 써 있으면 된다」 → 「소넷 다 쓴 계정 표시도 빼 줘」). F7·S7 막대와 숫자는 그대로 두고
 * `⊘ Fable`·`⊘ Sonnet` 장식만 없앤다. 라우팅(blockedFamilies 를 읽는 쪽)과 `octopus status` 텍스트는
 * 건드리지 않는다.
 * @param {any} quota
 * @param {number|((key: string) => number)} threshold
 */
function shownBlockedFamilies(quota, threshold) {
  return blockedFamilies(quota, threshold).filter(n => n !== 'Fable' && n !== 'Sonnet');
}

// Matches THRESHOLD_BUCKET_LABELS in status-renderer.js — same short names on
// both surfaces, so an operator moving from `teamclaude status` text to the
// live TUI (or attach mode) sees the identical tag rather than relearning it.
/** @type {Object<string, string>} */
const THRESHOLD_TAG_LABELS = {
  unified5h: '5h', unified7d: '7d', unified7dSonnet: 'sonnet', unified7dFable: 'fable',
  tokens: 'tokens', requests: 'requests',
};

/**
 * "switch at 100%" / "switch 7d 90%, fable 80%" — the account's OWN
 * switchThreshold (issue #409), or '' when it has none or every override it
 * carries merely repeats what the fleet already resolves to (see
 * switchThresholdDiffs). `fleetFor(bucket)` is the fleet-only lookup —
 * `this.am.thresholdFor(bucket)` with no account arg, which both AccountManager
 * and RemoteAccountManager answer identically, so attach mode reads the same
 * tag the live server would show.
 * @param {any} account
 * @param {(bucket: string) => number} fleetFor
 */
export function switchThresholdTag(account, fleetFor) {
  const diffs = switchThresholdDiffs(account?.switchThreshold, fleetFor);
  if (!diffs.length) return '';
  const parts = diffs.map(({ bucket, value }) => {
    const label = bucket === 'default' ? 'at' : (THRESHOLD_TAG_LABELS[bucket] || bucket);
    return `${label} ${formatPercent(value)}`;
  });
  return `switch ${parts.join(', ')}`;
}

/**
 * "via socks5h://alice:***@host:1080" — the account's OWN egress proxy, or ''
 * when it has none: the fleet path is the default and earns no tag. The live
 * TUI reads the parsed object the manager holds; an attached dashboard reads
 * the already-masked string the status payload carries (passwords never cross
 * that boundary) — both land here.
 * @param {any} account
 */
export function routingTag(account) {
  const r = account?.routing;
  if (!r) return '';
  const text = typeof r === 'string' ? r : describeRouting(r);
  return text ? `via ${text}` : '';
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short.
 *  Truncation drops a wide glyph that would straddle the limit, so the result
 *  can come up one column short; pad that too — the frame is repainted in
 *  place, and a line narrower than the terminal leaves the previous frame's
 *  last cell visible. */
export function fitLine(s, w) {
  const v = vw(s);
  if (v > w) {
    const t = truncate(s, w);
    return t + ' '.repeat(Math.max(0, w - vw(t)));
  }
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

const GIB = 1024 ** 3;

/**
 * The Host line (see host-stats.js), at most `width - 1` columns, or '' when
 * the snapshot has no memory figures or nothing fits:
 * `Host  RAM 71% (8.9 GB free · 3.9 GB compressed)  ·  CPU  find 100%  …`.
 * The RAM figure takes the quota bars' four colours by the share in use; a
 * process flagged as a hog is red with a `!`. A narrow line drops the CPU
 * entries from the end first, then the compressed and free figures.
 * @param {any} snap a HostStats snapshot
 * @param {number} width
 * @param {{ count?: number, memMB?: number }|null} [cleanup] 「[x] 정리」 안내: null 이면 안내 없음,
 *   대상이 있으면 `[x] 정리 3개 0.4GB` 를 주황으로. 자리가 모자라면 안내만 먼저 빠진다.
 */
export function formatHostLine(snap, width, cleanup = null) {
  const total = snap?.totalBytes;
  const free = snap?.freeBytes;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) return '';
  const used = Math.min(1, Math.max(0, 1 - free / total));
  const paint = used < 0.5 ? green : used < 0.75 ? yellow : used < 0.9 ? orange : red;
  const ram = `RAM ${paint(`${Math.round(used * 100)}%`)}`;
  const gb = (/** @type {number} */ b) => `${(b / GIB).toFixed(1)} GB`;
  const freeText = `${gb(Math.min(free, total))} free`;
  const comp = snap.compressedBytes;
  const compText = Number.isFinite(comp) && comp > 0 ? `${gb(comp)} compressed` : null;
  const procs = (Array.isArray(snap.top) ? snap.top : [])
    .map((/** @type {any} */ p) => {
      const name = typeof p?.name === 'string' ? safeLine(p.name, 32) : '';
      if (!name || !Number.isFinite(p?.cpuPct)) return null;
      const item = `${name} ${Math.round(p.cpuPct)}%`;
      return p.hog === true ? red(`${item}!`) : item;
    })
    .filter(Boolean);
  const head = ` ${bold('Host')}  `;
  const compose = (/** @type {number} */ n, /** @type {boolean} */ withComp, /** @type {boolean} */ withFree) => {
    const detail = [withFree && freeText, withComp && compText].filter(Boolean).join(' · ');
    const cpu = n > 0 ? `${dim('  ·  ')}CPU  ${procs.slice(0, n).join('  ')}` : '';
    return `${head}${ram}${detail ? ` ${dim(`(${detail})`)}` : ''}${cpu}`;
  };
  const tries = [];
  for (let n = procs.length; n >= 0; n--) tries.push(compose(n, true, true));
  tries.push(compose(0, false, true), compose(0, false, false));
  const line = tries.find(l => vw(l) <= width - 1) || '';
  if (!line || !cleanup) return line;
  const n = Number(cleanup.count) || 0;
  const hint = n > 0
    ? `${dim('  ·  ')}${orange(`[x] 정리 ${n}개 ${formatGB(Number(cleanup.memMB) || 0)}`)}`
    : dim('  ·  [x] 정리');
  return vw(line) + vw(hint) <= width - 1 ? line + hint : line;
}

/** A pane's title, `w` columns wide: the label, then a rule to the pane's edge. */
function paneTitle(/** @type {string} */ label, /** @type {number} */ w) {
  return fitLine(` ${bold(label)} ${dim('─'.repeat(Math.max(1, w - vw(label) - 2)))}`, w);
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

// Rolling-window lengths for the Claude Max buckets, used to color a bar by
// burn rate rather than raw fill (see barColor). The five-hour session bucket
// and the seven-day weekly buckets (unified, Sonnet, Fable) reset on these.
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// A calendar month is 28-31 days; pace colouring off by a few percent at the
// edges is the price of not knowing which one the provider means.
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// A backend window past its reset is stale, not current (the probe may be
// off); a window without a reset is live but unpaced.
const bwLive = (/** @type {{ utilization: number, resetAt: number|null }|null|undefined} */ w) => (w && (w.resetAt == null || w.resetAt > Date.now()) ? w : null);

// { bg, fg } SGR params per severity. White label on red (dark everywhere),
// black on the lighter green/yellow/orange (bright-white would vanish on the
// light backgrounds many terminal themes render for them).
const BAR_GREEN = { bg: '42', fg: '30' };
const BAR_YELLOW = { bg: '43', fg: '30' };
const BAR_ORANGE = { bg: '48;5;208', fg: '30' };
const BAR_RED = { bg: '41', fg: '97' };

/**
 * Pick a bar color. A bucket at or above `threshold` is red whatever its fill:
 * that is the point where the rotation stops routing to it — eligibility()
 * calls the account out as "at or above the switch threshold", and the row's
 * `⊘` tag comes off the same comparison in blockedFamilies — so a green bar
 * would contradict the rest of the row. Below it the color follows the fill
 * alone: under 50% green, 50–74% yellow, 75–89% orange, 90% and up red.
 * [Octopus local patch] `resetTs` and `windowMs` are accepted for the callers'
 * sake but ignored: the upstream burn-rate coloring is gone.
 */
function barColor(ratio, resetTs, windowMs, threshold) {
  if (threshold != null && ratio >= threshold) return BAR_RED;
  // [local patch] Color by fill alone; resetTs/windowMs (pace) are ignored.
  if (ratio < 0.5) return BAR_GREEN;
  if (ratio < 0.75) return BAR_YELLOW;
  if (ratio < 0.9) return BAR_ORANGE;
  return BAR_RED;
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "Ses 2h30m" or "45%") is drawn on top of the bar.
 * windowMs is the bucket's rolling-window length; when known, the color tracks
 * burn rate instead of raw fill. threshold is the routing switch threshold, at
 * or above which the bar goes red regardless of pace. showPct false drops the
 * percentage wherever a countdown can stand in its place (config
 * `quotaBarPercent`, off unless set); with no countdown the percentage is the
 * label either way.
 */
export function bar(ratio, w = 10, resetTs, windowMs, threshold, showPct = true) {
  const rst = formatReset(resetTs);

  if (ratio == null || isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = rst || '-';
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  const { bg, fg } = barColor(ratio, resetTs, windowMs, threshold);

  // Both fields when the bar is wide enough to hold them, `97% · 2h30m`, and
  // the countdown alone when it is not: the countdown is what the width budget
  // already treats as load-bearing (a row cut mid-bar "loses the reset countdown
  // its tail carries", see the backstop in the row renderer), so the percentage
  // is the field that yields. From BAR_MIN up the label is therefore one field
  // entire or the other, never half of one — half a countdown reads as a
  // different number, not a shorter one; below BAR_MIN the slice that follows
  // still cuts it, as it did before. The other two quota readouts already draw
  // both values in this order — the ` · ` between them is the dashboard's
  // (src/dashboard.js).
  const pct = (ratio * 100).toFixed(0) + '%';
  const both = showPct && rst ? `${pct} · ${rst}` : '';
  const label = both && vw(both) <= w ? both : (rst || pct);
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = (' '.repeat(lp) + text + ' '.repeat(rp));

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};${fg}m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}

// The request fields the hooks hand us come from the client — the path and
// method off the request line, the model and effort read from the body, the
// session id from a header — so they are cut down once here, before they are
// stored to be drawn every frame and logged.
const REQ_FIELD_MAX = { method: 16, path: 256, model: 64, effort: 16, account: 64, sessionId: 64 };
function cleanRequestInfo(info) {
  const out = { ...info };
  for (const [k, max] of Object.entries(REQ_FIELD_MAX)) {
    if (out[k] != null) out[k] = safeLine(out[k], max);
  }
  return out;
}

// ` (model·effort)`, with the `·effort` suffix in a fixed grey a step under
// the model. Fixed rather than dim because the live row already dims the
// model, and dim on dim is no step at all.
const effortGrey = (/** @type {string} */ s) => fg('38;5;244', s);
/**
 * @param {string} label  modelLabel's text
 * @param {string|null|undefined} effort
 * @param {boolean} dimModel
 */
function modelParen(label, effort, dimModel) {
  if (!label) return '';
  const paint = dimModel ? dim : (/** @type {string} */ s) => s;
  const suffix = effort ? `${EFFORT_SEP}${effort}` : '';
  if (!suffix || !label.endsWith(suffix)) return paint(` (${label})`);
  return `${paint(` (${label.slice(0, -suffix.length)}`)}${effortGrey(suffix)}${paint(')')}`;
}

// The compact activity format (activityFormat: 'compact') drops the method and
// the path, which on almost every row is `POST /v1/messages?beta=true` and says
// nothing. A request that is not a plain messages call keeps a short tag in
// their place: `count` for count_tokens, else the last path segment.
const PLAIN_MESSAGES_PATH = /^\/v1\/messages(\?.*)?$/;
// The session label's width in compact rows when the config leaves it at the
// default: the room the path gave back, so a generated title (a sentence) fits.
const COMPACT_TITLE_WIDTH = 32;
/** @param {unknown} path @returns {string} '' for a plain messages call */
function compactPathTag(path) {
  const p = typeof path === 'string' ? path : '';
  if (PLAIN_MESSAGES_PATH.test(p)) return '';
  const bare = p.split('?')[0];
  if (/^\/v1\/messages\/count_tokens\/?$/.test(bare)) return 'count';
  const last = bare.split('/').filter(Boolean).pop();
  return last ? safeLine(last, 24) : '?';
}
/** A model paren (modelParen) without its leading space, for a row that puts
 *  its own separator in front. @param {string} paren */
const unlead = (paren) => paren.replace(' (', '(');
/** The status slot of a compact row: nothing for a 2xx, a red mark otherwise.
 *  @param {unknown} status */
const compactStatus = (status) => (typeof status === 'number' && status >= 200 && status < 300
  ? '' : `${red(`✗ ${status ?? '?'}`)} `);

// A stored key, shown enough to recognise and no more. First-4/last-4 on a key
// of eight characters or fewer is the whole key; a short one shows its tail only.
export function maskKey(key) {
  const k = String(key);
  if (k.length <= 4) return '****';
  if (k.length < 12) return `…${k.slice(-4)}`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── Login panel helpers ──────────────────────────────────────

// Bracketed paste (DEC mode 2004): while the login panel is open the terminal
// is asked to wrap a paste in these markers, so the TUI can tell a paste from
// typing however the terminal chunks it.
const PASTE_ON = `${ESC}?2004h`;
const PASTE_OFF = `${ESC}?2004l`;
const PASTE_START = `${ESC}200~`;
const PASTE_END = `${ESC}201~`;
const PASTE_MARKERS = [PASTE_START, PASTE_END];
// A read can end part-way through a marker (over SSH, at any byte), so the
// panel holds back a tail that could be a marker's start until the next read
// says what it was. A lone ESC is also the Esc key: held this long with
// nothing after it, it is taken as the key. Long enough for the rest of a
// marker split across reads to arrive, short enough not to be felt.
const ESC_WAIT_MS = 100;
// A paste arrives in one burst. Still without its closing marker after this
// long, the marker was lost, and the field stops treating keys as paste.
const PASTE_IDLE_MS = 2_000;

/** How many characters at the end of `s` could be the start of one of
 *  `markers`, cut off by the end of the read.
 *  @param {string} s
 *  @param {string[]} markers */
function markerTail(s, markers) {
  for (let n = Math.min(s.length, PASTE_START.length - 1); n > 0; n--) {
    const tail = s.slice(-n);
    if (markers.some(m => m.startsWith(tail))) return n;
  }
  return 0;
}
const UNDERLINE = `${ESC}4m`;
/** How a link looks: underlined, in the cyan the rest of the screen uses for
 *  things to act on. The OSC 8 sequence itself is added after the line is
 *  fitted (see _render).
 *  @param {string} s */
const linkText = s => `${UNDERLINE}${cyan(s)}`;

/** What the login field keeps of a paste or a key: no control or format
 *  character of any kind. C1 included, since U+009B is a CSI by itself, and
 *  the field is drawn into the frame as it stands. No sign-in code or address
 *  holds one.
 *  @param {string} s */
const fieldText = s => s.replace(/\p{C}/gu, '');

/** Plain text wrapped at spaces to lines of at most `w` columns. A word longer
 *  than a line keeps a line to itself, and fitLine cuts it.
 *  @param {string} text
 *  @param {number} w */
function wrapWords(text, w) {
  /** @type {string[]} */
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (vw(line) + 1 + vw(word) <= w) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** The end of `s` in at most `w` columns, led by `…` when the start is cut: a
 *  pasted address is several hundred characters, and its end is the part that
 *  differs from one paste to the next.
 *  @param {string} s
 *  @param {number} w */
function tailText(s, w) {
  if (vw(s) <= w) return s;
  if (w <= 1) return '…';
  return `…${[...s].slice(-(w - 1)).join('')}`;
}

/**
 * The `l` key's callback, wired by index.js. It runs the whole sign-in and the
 * save; `onPrompt` hands the panel the link and the paste target once the flow
 * is ready, and aborting `signal` cancels it.
 * @typedef {(account: Record<string, any>, opts?: { signal?: AbortSignal, onPrompt?: (prompt: LoginPrompt) => void }) => Promise<{ action: 'updated' | 'added', name: string }>} LoginAccount
 */

/**
 * The login panel's state, for as long as it is open.
 * @typedef {object} LoginPanel
 * @property {string} account  the row that was picked, for the title
 * @property {AbortController} controller  Esc aborts it; it is how the panel cancels the flow
 * @property {LoginPrompt | null} prompt  null until the flow is listening
 * @property {string} buf  the paste field
 * @property {string | null} error  why the last paste was refused
 * @property {string | null} notice  a one-off confirmation (the link copied again)
 * @property {boolean} pasting  inside a bracketed paste that has not ended yet
 * @property {string} held  the end of the last read, held back as a possible marker's start
 * @property {ReturnType<typeof setTimeout> | null} timer  the ESC wait or the paste watchdog
 * @property {number} timerGen  bumped on every arm and disarm, so a stale timer does nothing
 * @property {string} linkId  joins the pieces of a wrapped URL into one link
 */

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit, sx = null, probeQuota = null,
    // [local patch 2026-10-27 원장] `w` 5시간 켜기(warmer.js warmTargets/warmNow). 없으면 안내만.
    warmCandidates = /** @type {(() => any[] | null) | null} */ (null),
    warmNow = /** @type {((targets: any[], opts?: any) => Promise<any[] | null> | null) | null} */ (null),
    // Cast so the destructured binding is the callback type, not `null`: index.js passes a function here.
    loginAccount = /** @type {LoginAccount | null} */ (null),
    activityLogPath = null,
    // Attach mode: the accounts belong to a server in another process, reached
    // over its control plane. Everything that would mutate local state is off,
    // and a switch becomes a request (applySwitch) instead of an assignment.
    remote = false, applySwitch = null,
    // Attach mode's `m`: the move is a request to the server, like a switch.
    applySessionMove = null,
    // [local patch 2026-10-27 원장] `f` 집중 계정: 설정 저장 + 서버 반영(index.js). 없으면 메모리에만 적용.
    setFocusAccount = null,
    // Injectable so the import path can be exercised without a real credentials
    // file or a live profile call.
    readCredentials = importCredentials, readProfile = fetchProfile,
    // Injectable so setting an account's proxy can be exercised without one.
    testRouting = checkRouting,
    // Names the activity column against the session id the client sent. Absent
    // or disabled leaves every row showing the short id.
    sessionTitles = null,
    // How the header names this build, and whether a newer release is known.
    // In attach mode the account manager carries the server's own answer and
    // these are unused; the empty defaults keep the label hidden until it does.
    versionLabel = '', updateAvailable = false,
    // The Host line's sampler (host-stats.js). Absent, the line reads the
    // account manager's `host` (attach mode), or is not drawn.
    hostStats = null,
    // 안 쓰는 작업 정리(`x`, cleanup.js). 프로세스 목록 조회·종료·플랫폼은 시험에서 바꿔 끼운다.
    cleanupScan = scanLeftovers, cleanupKill = undefined, cleanupPlatform = process.platform,
    // Read for TMUX when the login panel copies its link. Injectable so the
    // tmux wrapping can be exercised without running inside tmux.
    env = /** @type {Record<string, string | undefined>} */ (process.env) }) {
    this.am = accountManager;
    this.remote = remote;
    this.applySwitch = applySwitch;
    this.applySessionMove = applySessionMove;
    this.setFocusAccount = setFocusAccount;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;
    this.sx = sx;            // sx.org proxy manager (may be null)
    this.sxBalance = null;   // last fetched sx.org balance, for the settings screen
    this.probeQuota = probeQuota; // on-demand fleet-wide quota refresh (may be null)
    this.warmCandidates = warmCandidates;
    this.warmNow = warmNow;
    /** @type {LoginAccount | null} */
    this.loginAccount = loginAccount; // (re-)login for a chosen account (may be null)
    this._env = env;
    this._cleanupScan = cleanupScan;
    this._cleanupKill = cleanupKill;
    this._cleanupPlatform = cleanupPlatform;
    this.activityLogPath = activityLogPath;
    this._readCredentials = readCredentials;
    this._readProfile = readProfile;
    this._testRouting = testRouting;
    this._activityStream = null;
    this.sessionTitles = sessionTitles;
    this.versionLabel = versionLabel;
    this.updateAvailable = updateAvailable;
    this.hostStats = hostStats;

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | select | add | input | settings | pick | login
    this.pick = null;        // active list picker (routes editor accounts/bucket/color)
    this.pickReturn = 'routes'; // mode to fall back to when the picker closes
    this.selAction = null;   // switch | remove | toggle | reorder | routing
    this.selIdx = 0;
    this.selRoute = null;    // in switch mode: null = global default, else a getRoutes() entry to pin
    this.selReturn = 'normal'; // mode to fall back to when select mode closes
    this.move = null;        // the `m` picker while it is open (see _openMove)
    this.focus = null;       // 「집중 계정」 고르기 창 상태(see _openFocus)
    this.cleanup = null;     // 「안 쓰는 작업 정리」 창 상태(see _openCleanup)
    this._leftovers = null;  // 마지막 조회의 { count, memMB } — Host 줄 안내용
    /** @type {ReturnType<typeof setInterval> | null} */
    this._leftoverTimer = null;
    this.setIdx = 0;         // cursor row on the settings screen (BIOS-style nav)
    this.setScroll = 0;      // first body line the settings screen shows (see _viewport)
    this.blockIdx = 0;       // cursor row on the blocked-models editor
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.inputSecret = false;    // a key is being typed: the footer echoes * for each char
    /** @type {Map<string, number>} 세션이 처음 보인 순서(한글 화면) */
    this._sessOrder = new Map();
    /** @type {Map<string, { ok: boolean, status: any, dur: string, at: number }>} 세션별 최근 요청(한글 화면) */
    this._sessLast = new Map();
    /** @type {any[] | null} W 확인 화면에서 켤 계정 */
    this._warmPick = null;
    /** @type {Set<any> | null} W 로 켜는 중인 계정(아직 차례가 안 온 것 포함) */
    this._warming = null;
    this.inputReturn = 'normal'; // mode to fall back to when an input is cancelled
    this.frame = 0;
    this.running = false;
    this.timer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._orderSaveTimer = null; // a reorder waiting to be written: see _doMoveAccount
    // Injectable so a test can drive the repaint tick by hand instead of
    // sleeping through real 500ms/5s intervals.
    this._setTimeout = setTimeout;
    this._origLog = null;
    this._origErr = null;
    this._origWarn = null;
    // Set once the terminal has reported a failure. Everything that would
    // write to it checks this first.
    this._stdoutDead = false;
    // The sign-in the login panel is showing (mode 'login'), or null. See _doLogin.
    /** @type {LoginPanel | null} */
    this.login = null;
    this._loginSeq = 0;   // numbers each panel's link id, so two logins' links are never one
  }

  // ── lifecycle ──────────────────────────────────────

  /**
   * Open the activity log, if one is configured.
   *
   * Split out of start() so it can be exercised without entering the alt screen
   * or putting stdin in raw mode — neither of which a test process can do.
   *
   * 0600 like every sibling (config, state, request log and its directory): the
   * activity log names which client made each call, so on a shared host it is
   * the record that says who was working on what and when (#259). Mode applies
   * on creation only, so a file the operator already placed keeps the
   * permissions they chose rather than being chmod'ed underneath them.
   */
  _openActivityLog() {
    if (!this.activityLogPath) return null;
    this._activityStream = createWriteStream(this.activityLogPath, { flags: 'a', mode: 0o600 });
    this._activityStream.on('error', err => {
      // Swallow write errors — can't log them to the TUI without recursion
      this._activityStream = null;
      process.stderr.write(`[Octopus] activity log error: ${err.message}\n`);
    });
    return this._activityStream;
  }

  start() {
    this.running = true;
    this._openActivityLog();
    // Node puts a TTY stdout in BLOCKING mode, so every paint is a synchronous
    // write(2) that returns only when the terminal has drained the pty. That
    // makes the proxy's event loop hostage to its own display: when the
    // terminal emulator pauses — an Electron pane busy elsewhere, a window
    // occluded, the machine dozing — the write sits in the kernel and nothing
    // else runs: no upstream bytes relayed, no request completed, no log line.
    // Measured live: stalls of 5-29s, the main thread in write() under
    // StreamBase::WriteString, with sessions "waiting for API response" and
    // nothing to see anywhere because the thing that would show it is the
    // thing blocked. Non-blocking here, and the paint below drops a frame
    // when the terminal is behind instead of waiting for it.
    this._setStdoutBlocking(false);
    // The other half of that bargain: a non-blocking write reports failure
    // asynchronously, as an 'error' event on the stream, and an unhandled one
    // becomes an uncaughtException that ends the process. So a terminal going
    // away — a pane closed, a pty recreated — took the whole proxy with it, and
    // the hard exit skipped stop() and the state save. A display may no more
    // kill the proxy than block it, so the failure is given somewhere to go
    // before the first write. A handler left over from an earlier start() is
    // dropped first: stop() can leave one attached (see there), and a second
    // would log the same failure twice.
    if (this._stdoutErrorHandler) process.stdout.removeListener('error', this._stdoutErrorHandler);
    this._stdoutDead = false;
    this._stdoutErrorHandler = (/** @type {any} */ err) => this._terminalGone('stdout', err);
    process.stdout.on('error', this._stdoutErrorHandler);
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    // The read side of the same terminal fails the same way (EIO once the pty
    // is gone) and is just as fatal with nobody listening.
    this._stdinErrorHandler = (/** @type {any} */ err) => this._terminalGone('stdin', err);
    process.stdin.on('error', this._stdinErrorHandler);
    // A resize reflows the terminal itself, so the cached frame says nothing
    // about what is on screen — always repaint.
    this._resizeHandler = () => this.render({ force: true });
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    this._origWarn = console.warn;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));
    // warn as well: the one caller (an unrecognised distributeSessions value on
    // reload) otherwise writes raw over the dashboard and misses the log (#414).
    console.warn = (...a) => this._addLog(a.join(' '));

    this._lastFrame = null;   // entering the alt screen always paints
    this.render();
    this._scheduleTick();
    this._startLeftoverWatch();
  }

  /**
   * The terminal reported a failure on either of its streams: it is gone, and
   * every later write would fail the same way.
   *
   * Said once, through the console.error saved before start() patched it — the
   * patched one feeds the activity pane, which is the thing nobody can see any
   * more. Once is enough: the stream stays dead and a line per failed write
   * would say nothing new.
   *
   * The server keeps serving without a display; that a closed pane must not
   * end every routed session is the whole point. An attach client is nothing
   * but its display, so it quits.
   * @param {'stdout' | 'stdin'} stream
   * @param {any} err
   */
  _terminalGone(stream, err) {
    if (this._stdoutDead) return;
    this._stdoutDead = true;
    const report = this._origErr || console.error;
    report(`[Octopus] terminal lost (${stream}: ${err?.code || err?.message || err}); ` +
      (this.remote ? 'closing the attach client' : 'the proxy keeps running without a display'));
    // A failure that arrives after stop() — a write still queued when the
    // operator quit — is only recorded: the exit is already under way.
    if (this.remote && this.running) { this.stop(); this.onQuit?.(); }
  }

  /** Fast while something is animating, slow when there is nothing to animate. */
  _tickDelay() { return this.active.size > 0 ? SPIN_MS : IDLE_TICK_MS; }

  _scheduleTick() {
    if (!this.running) return;
    this.timer = this._setTimeout(() => {
      if (!this.running) return;
      // Only advance the spinner when it is actually on screen; otherwise the
      // frame counter would change every tick and defeat the repaint dedupe.
      if (this.active.size > 0) this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
      this._scheduleTick();
    }, this._tickDelay());
    this.timer.unref?.();
  }

  /**
   * Re-arm the tick after the animating/idle state changes, so a request
   * arriving during an idle tick starts animating now rather than up to
   * IDLE_TICK_MS later.
   */
  _retick() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this._scheduleTick();
  }

  stop() {
    // A login still waiting holds a listener (port 1455, for Codex) and the
    // terminal's bracketed-paste mode; neither may outlive the dashboard.
    const pasteOff = this.login ? PASTE_OFF : '';
    if (this.login) this._loginTimerOff(this.login);
    this.login?.controller.abort();
    this.login = null;
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this._leftoverTimer) { clearInterval(this._leftoverTimer); this._leftoverTimer = null; }
    // Written now rather than dropped: quitting inside the debounce window
    // would otherwise lose the last arrangement the operator saw on screen.
    this._flushOrderSave();
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; if (this._origWarn) console.warn = this._origWarn; }
    if (this._activityStream) { this._activityStream.end(); this._activityStream = null; }
    process.stdin.removeListener('data', this._dataHandler);
    if (this._stdinErrorHandler) { process.stdin.removeListener('error', this._stdinErrorHandler); this._stdinErrorHandler = null; }
    process.stdout.removeListener('resize', this._resizeHandler);
    if (this._drainHandler) { process.stdout.removeListener('drain', this._drainHandler); this._drainHandler = null; }
    // Blocking again for the exit sequence: a non-blocking write can still be
    // queued when the process exits, and a terminal left on the alternate
    // screen with no cursor is the one state an operator cannot recover
    // without knowing the escape by heart.
    this._setStdoutBlocking(true);
    // Restoring the screen is best-effort, and skipped outright for a terminal
    // already known to be gone: there is nobody left to restore it for.
    //
    // The stdout error listener is released only once this last write is
    // confirmed. Flipping back to blocking does not make writes ALREADY QUEUED
    // synchronous, and a failed write is reported as an event after this
    // returns, while shutdown() is still stopping the prober and awaiting a
    // state save. Removing the listener here unconditionally would hand that
    // late EPIPE to nobody and end the process inside exactly that window.
    // Writes complete in order, so a clean callback for this one means nothing
    // the TUI wrote is still outstanding; on failure, or with the terminal
    // already dead, the listener stays and keeps absorbing.
    const guard = this._stdoutErrorHandler;
    const release = (/** @type {any} */ err) => {
      if (err || !guard || this._stdoutErrorHandler !== guard) return;
      process.stdout.removeListener('error', guard);
      this._stdoutErrorHandler = null;
    };
    if (!this._stdoutDead) {
      try { process.stdout.write(`${pasteOff}${ESC}?25h${ESC}?1049l`, release); } catch { /* terminal already gone */ }
    }
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // A title lookup costs a directory scan and a file read, so it stays off the
  // render path: this returns what is cached and schedules the rest.
  _sessionTag(sid) {
    const titles = this.sessionTitles;
    // [local patch] A keep-warm run has no title; say what it is.
    const warm = sid && this.am?.sessionTracker?.isWarm?.(sid) ? 'warm' : null;
    if (!titles?.enabled) return sessionTag(sid, warm);
    return sessionTag(sid, titles.get(sid) || warm, this._sessionTagWidth());
  }

  /** Whether activity rows use the compact format (see compactPathTag). Read
   *  per row off the shared config, so a reload or the settings toggle applies
   *  to the next row. */
  _compactActivity() {
    return this.config?.activityFormat === 'compact';
  }

  /** Columns the session label takes in an activity row, live and completed
   *  alike so the two stay aligned: the configured width, except that compact
   *  rows widen the default (18, which a fresh config also writes out) to
   *  COMPACT_TITLE_WIDTH. Any other width is the operator's and stands. */
  _sessionTagWidth() {
    const w = this.sessionTitles.width;
    return this._compactActivity() && w === DEFAULT_TITLE_WIDTH ? COMPACT_TITLE_WIDTH : w;
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    info = cleanRequestInfo(info);
    // Start the lookup now, so the title is cached by the time the request ends
    // and its log line is composed.
    this._sessionTag(info.sessionId);
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
    if (this.active.size === 1) this._retick();   // idle → animating
  }

  // Called up to twice for one request: with the model as soon as it is peeked
  // from the stream, then with the effort once the whole body is in.
  onRequestModel(id, info) {
    const r = this.active.get(id);
    const { model, effort } = cleanRequestInfo(info);
    if (!r || !(model || effort)) return;
    if (model) r.model = model;
    if (effort) r.effort = effort;
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account == null ? info.account : safeLine(info.account, 64);
  }

  onRequestEnd(id, info) {
    info = cleanRequestInfo(info);
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    const model = modelParen(modelLabel(info.model, info.effort), info.effort, false); // shown when the request named a model
    const sid = info.sessionId || r?.sessionId || null;
    const pin = (info.pinned || r?.pinned) ? dim(' [pin]') : '';
    const compact = this._compactActivity();
    // A 2xx folds into the row above when that row is the same session,
    // account and model (and, in the full format, method and path); anything
    // else is a row of its own. See _addLog.
    const ok = typeof info.status === 'number' && info.status >= 200 && info.status < 300;
    if (this._koLayout()) {
      if (sid) this._sessLast.set(sid, { ok, status: info.status, dur, at: Date.now() });
      if (!ok) this._addLog(`${red(`✗ ${info.status}`)} ${this._sessionTag(sid)} → ${acct}`);
      if (this.active.size === 0) this._retick();
      return;
    }
    const fold = ok
      ? JSON.stringify([compact ? 'c' : 'f', sid || '', acct, modelLabel(info.model, info.effort) || '', compact ? '' : `${info.method} ${info.path}`])
      : null;
    if (compact) {
      const tag = compactPathTag(info.path);
      const what = [tag && dim(tag), model && unlead(model)].filter(Boolean).join(' ');
      this._addLog([this._sessionTag(sid), what, `→ ${acct}${pin}`, `${compactStatus(info.status)}${dur}s`].filter(Boolean).join('  '), { fold });
    } else {
      this._addLog(`${this._sessionTag(sid)} ${info.method} ${info.path}${model} → ${acct}${pin} (${info.status}, ${dur}s)`, { fold });
    }
    if (this.active.size === 0) this._retick();   // animating → idle
  }

  /**
   * One line in the activity pane, and in the activity file when one is open.
   *
   * `fold` is a completed request's fold key (see onRequestEnd). When the
   * newest row on screen carries the same key and was written within
   * ACTIVITY_FOLD_MS, that row is rewritten instead of a new one added: the
   * latest text and time, with `×N` for the requests it now stands for.
   * activityFold: false turns this off. The file keeps one line per request
   * either way.
   * @param {string} msg
   * @param {{ fold?: string|null }} [opts]
   */
  _addLog(msg, { fold = null } = {}) {
    // The screen copy keeps the colour callers painted on, and only that: a
    // request's model string is repainted from this list every frame for as
    // long as the entry lives, so an escape stored here would fire 200 times.
    msg = scrubLine(msg).replace(/^\[Octopus\]\s*/, '');
    const t = timestamp();
    const now = Date.now();
    const head = this.log[0];
    if (fold && this.config?.activityFold !== false && head?.fold?.key === fold && now - head.fold.at <= ACTIVITY_FOLD_MS) {
      head.fold.count++;
      head.fold.at = now;
      head.t = t;
      head.msg = `${msg} ${dim(`×${head.fold.count}`)}`;
    } else {
      this.log.unshift(fold ? { t, msg, fold: { key: fold, count: 1, at: now } } : { t, msg });
      if (this.log.length > 200) this.log.length = 200;
    }
    // sanitizeText, not `strip`: the latter removes SGR colour only, so an
    // erase or cursor-move sequence reached the file, as did a newline.
    if (this._activityStream) this._activityStream.write(`${t}  ${sanitizeText(msg)}\n`);
    if (this.running) this.render();
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    // The login panel reads its input as a stream: see _loginInput.
    if (this.mode === 'login' && this.login) return this._loginInput(this.login, d);
    this._onKeys(d);
  }

  /** One read of keyboard input, as keys. A read is taken whole: an arrow
   *  key's sequence arrives in one read, and a lone ESC is the Esc key.
   *  @param {string} d */
  _onKeys(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b[C') return this._key('right');
    if (d === '\x1b[D') return this._key('left');
    if (d === '\x1b') return this._key('esc');
    if (d === '\r' || d === '\n') return this._key('enter');
    if (d === '\t') return this._key('tab');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');
    if (d.length === 1 && d >= ' ') return this._key(d);
    // [local patch 2026-10-27 원장] 한글 입력기는 자모 하나를 조합 중으로 붙잡았다가 다음 키와
    // 한 번에 내보낸다(ㅈ 뒤 Enter → "ㅈ\r"). 통째로 버리던 것을, 맨 앞 자모를 키로 먼저 처리하고
    // 나머지를 이어 읽는다. 자모는 키 시퀀스의 일부일 수 없고, 글자 입력 화면은 아래 붙여넣기 그대로.
    if (this.mode !== 'input' && this.mode !== 'login' && d.length > 1 && /^[ㄱ-ㆎ]/.test(d)) {
      this._key(d[0]);
      return this._onKeys(d.slice(1));
    }
    // A paste arrives as ONE chunk of many characters, which the line above
    // turns away, so a pasted proxy URL or API key vanished without a sign,
    // and those are exactly the values nobody types by hand. Only a text
    // prompt takes it, and never anything holding an escape: that is a key
    // sequence this parser does not know, not text. Control characters are
    // dropped, the clipboard's trailing newline among them, so a paste fills
    // the prompt and the operator still presses Enter on what they can see.
    // The login panel's field takes one the same way, for a terminal that does
    // not do bracketed paste.
    if ((this.mode === 'input' || this.mode === 'login') && d.length > 1 && !d.includes('\x1b')) {
      if (this.mode === 'input') this.inputBuf += d.replace(/[\x00-\x1f\x7f]/g, '');
      else if (this.login) { this.login.buf += fieldText(d); this.login.error = null; }
      this.render();
    }
  }

  /**
   * One read of input while the login panel is open.
   *
   * The panel turns bracketed paste on, so a paste arrives between markers,
   * and everything inside them is text, even where one character of it would
   * otherwise read as a key. Reads can split anywhere, a marker included, so
   * this is a stream: a tail that could be a marker's start is held back
   * (`held`) until the next read completes it or shows it was not one. What
   * lies outside the markers is keys, handled as _onKeys always has.
   *
   * A new paste replaces what is in the field: pasting again is how a wrong
   * paste is put right. Control characters are dropped, the clipboard's
   * trailing newline among them, so the paste is submitted by an Enter the
   * operator presses on what they can see. An end marker with no start (the
   * start was lost, or the watchdog gave up on it) still ends a paste: what
   * came before it is kept as text.
   *
   * @param {LoginPanel} login
   * @param {string} d
   */
  _loginInput(login, d) {
    this._loginTimerOff(login);
    let data = d;
    if (login.held) {
      const joined = login.held + d;
      if (login.pasting || PASTE_MARKERS.some(m => joined.startsWith(m) || m.startsWith(joined))) {
        data = joined;
        login.held = '';
      } else {
        // What was held was a key of its own (Esc, most likely), not the
        // start of a marker; it goes first, then this read.
        const key = login.held;
        login.held = '';
        this._onKeys(key);
        if (this.login !== login) { if (d) this._onData(d); return; }
      }
    }
    while (data) {
      if (login.pasting) {
        const end = data.indexOf(PASTE_END);
        if (end < 0) {
          const keep = markerTail(data, [PASTE_END]);
          login.buf += fieldText(data.slice(0, data.length - keep));
          login.held = data.slice(data.length - keep);
          this._loginTimer(login, PASTE_IDLE_MS, () => { login.pasting = false; login.held = ''; });
          break;
        }
        login.buf += fieldText(data.slice(0, end));
        login.pasting = false;
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      const start = data.indexOf(PASTE_START);
      const end = data.indexOf(PASTE_END);
      if (end >= 0 && (start < 0 || end < start)) {
        login.buf += fieldText(data.slice(0, end));
        login.error = null;
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      if (start >= 0) {
        if (start > 0) {
          this._onKeys(data.slice(0, start));
          if (this.login !== login) { this._onData(data.slice(start)); return; }
        }
        login.buf = '';
        login.error = null;
        login.pasting = true;
        data = data.slice(start + PASTE_START.length);
        continue;
      }
      const keep = markerTail(data, PASTE_MARKERS);
      login.held = data.slice(data.length - keep);
      if (keep < data.length) this._onKeys(data.slice(0, data.length - keep));
      if (login.held && this.login === login) {
        this._loginTimer(login, ESC_WAIT_MS, () => {
          const key = login.held;
          login.held = '';
          this._onKeys(key);
        });
      }
      break;
    }
    this.render();
  }

  /** Arm the panel's one timer. Only the newest arming may fire, and only
   *  while its panel is still the open one.
   *  @param {LoginPanel} login
   *  @param {number} ms
   *  @param {() => void} fire */
  _loginTimer(login, ms, fire) {
    const gen = ++login.timerGen;
    login.timer = this._setTimeout(() => {
      if (this.login !== login || login.timerGen !== gen) return;
      login.timer = null;
      fire();
      if (this.running) this.render();
    }, ms);
    login.timer?.unref?.();
  }

  /** @param {LoginPanel} login */
  _loginTimerOff(login) {
    login.timerGen++;
    if (login.timer) { clearTimeout(login.timer); login.timer = null; }
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }
    if (this.mode !== 'input' && this.mode !== 'login') k = normalizeHotkey(k);

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
      case 'settings': this._keySettings(k); break;
      case 'routes': this._keyRoutes(k); break;
      case 'pick': this._keyPick(k); break;
      case 'blocklist': this._keyBlocklist(k); break;
      case 'login': this._keyLogin(k); break;
      case 'move': this._keyMove(k); break;
      case 'focus': this._keyFocus(k); break;
      case 'cleanup': this._keyCleanup(k); break;
      case 'warm': this._keyWarm(k); break;
    }
    this.render();
  }

  _keyNormal(k) {
    if (k === 'q') { this.stop(); this.onQuit?.(); }
    else if (k === 's' && this.am.accounts.length > 0) {
      // currentIndex is -1 when nothing is marked current (attach mode, when the
      // server names an account that has since gone); start at the top instead.
      this.mode = 'select'; this.selAction = 'switch'; this.selIdx = Math.max(0, this.am.currentIndex); this.selRoute = null; this.selReturn = 'normal';
    }
    else if (k === 'r' || k === 'R') { this._doSync(); }
    // Available in attach mode too: there the move is a request to the server.
    // [local patch 2026-10-27 원장] 대문자도 받는다(Shift 를 눌러 안 되던 일).
    else if ((k === 'm' || k === 'M') && this.am.accounts.length > 0) { this._openMove(); }
    // 집중 계정은 서버 설정이라 attach 모드에서는 안내만.
    else if ((k === 'f' || k === 'F') && this.remote) { this._addLog('집중 계정은 서버 화면(octopus server)에서 지정하세요'); }
    // The keys below all edit local state or call out to Anthropic, neither of
    // which attach mode can do — the server owns both.
    else if (this.remote) { /* nothing else is available here */ }
    else if (k === 'd' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'toggle'; this.selIdx = this.am.currentIndex; this.selReturn = 'normal';
    }
    // [local patch 2026-10-28 원장] N(ㅜ): 새 계정 로그인 — 줄을 고르지 않고 바로 브라우저 로그인.
    else if (k === 'n' && this.loginAccount) { this._doLoginNew(); }
    // [local patch 2026-10-28 원장] O(ㅐ): 계정 순서 바꾸기 — 설정 화면의 「Reorder accounts」를 바로 연다.
    // ↑↓ 고르기, ← 위로 · → 아래로(옮기는 즉시 적용, 키를 멈추면 저장), Enter/Esc 끝.
    else if (k === 'o' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'reorder'; this.selIdx = this._arrangeable()[0] ?? 0; this.selReturn = 'normal';
    }
    else if (k === 'p' && this.am.accounts.length > 0) { this._doProbe(); }
    // [local patch 2026-10-27 원장] W: 5시간 창이 안 도는 계정을 보여 주고 Enter 로 지금 켠다.
    else if (k === 'w' && this.am.accounts.length > 0) { this._openWarm(); }
    else if ((k === 'f' || k === 'F') && this.am.accounts.length > 0) { this._openFocus(); }
    else if (k === 'x' && this._cleanupAvailable()) { this._openCleanup(); }
    // Re-login: an OAuth account whose refresh token upstream has rejected stays
    // in 'error' until someone signs in again, and that someone is usually
    // looking at this screen. The cursor starts on the first account that needs
    // it, so the common case is `l`, Enter.
    else if (k === 'l' && this.loginAccount && this.am.accounts.length > 0) {
      const order = this._displayOrder();
      const broken = order.find((/** @type {number} */ i) => this.am.accounts[i]?.status === 'error');
      this.mode = 'select'; this.selAction = 'login'; this.selReturn = 'normal';
      this.selIdx = broken ?? order[0] ?? 0;
    }
    else if (k === 'g') { this.mode = 'settings'; this.setIdx = 0; this._loadSxBalance(); }
    else if (k === 'h') { this._toggleHideSpent(); }
    // [local patch 2026-10-27 원장] B: 계정 빼기(설정에서 지움 — 다시 쓰려면 다시 로그인). Enter 두 번으로 확인.
    else if (k === 'b' && this.am.accounts.length > 0) {
      const order = this._displayOrder();
      const spent = order.find((/** @type {number} */ i) => this._isWeeklySpent(i));
      this.mode = 'select'; this.selAction = 'removeKo'; this.selReturn = 'normal'; this._removeArmed = null;
      this.selIdx = spent ?? order[0] ?? 0;
    }
  }

  // Navigable rows on the settings screen, top to bottom. Both the renderer and
  // the key handler build this list so the cursor and the display stay in sync.
  // Rows are conditional (sx.org rows only when that build feature is present),
  // so always index through the returned array — never hard-code positions.
  _settingsFields() {
    const fields = [];

    // A per-bucket table can't be edited from a single ±1% control, and writing
    // a plain number over it would silently discard the operator's per-bucket
    // values. So the row shows the table and sends them to the config file.
    const perBucket = this._perBucketThresholds();
    fields.push(perBucket ? {
      id: 'threshold',
      label: 'Switch threshold',
      hint: 'per-bucket — edit config',
      value: () => green(perBucket),
    } : {
      id: 'threshold',
      label: 'Switch threshold',
      hint: '←→ ±1%',
      value: () => green(formatPercent(this.am.effectiveThreshold ?? this.config.switchThreshold ?? 0.98)),
      left: () => this._nudgeThreshold(-1),
      right: () => this._nudgeThreshold(+1),
      enter: () => this._promptInput('Switch threshold % (1-100, tenths allowed)', v => this._doSetThreshold(v.trim())),
    });

    // Fleet-scoped because the policy behind it is: a credit is spent only when
    // the whole Codex pool is dry (and, for a banked Claude reset, the whole
    // Claude pool). It sits here, on the screen, rather than in
    // the config file alone because the one thing an operator needs from this
    // setting is to be able to kill it at once.
    fields.push({
      id: 'autoRedeemResets',
      label: 'Auto-redeem',
      hint: '←→ toggle',
      value: () => (this.config.autoRedeemResets === true ? green('on') : gray('off')),
      left: () => this._toggleAutoRedeemResets(),
      right: () => this._toggleAutoRedeemResets(),
      enter: () => this._toggleAutoRedeemResets(),
    });

    fields.push({
      id: 'rebalance',
      label: 'Idle rebalance',
      hint: '←→ toggle, Enter idle secs',
      value: () => {
        const rb = rebalanceSetting(this.config.rebalanceSessions);
        return rb.enabled ? green(`on, after ${rb.idleSeconds}s idle`) : gray('off');
      },
      left: () => this._toggleRebalance(),
      right: () => this._toggleRebalance(),
      enter: () => this._promptInput('Idle rebalance: seconds idle before a move (0=off, min 60)', v => this._doSetRebalanceIdle(v.trim())),
    });

    fields.push({
      id: 'probe',
      label: 'Quota probe',
      hint: '←→ ±30s',
      value: () => {
        const probe = this.config.quotaProbeSeconds || 0;
        return probe > 0 ? green(`${probe}s`) : gray('off (passive)');
      },
      left: () => this._nudgeProbe(-30),
      right: () => this._nudgeProbe(+30),
      enter: () => this._promptInput('Quota probe seconds (0=off, min 30)', v => this._doSetProbe(v.trim())),
    });

    fields.push({
      id: 'quotaBarPercent',
      label: 'Bar percentage',
      hint: '←→ toggle',
      value: () => (this.config.quotaBarPercent === true ? green('on') : gray('off')),
      left: () => this._toggleQuotaBarPercent(),
      right: () => this._toggleQuotaBarPercent(),
      enter: () => this._toggleQuotaBarPercent(),
    });

    fields.push({
      id: 'sessionRows',
      label: 'Sessions panel',
      hint: '←→ toggle',
      value: () => (this.config.sessionRows !== false ? green('on') : gray('off')),
      left: () => this._toggleSessionRows(),
      right: () => this._toggleSessionRows(),
      enter: () => this._toggleSessionRows(),
    });

    fields.push({
      id: 'hostLine',
      label: 'Host line',
      hint: '←→ toggle',
      value: () => (this.config.hostLine !== false ? green('on') : gray('off')),
      left: () => this._toggleHostLine(),
      right: () => this._toggleHostLine(),
      enter: () => this._toggleHostLine(),
    });

    fields.push({
      id: 'eventlog',
      label: 'Event logging',
      hint: '←→ cycle',
      value: () => {
        const m = this.config.eventLogging || 'hide';
        return m === 'show' ? green('show')
          : m === 'block' ? red('block')
          : gray('hide');
      },
      left: () => this._cycleEventLogging(-1),
      right: () => this._cycleEventLogging(+1),
      enter: () => this._cycleEventLogging(+1),
    });

    fields.push({
      id: 'activityFormat',
      label: 'Activity format',
      hint: '←→ toggle',
      value: () => (this._compactActivity() ? green('compact') : gray('full')),
      left: () => this._toggleActivityFormat(),
      right: () => this._toggleActivityFormat(),
      enter: () => this._toggleActivityFormat(),
    });

    fields.push({
      id: 'activityFold',
      label: 'Fold activity',
      hint: '←→ toggle',
      value: () => (this.config.activityFold !== false ? green('on') : gray('off')),
      left: () => this._toggleActivityFold(),
      right: () => this._toggleActivityFold(),
      enter: () => this._toggleActivityFold(),
    });

    fields.push({
      id: 'clientMode',
      label: 'Client mode',
      hint: '←→ toggle',
      value: () => (this.config.defaultClientMode === 'base-url' ? yellow('base-url') : green('mitm')),
      left: () => this._toggleClientMode(),
      right: () => this._toggleClientMode(),
      enter: () => this._toggleClientMode(),
    });

    if (this.sessionTitles) {
      fields.push({
        id: 'sessionTitles',
        label: 'Session titles',
        hint: '←→ toggle',
        value: () => (this.sessionTitles.enabled ? green('on') : gray('off')),
        left: () => this._toggleSessionTitles(),
        right: () => this._toggleSessionTitles(),
        enter: () => this._toggleSessionTitles(),
      });
    }

    fields.push({
      id: 'routes',
      label: 'Manage routing',
      hint: 'Enter to open',
      value: () => {
        const n = (this.config.routes || []).length;
        return n ? green(`${n} route${n === 1 ? '' : 's'}`) : gray('none');
      },
      enter: () => { this.mode = 'routes'; this.routeIdx = 0; },
    });

    fields.push({
      id: 'blocklist',
      label: 'Blocked models',
      hint: 'Enter to edit',
      value: () => {
        const n = (this.config.blockedModels || []).length;
        return n ? red(`${n} blocked`) : gray('none');
      },
      enter: () => { this.mode = 'blocklist'; this.blockIdx = 0; },
    });

    fields.push({
      id: 'addAccount',
      label: 'Add account',
      hint: 'Enter to open',
      value: () => {
        const n = this.am.accounts.length;
        return n ? green(`${n} account${n === 1 ? '' : 's'}`) : gray('none');
      },
      enter: () => { this.mode = 'add'; },
    });

    if (this.am.accounts.length > 0) {
      fields.push({
        id: 'removeAccount',
        label: 'Remove account',
        hint: 'Enter to pick',
        value: () => dim('—'),
        enter: () => { this.mode = 'select'; this.selAction = 'remove'; this.selIdx = this._displayOrder()[0] ?? 0; this.selReturn = 'settings'; },
      });
    }

    // Two arrangeable rows is the least that can be arranged. Below that the
    // row would open a screen on which no key does anything.
    if (this._arrangeable().length > 1) {
      fields.push({
        id: 'orderAccounts',
        label: 'Reorder accounts',
        hint: 'Enter to arrange',
        value: () => dim('—'),
        enter: () => { this.mode = 'select'; this.selAction = 'reorder'; this.selIdx = this._arrangeable()[0] ?? 0; this.selReturn = 'settings'; },
      });
    }

    if (this.am.accounts.length > 1) {
      fields.push({
        id: 'accountSort',
        label: 'Sort accounts',
        hint: '←→ cycle',
        value: () => {
          const s = this._accountSort();
          return s === 'arranged' ? gray(ACCOUNT_SORT_LABELS[s]) : green(ACCOUNT_SORT_LABELS[s]);
        },
        left: () => this._cycleAccountSort(-1),
        right: () => this._cycleAccountSort(+1),
        enter: () => this._cycleAccountSort(+1),
      });
    }

    fields.push({
      id: 'upstreamProxy',
      label: 'Upstream proxy',
      hint: 'Enter to set',
      value: () => {
        const resolved = getUpstreamProxy();
        const { proxy, source } = resolved;
        // A dropped self-proxy reads as "(direct)" too, and the operator would
        // have no way to tell that a value they set is not in force.
        if (!proxy) return source === 'self' ? dim('(direct) ') + gray(describeSelfProxy(resolved)) : dim('(direct)');
        // Name the environment when that is where it came from: a value the
        // operator did not put in the config, silently in force, is exactly the
        // thing that is hard to account for later.
        const via = source.startsWith('env:') ? gray(` (${source.slice(4)})`) : '';
        return green(describeProxy(proxy)) + via;
      },
      enter: () => this._promptInput('Upstream proxy (host:port, or blank for direct)', v => this._doSetUpstreamProxy(v.trim())),
    });

    // ONE account's own proxy (accounts[].routing), beside the fleet's: the two
    // answer the same question at different scopes. Named "proxy", not
    // "routing": "Manage routing" above is the per-model routes screen, and two
    // rows sharing a word would send the operator to the wrong one.
    if (this.am.accounts.length > 0) {
      fields.push({
        id: 'accountProxy',
        label: 'Account proxy',
        hint: 'Enter to pick',
        value: () => {
          const n = this.am.accounts.filter((/** @type {any} */ a) => a.routing).length;
          return n ? green(`${n} of ${this.am.accounts.length} routed`) : dim('(none)');
        },
        enter: () => { this.mode = 'select'; this.selAction = 'routing'; this.selIdx = this._displayOrder()[0] ?? 0; this.selReturn = 'settings'; },
      });
    }

    if (this.sx) {
      fields.push({
        id: 'sxmode',
        label: 'sx.org mode',
        hint: '←→ cycle',
        value: () => {
          const mode = this.sx.getMode();
          return mode === 'always' ? green('always')
            : mode === '429' ? cyan('on 429 only')
            : gray('off');
        },
        left: () => this._cycleSxMode(-1),
        right: () => this._cycleSxMode(+1),
        enter: () => this._cycleSxMode(+1),
      });

      fields.push({
        id: 'sxkey',
        label: 'sx.org API key',
        hint: 'Enter to set',
        value: () => {
          return this.config.sx?.apiKey ? maskKey(this.config.sx.apiKey) : dim('(not set)');
        },
        enter: () => this._promptInput('sx.org API key', v => this._doSetSxKey(v.trim()), { secret: true }),
      });

      if (this.config.sx?.apiKey) {
        fields.push({
          id: 'sxclear',
          label: 'Clear sx.org key',
          hint: 'Enter to clear',
          value: () => dim('—'),
          enter: () => this._doClearSxKey(),
        });
      }
    }

    return fields;
  }

  _keySettings(k) {
    const fields = this._settingsFields();
    const n = fields.length;
    if (n > 0 && this.setIdx >= n) this.setIdx = n - 1;
    const f = fields[this.setIdx];

    if (k === 'up' || k === 'k') this.setIdx = (this.setIdx - 1 + n) % n;
    else if (k === 'down' || k === 'j') this.setIdx = (this.setIdx + 1) % n;
    else if (k === 'left') f?.left?.();
    else if (k === 'right') f?.right?.();
    else if (k === 'enter') f?.enter?.();
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  // Open the text-input prompt and return to the settings screen afterward.
  // `secret` masks the echo — the footer is on screen for as long as a key is
  // being typed, and a terminal is the one thing a screen-share always shows.
  _promptInput(prompt, cb, { secret = false } = {}) {
    this.mode = 'input';
    this.inputReturn = 'settings';
    this.inputPrompt = prompt;
    this.inputBuf = '';
    this.inputSecret = secret;
    this.inputCb = v => { if (v) cb(v); };
  }

  _nudgeThreshold(deltaPct) {
    // Stepping from the exact percent, not a rounded one, so a threshold set to
    // a tenth keeps its fraction instead of snapping to the nearest whole.
    const cur = (this.am.effectiveThreshold ?? this.config.switchThreshold ?? 0.98) * 100;
    const next = Math.max(1, Math.min(100, cur + deltaPct));
    if (next !== cur) return this._doSetThreshold(String(next));
  }

  /** A one-line rendering of a per-bucket threshold table, or null when the
   * threshold is a single number. */
  _perBucketThresholds() {
    const t = this.am.switchThreshold ?? this.config.switchThreshold;
    if (!t || typeof t !== 'object') return null;
    const pct = v => `${Math.round(v * 100)}%`;
    return Object.entries(t)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .map(([k, v]) => `${k}:${pct(v)}`)
      .join(' ');
  }

  _nudgeProbe(deltaSec) {
    const cur = this.config.quotaProbeSeconds || 0;
    const next = Math.max(0, cur + deltaSec);
    if (next !== cur) this._doSetProbe(String(next));
  }

  async _doSetThreshold(input) {
    const pct = Number(input);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      this._addLog('Invalid threshold — enter 1–100'); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    // Tenths of a percent are kept; anything finer is quantised so the stored
    // value is the one the screen shows.
    const v = Math.round(pct * 10) / 1000;
    const prev = { config: this.config.switchThreshold, live: this.am.switchThreshold };
    this.config.switchThreshold = v;
    this.am.switchThreshold = v; // apply to the running rotation immediately
    if (!await this._saveSetting('switch threshold', () => {
      this.config.switchThreshold = prev.config;
      this.am.switchThreshold = prev.live;
    })) { this.mode = 'settings'; if (this.running) this.render(); return; }
    this._addLog(`Switch threshold set to ${formatPercent(v)}`);
    this.mode = 'settings';
    if (this.running) this.render();
  }

  async _doSetProbe(input) {
    let secs = parseInt(input, 10);
    if (Number.isNaN(secs) || secs < 0) {
      this._addLog('Invalid interval — enter 0 (off) or seconds'); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    if (secs > MAX_PROBE_SECONDS) {
      this._addLog(`Invalid interval — at most ${MAX_PROBE_SECONDS}s (7 days)`); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    if (secs > 0 && secs < 30) secs = 30; // match the CLI minimum (don't hammer the usage endpoint)
    this.config.quotaProbeSeconds = secs;
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    // syncAccounts re-reads disk config and reschedules the running prober live.
    try { await this.syncAccounts(); }
    catch (e) { this._addLog(`Reload failed: ${e.message}`); }
    this._addLog(secs > 0 ? `Quota probe every ${secs}s` : 'Quota probe disabled');
    this.mode = 'settings';
    if (this.running) this.render();
  }

  _keySelect(k) {
    // Step through the rows AS DRAWN (_displayOrder), while selIdx itself stays
    // a manager index — everything it feeds (switch, toggle, remove, route pins)
    // addresses an account by that index, not by its position on screen.
    //
    // Reorder mode walks the arrangeable rows only: a locally-served row is
    // drawn but cannot be moved, so stopping on one would be a dead cursor.
    const order = this.selAction === 'reorder' ? this._arrangeable() : this._displayOrder();
    const pos = order.indexOf(this.selIdx);
    if (k === 'up' || k === 'k') this.selIdx = order[Math.max(0, pos - 1)] ?? this.selIdx;
    else if (k === 'down' || k === 'j') this.selIdx = order[Math.min(order.length - 1, pos + 1)] ?? this.selIdx;
    // Tab / ←→ (switch only): cycle which route the pick applies to. null = the
    // global default account; each getRoutes() entry = a per-route manual pin.
    // ↑↓ move within the account list, so ←→ are free to move across targets.
    // Pins are runtime state of the server's rotation, so attach mode — which
    // can only ask for the default account — leaves these keys alone.
    else if ((k === 'tab' || k === 'right') && this.selAction === 'switch' && !this.remote) this._cycleSelRoute(+1);
    else if (k === 'left' && this.selAction === 'switch' && !this.remote) this._cycleSelRoute(-1);
    // ←→ in reorder mode move the ACCOUNT, not the cursor. ↑↓ already walk the
    // rows, so this is the pair left over, and ←→ is what "change the thing the
    // cursor is on" already means on the settings screen this is opened from.
    // The cursor does not move with the key: `selIdx` names the account being
    // dragged, and the row it marks travels with it.
    else if ((k === 'left' || k === 'h') && this.selAction === 'reorder') this._doMoveAccount(-1);
    else if ((k === 'right' || k === 'l') && this.selAction === 'reorder') this._doMoveAccount(+1);
    else if (k === 'enter' && this.selAction === 'removeKo') {
      if (this._removeArmed === this.selIdx) {
        this._removeArmed = null;
        this._doRemove(this.selIdx);
        this.mode = this.selReturn;
      } else {
        this._removeArmed = this.selIdx;
      }
    }
    else if (k === 'enter') {
      if (this.selAction === 'switch') {
        this._doSwitchSelection();
      } else if (this.selAction === 'toggle') {
        this._doToggleDisabled(this.selIdx);
      } else if (this.selAction === 'login') {
        this._doLogin(this.selIdx);
      } else if (this.selAction === 'reorder') {
        // Every move is already applied, so Enter only means "done" — and it
        // has to be caught here, ahead of the remove branch below, which is
        // what an unlisted action falls into.
      } else if (this.selAction === 'routing') {
        // Opens the URL prompt, which leaves select mode by itself; the mode
        // check below then has nothing to undo.
        this._promptAccountRouting(this.selIdx);
      } else {
        this._doRemove(this.selIdx);
      }
      if (this.mode === 'select') this.mode = this.selReturn;
    }
    else if (k === 'esc' || k === 'q') { this.mode = this.selReturn; }
    // Leaving the reorder screen by either key writes a move still waiting on
    // its timer, so "done" means on disk. A no-op for every other action.
    if (this.mode !== 'select') this._flushOrderSave();
  }

  // Step the switch-mode pin target by `dir` through [default, ...routes],
  // wrapping at both ends. A route that vanished between renders (an autocreated
  // family route whose quota expired) leaves us at the default rather than
  // stranding the cursor.
  _cycleSelRoute(dir) {
    const routes = this.am.getRoutes();
    const cycle = [null, ...routes];
    const at = this.selRoute ? routes.findIndex(r => r.name === this.selRoute.name) + 1 : 0;
    const from = at < 1 ? 0 : at; // findIndex -1 → 0 → treat as the default entry
    this.selRoute = cycle[(from + dir + cycle.length) % cycle.length];
  }

  // Apply an Enter in switch mode: with no route selected this sets the global
  // default account; with a route selected it pins/unpins that route to the
  // highlighted account. On a rejected pin we stay in select mode so the user can
  // retry, rather than silently returning to normal.
  _doSwitchSelection() {
    const acct = this.am.accounts[this.selIdx];
    // The list can shrink under the cursor between polls in attach mode. Say so
    // rather than swallowing the keypress.
    if (!acct) { this.mode = 'normal'; this._addLog('That account is no longer listed'); return; }
    // Attach mode: the rotation lives in another process, so this is a request
    // whose result the next poll reflects, not a local assignment.
    if (this.applySwitch) { this.mode = 'normal'; this._doSwitchRemote(acct); return; }
    if (this.selRoute === null) {
      this.am.setCurrentAccount(this.selIdx);
      this._addLog(`Switched to "${acct.name}"`);
      this.mode = 'normal';
      return;
    }
    const name = this.selRoute.name;
    if (this.am.getRoutePin(name) === acct) {
      this.am.clearRoutePin(name); // Enter on the current pin toggles it off
      this._addLog(`Unpinned route "${name}"`);
      this.mode = 'normal';
      return;
    }
    const res = this.am.setRoutePin(name, this.selIdx);
    if (res.ok) {
      this._addLog(`Pinned "${acct.name}" for route "${name}"`);
      this.mode = 'normal';
    } else {
      this._addLog(`Can't pin: ${res.reason}`); // stay in select mode to retry
    }
  }

  // Ask the running server to switch. A failure is reported as one, so the
  // dashboard never implies a switch that the server refused.
  async _doSwitchRemote(acct) {
    try {
      const res = await this.applySwitch(acct.name);
      // The server resolves the name it was given and echoes what it settled on;
      // prefer that over what was highlighted here. `eligible: false` means the
      // switch applied to an account that cannot currently serve requests, which
      // the row already shows but is worth stating at the moment it is chosen.
      const name = res?.account ? safeLine(res.account, 64) || acct.name : acct.name;
      if (res?.eligible === false) {
        // The server knows WHY — disabled, out of quota, outranked by a
        // higher-priority account — so quote it rather than restating the
        // generic case. Control characters and length are clamped: this string
        // arrives over the wire and is drawn into a fixed-width frame.
        // The server's reasons are phrased to follow "<name> is ...", so they are
        // composed that way here too.
        const given = typeof res.reason === 'string' ? res.reason.replace(/\p{C}/gu, ' ').trim().slice(0, 60) : '';
        this._addLog(`Switched to "${name}" — ${given ? `it is ${given}` : 'it cannot serve requests right now'}`);
      } else {
        this._addLog(`Switched to "${name}"`);
      }
    } catch (e) {
      this._addLog(`Switch failed: ${e.message}`);
    }
    if (this.running) this.render();
  }

  // The add chooser is opened from the settings screen (g → Add account), so
  // every exit path returns there.
  _keyAdd(k) {
    if (k === 'i') { this._doImport(); this.mode = 'settings'; }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputReturn = 'settings';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputSecret = true;
      this.inputCb = v => { if (v) this._doAddKey(v); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'settings'; }
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = this.inputReturn; this.inputCb = null; this.inputBuf = ''; this.inputSecret = false;
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = this.inputReturn; this.inputCb = null; this.inputBuf = ''; this.inputSecret = false; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // The login panel. Esc cancels the sign-in and Enter submits the field. `c`
  // (copy the link again) acts only while the field is empty: typing must work
  // in it, and nobody types a code that starts with it before pasting has been
  // tried.
  _keyLogin(/** @type {string} */ k) {
    const login = this.login;
    if (!login) { this.mode = 'normal'; return; }
    if (k === 'esc') {
      login.controller.abort();
      this._closeLogin();
    } else if (k === 'enter') {
      this._submitLogin(login);
    } else if (k === 'bs') {
      login.buf = login.buf.slice(0, -1);
      login.error = null;
    } else if (!login.buf && k === 'c') {
      if (this._copyLoginUrl(login)) login.notice = 'Sent again.';
    } else if (k.length === 1 && fieldText(k)) {
      login.buf += k;
      login.error = null;
    }
  }

  /**
   * Enter in the login panel. A paste the flow takes closes the panel: the
   * token exchange runs on, and _doLogin reports how it ended. One it refuses
   * stays open with the reason, and the field is emptied for the next try.
   * @param {LoginPanel} login
   */
  _submitLogin(login) {
    if (!login.prompt || !login.buf.trim()) return;
    try {
      // false means nothing was left to settle (the browser got there first),
      // so the panel has nothing more to wait for either.
      login.prompt.submit(login.buf);
      this._closeLogin();
    } catch (/** @type {any} */ e) {
      login.error = safeLine(e?.message || String(e), 300);
      login.buf = '';
    }
  }

  // ── account operations ─────────────────────────────

  // On-demand fleet-wide quota refresh (the `p` key): probe every OAuth
  // account's zero-spend usage endpoint once, whether or not the periodic
  // probe is enabled. Fire-and-forget; progress lands in the activity log.
  async _doProbe() {
    if (!this.probeQuota) { this._addLog('Quota probe unavailable'); return; }
    if (this._probing) return; // one refresh at a time
    const n = this.am.accounts.filter(a => a.type === 'oauth' && a.credential).length;
    if (n === 0) { this._addLog('No OAuth accounts to probe'); return; }
    this._probing = true;
    this._addLog(`Refreshing quota on ${n} account${n === 1 ? '' : 's'}...`);
    try {
      await this.probeQuota();
      this._addLog('Quota refresh complete');
    } catch (e) {
      this._addLog(`Quota refresh failed: ${e.message}`);
    } finally {
      this._probing = false;
    }
  }

  // [local patch 2026-10-27 원장] `w`: 5시간 창이 안 도는 계정에 짧은 메시지를 하나씩 보내 창을
  // 지금 시작시킨다(warmer.js 와 같은 방식, 켜기 간격·일정 설정과 별개로 한 번만).
  // 주간을 다 쓴 계정은 켜 봐야 못 쓰므로 뺀다. 대상은 * 로 보여 주고 Enter 로 확인한다.
  _warmPicks() {
    const list = this.warmCandidates?.();
    if (!Array.isArray(list)) return [];
    return list.filter(a => {
      const i = this.am.accounts.indexOf(a);
      return i >= 0 && !this._isWeeklySpent(i);
    });
  }

  _openWarm() {
    if (!this.warmNow || !this.warmCandidates) { this._addLog('5시간 켜기를 쓸 수 없습니다'); return; }
    if (this._warming) { this._addLog('5시간 켜는 중입니다 — 끝난 뒤 다시 누르세요'); return; }
    const picks = this._warmPicks();
    if (picks.length === 0) { this._addLog('켤 계정이 없습니다 — 모두 5시간이 이미 돌고 있거나 쓸 수 없는 계정이에요'); return; }
    this._warmPick = picks;
    this.mode = 'warm';
  }

  _keyWarm(/** @type {string} */ k) {
    if (k === 'esc') { this._warmPick = null; this.mode = 'normal'; return; }
    if (k !== 'enter') return;
    const picks = this._warmPick || [];
    this._warmPick = null;
    this.mode = 'normal';
    this._doWarm(picks);
  }

  /** @param {any[]} picks */
  async _doWarm(picks) {
    if (this._warming || picks.length === 0) return;
    const short = (/** @type {any} */ a) => String(a.name).replace(KO_DOMAIN_RE, '');
    const warming = this._warming = new Set(picks);
    this._addLog(`5시간 켜기 시작: ${picks.length}개 (${picks.map(short).join(', ')})`);
    try {
      const res = await this.warmNow?.(picks, {
        onDone: (/** @type {any} */ a, /** @type {any} */ s) => {
          warming.delete(a);
          if (s?.status === 'error') this._addLog(red(`✗ ${short(a)} 5시간 켜기 실패: ${s.error}`));
          else if (this.running) this.render();
        },
      });
      if (res == null) { this._addLog('다른 켜기가 돌고 있습니다 — 끝난 뒤 다시 누르세요'); return; }
      const n = (/** @type {string} */ st) => res.filter(r => r.status === st).length;
      const ok = n('ok'), fail = n('error'), skip = n('skipped');
      const tail = `${fail ? ` · 실패 ${fail}` : ''}${skip ? ` · 건너뜀 ${skip}(그새 켜졌거나 멈춤)` : ''}`;
      this._addLog(`${ok ? green(`5시간 켬 ${ok}개`) : '5시간 켬 0개'}${tail}`);
    } catch (e) {
      this._addLog(red(`5시간 켜기 실패: ${/** @type {Error} */ (e).message}`));
    } finally {
      this._warming = null;
      if (this.running) this.render();
    }
  }

  // Sign-in for the account under the cursor (the `l` key). The row chooses
  // the PROVIDER's sign-in page and tells the operator which identity to sign
  // in as; it does not choose where the tokens go. They go to the account the
  // browser actually signed in as — the same identity match `teamclaude login`
  // makes — because writing one person's tokens onto the row that was merely
  // highlighted would be a credential crossing. So a sign-in as someone else is
  // reported as exactly that, and the picked row stays in need of one.
  //
  // The login panel opens at once and holds the keyboard until the flow is
  // decided: it shows the link (the browser may be on another machine), copies
  // it, and takes the pasted answer. Fire-and-forget all the same: the flow
  // waits on a human for minutes, and the requests and the activity pane go on
  // meanwhile.
  async _doLogin(/** @type {number} */ idx) {
    const acct = this.am.accounts[idx];
    if (!acct) { this._addLog('That account is no longer listed'); return; }
    if (!this.loginAccount) { this._addLog('Login unavailable'); return; }
    if (acct.type !== 'oauth') { this._addLog(`"${acct.name}" is not an OAuth account — nothing to sign in to`); return; }
    // An importFrom row owns no tokens of its own: every reload re-reads the
    // file it points at, so tokens the upsert wrote onto the row would be
    // ignored on the next reload and the account would land back in `error`.
    const entry = acct.id ? this.config?.accounts?.find((/** @type {any} */ c) => c.id === acct.id) : null;
    if (entry?.importFrom) { this._addLog(`"${acct.name}" reads its tokens from ${entry.importFrom} — sign in there instead`); return; }
    // One at a time: a second flow would race the first for the browser, and
    // for Codex for the fixed callback port as well.
    if (this._loggingIn) { this._addLog(`Still waiting on the sign-in for "${this._loggingIn}"`); return; }
    this._loggingIn = acct.name;
    const controller = new AbortController();
    this._openLogin(acct.name, controller);
    try {
      const outcome = await this.loginAccount(acct, {
        signal: controller.signal,
        onPrompt: prompt => this._loginPrompted(controller, prompt),
      });
      if (outcome?.name && outcome.name !== acct.name) {
        this._addLog(`Signed in as "${outcome.name}" (${outcome.action}), not "${acct.name}" — that one still needs a login`);
      } else {
        this._addLog(`Logged in "${acct.name}"`);
      }
      // [local patch 2026-10-28 원장] 결제 전 계정: 꺼 둔 채 추적만, 결제되면 자동으로 켬.
      if (outcome?.pendingPlan) this._addLog(`「${outcome.name || acct.name}」 결제 전(Pro/Max 아님) — 꺼 둔 채 추적만 하고, 결제가 확인되면 자동으로 켭니다 (R 로 바로 확인)`);
    } catch (/** @type {any} */ e) {
      // A cancel is the operator's own Esc: one line saying so, not a failure.
      this._addLog(e?.name === 'AbortError'
        ? `Sign-in cancelled for "${acct.name}"`
        : `Login failed for "${acct.name}": ${e?.message || e}`);
    } finally {
      this._loggingIn = null;
      if (this.login?.controller === controller) this._closeLogin();
      if (this.running) this.render();
    }
  }

  /** [local patch 2026-10-28 원장] N: 새 계정 로그인. 줄(계정)을 고르지 않고 바로 브라우저 로그인을
   *  시작한다 — 로그인한 이메일로 새 줄이 생기고, 이미 있는 계정이면 그 줄의 로그인이 새로 된다.
   *  나머지(패널·취소·한 번에 하나)는 _doLogin 과 같다. */
  async _doLoginNew() {
    if (!this.loginAccount) { this._addLog('Login unavailable'); return; }
    if (this._loggingIn) { this._addLog(`Still waiting on the sign-in for "${this._loggingIn}"`); return; }
    const label = '새 계정';
    this._loggingIn = label;
    const controller = new AbortController();
    this._openLogin(label, controller);
    try {
      const outcome = await this.loginAccount(null, {
        signal: controller.signal,
        onPrompt: prompt => this._loginPrompted(controller, prompt),
      });
      const nm = outcome?.name || '?';
      this._addLog(outcome?.action === 'updated'
        ? `「${nm}」은 이미 있는 계정 — 그 줄의 로그인을 새로 했습니다`
        : `「${nm}」 계정을 넣었습니다`);
      if (outcome?.pendingPlan) this._addLog(`「${nm}」 결제 전(Pro/Max 아님) — 꺼 둔 채 추적만 하고, 결제가 확인되면 자동으로 켭니다 (R 로 바로 확인)`);
    } catch (/** @type {any} */ e) {
      this._addLog(e?.name === 'AbortError'
        ? '새 계정 로그인을 취소했습니다'
        : `새 계정 로그인 실패: ${e?.message || e}`);
    } finally {
      this._loggingIn = null;
      if (this.login?.controller === controller) this._closeLogin();
      if (this.running) this.render();
    }
  }

  /** Open the login panel for `account`, before the flow is even listening, so
   *  Esc can cancel it from the first moment.
   *  @param {string} account
   *  @param {AbortController} controller */
  _openLogin(account, controller) {
    this.login = {
      account, controller, prompt: null, buf: '', error: null, notice: null,
      pasting: false, held: '', timer: null, timerGen: 0,
      linkId: `teamclaude-login-${++this._loginSeq}`,
    };
    this.mode = 'login';
    this._writeTerminal(PASTE_ON);
  }

  /** The flow is listening: show its link and copy it, unless the panel was
   *  closed (or another login opened) in the meantime.
   *  @param {AbortController} controller
   *  @param {LoginPrompt} prompt */
  _loginPrompted(controller, prompt) {
    const login = this.login;
    if (login?.controller !== controller) return;
    login.prompt = prompt;
    this._copyLoginUrl(login);
    if (this.running) this.render();
  }

  _closeLogin() {
    if (!this.login) return;
    this._loginTimerOff(this.login);
    this.login = null;
    if (this.mode === 'login') this.mode = 'normal';
    this._writeTerminal(PASTE_OFF);
  }

  /** Put the panel's link on the clipboard (OSC 52). True when it was sent;
   *  whether the terminal honoured it is not something a terminal reports.
   *  @param {LoginPanel} login */
  _copyLoginUrl(login) {
    if (!login.prompt) return false;
    return this._writeTerminal(clipboardSequence(login.prompt.url, { tmux: Boolean(this._env.TMUX) }));
  }

  /**
   * A control sequence for the terminal itself rather than for the frame: a
   * mode switch or a clipboard write. Through the same stdout the frame is
   * painted on, and under the same rule: nothing once the terminal is gone.
   * Not dropped while the terminal is behind, as a frame is: it is a few
   * hundred bytes, written once, and the next frame does not repeat it.
   * @param {string} seq
   */
  _writeTerminal(seq) {
    if (!this.running || this._stdoutDead) return false;
    try { process.stdout.write(seq); } catch { return false; }
    return true;
  }

  async _doSync() {
    try {
      const r = await this.syncAccounts();
      // { added, removed } from the server's reload; a bare count from an
      // older hook still reads as additions only.
      const added = typeof r === 'number' ? r : (r?.added || 0);
      const removed = typeof r === 'number' ? 0 : (r?.removed || 0);
      // A removal shortens the list under the cursor, the same as _doRemove.
      if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
      if (added > 0 || removed > 0) {
        this._addLog(`Synced from config: +${added} account(s), -${removed} account(s)`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
  }

  // ── Network settings ───────────────────────────────

  /**
   * Set (or clear) the egress proxy live.
   *
   * Applied to the running process as well as saved, so the next request uses it
   * without a restart — the operator is usually here BECAUSE requests are
   * failing, and "set it, then restart to find out" is a poor loop to be in.
   * An empty value clears it back to a direct connection; an explicit `false`
   * survives in the config as "ignore the environment too".
   */
  async _doSetUpstreamProxy(value) {
    let parsed;
    try {
      parsed = parseProxyUrl(value);
    } catch (e) {
      this._addLog(`Invalid proxy: ${e.message}`);
      this.mode = 'settings';
      return;
    }

    if (parsed) this.config.upstreamProxy = proxyToUrl(parsed);
    else delete this.config.upstreamProxy;

    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save proxy setting: ${e.message}`); }

    const resolved = setUpstreamProxy(resolveUpstreamProxy(this.config));
    if (resolved.proxy) this._addLog(`Upstream proxy set to ${describeProxy(resolved.proxy)}`);
    else if (resolved.source === 'self') this._addLog(`Connecting directly — ${describeSelfProxy(resolved)}`);
    else this._addLog('Upstream proxy cleared — connecting directly');
    this.mode = 'settings';
  }

  /** @param {number} idx */
  _promptAccountRouting(idx) {
    const acct = this.am.accounts[idx];
    if (!acct) return;
    // `none`, as the CLI and the MCP tool spell it: _promptInput drops a blank
    // entry, which is the right meaning for blank here too (no change).
    this._promptInput(`Proxy for ${safeLine(acct.name, 40)} (URL${acct.routing ? ', or none to clear' : ''})`,
      (/** @type {string} */ v) => this._doSetAccountRouting(idx, v.trim()));
  }

  /** Set or clear one account's own proxy. A new URL is tested first, as the
   *  CLI does, and for a stronger reason: here the change is live the moment it
   *  is made, so a mistyped password would take a serving account out of
   *  rotation with the operator watching.
   *  @param {number} idx
   *  @param {string} value */
  async _doSetAccountRouting(idx, value) {
    const acct = this.am.accounts[idx];
    if (!acct) return;
    let routing = null;
    if (!/^(none|off|-)$/i.test(value)) {
      try {
        routing = parseRoutingUrl(value);
      } catch (/** @type {any} */ e) {
        this._addLog(`Invalid proxy: ${e.message}`);
        return;
      }
      if (!routing) return;
      // Our own listener would pass the test below (this server answers a
      // CONNECT) and then loop every request straight back in.
      if (isSelfProxy(routing, localListener(this.config))) {
        this._addLog(`Proxy not set: ${describeRouting(routing)} is this server's own address, and would loop back into it`);
        return;
      }
      this._addLog(`Testing ${describeRouting(routing)}...`);
      if (this.running) this.render();
      const check = await this._testRouting(routing, upstreamFor(acct, this.config.upstream));
      if (!check.ok) {
        this._addLog(`Proxy not set: ${check.error}`);
        if (this.running) this.render();
        return;
      }
    }

    // Resolved before the await below: a manager index is not a config index
    // (see _doToggleDisabled).
    const cfgIdx = configIndexFor(this.config.accounts, this.am.accounts, idx);
    this.am.setRouting(idx, routing);
    // An explicit null, not a deleted key: the save merges over the on-disk
    // entry, and a missing key would leave the old `routing` standing.
    if (cfgIdx >= 0) this.config.accounts[cfgIdx].routing = routing ? routingToUrl(routing) : null;
    try { await this.saveConfig(this.config); }
    catch (/** @type {any} */ e) { this._addLog(`Failed to save: ${e.message}`); }
    this._addLog(routing
      ? `"${safeLine(acct.name, 64)}" now leaves through ${describeRouting(routing)}`
      : `Cleared the proxy for "${safeLine(acct.name, 64)}"; it uses the fleet egress`);
    if (this.running) this.render();
  }

  // ── sx.org settings ────────────────────────────────

  _loadSxBalance() {
    this.sxBalance = null;
    if (!this.sx?.apiKey) return;
    this.sx.getBalance()
      .then(b => { this.sxBalance = b; if (this.running) this.render(); })
      .catch(() => {});
  }

  _sxModeLabel(m) { return m === 'always' ? 'always' : m === '429' ? 'on 429 only' : 'off'; }

  async _doSetSxKey(key) {
    const mode = this.config.sx?.mode || 'always';
    this.config.sx = { apiKey: key, mode };
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save sx.org key: ${e.message}`); }
    this._addLog('sx.org: configuring...');
    const r = await this.sx.configure(key, mode);
    if (r.ok && r.proxy) this._addLog(`sx.org key saved — proxy ${r.proxy.host}:${r.proxy.port} (mode: ${this._sxModeLabel(mode)})`);
    else if (r.ok) this._addLog(`sx.org key saved (mode: ${this._sxModeLabel(mode)})`);
    else this._addLog(`sx.org error: ${r.error}`);
    this._loadSxBalance();
    this.mode = 'settings';
    if (this.running) this.render();
  }

  /**
   * Save the shared config after a settings change; on a failed save, put the
   * old value back. The gates (event logging, the blocklist, session titles, the
   * sx mode) are read live off the same object, so a value that stayed in memory
   * after the save failed would change what the running server does while disk
   * still said otherwise, and the settings row would show the new value the
   * whole time. Restoring it keeps memory, screen and file in step, and the log
   * line says which setting was left alone (#443).
   * @param {string} label what the row is called, for the log line
   * @param {() => void} revert puts the previous value back in memory
   * @returns {Promise<boolean>} whether the save landed
   */
  async _saveSetting(label, revert) {
    try { await this.saveConfig(this.config); return true; }
    catch (/** @type {any} */ e) {
      revert();
      this._addLog(`Failed to save: ${e.message} — ${label} left unchanged`);
      if (this.running) this.render();
      return false;
    }
  }

  // Cycle off → on-429 → always (dir +1) or the reverse (dir -1). Keeps the API
  // key, so the user can disable sx.org without deconfiguring it.
  async _cycleSxMode(dir = 1) {
    const order = ['off', '429', 'always'];
    const next = order[(order.indexOf(this.sx.getMode()) + dir + order.length) % order.length];
    const prev = this.config.sx;
    this.config.sx = { ...(this.config.sx || {}), mode: next };
    if (!await this._saveSetting('sx.org mode', () => { this.config.sx = prev; })) return;
    const r = await this.sx.setMode(next);
    this._addLog(`sx.org mode: ${this._sxModeLabel(next)}${r.ok ? '' : ` — ${r.error}`}`);
    if (next !== 'off') this._loadSxBalance();
    if (this.running) this.render();
  }

  async _toggleSessionTitles() {
    // The shared config object is what a save writes and a reload re-applies,
    // so it is the record; the store is configured from it, never the reverse.
    const enabled = !this.sessionTitles.enabled;
    const prev = this.config.sessionTitles;
    this.config.sessionTitles = { ...this.config.sessionTitles, enabled };
    this.sessionTitles.configure(this.config.sessionTitles);
    if (!await this._saveSetting('session titles', () => {
      this.config.sessionTitles = prev;
      this.sessionTitles.configure(prev);
    })) return;
    this._addLog(`Session titles: ${enabled ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  async _toggleAutoRedeemResets() {
    // Whether a spent weekly Codex window may spend one of that account's free
    // rate-limit reset credits. Fleet-scoped: the policy it arms is about the
    // whole pool being dry, so its switch is too. The redeemer reads it off the
    // shared config per refusal, so the assignment is the whole application and
    // the save is only what survives a restart.
    //
    // A per-account `autoRedeemReset: false` still exempts its account while
    // this is on; nothing per-account can switch it ON.
    const prev = this.config.autoRedeemResets;
    const next = prev !== true;
    this.config.autoRedeemResets = next;
    if (!await this._saveSetting('auto-redeem', () => { this.config.autoRedeemResets = prev; })) return;
    this._addLog(`Auto-redeem reset credits (Codex and Claude): ${next ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  // Idle rebalance: the same change `octopus rebalance` makes (config-ops), then
  // handed to the running manager, which reads it per selection. A failed save
  // puts both back.
  async _toggleRebalance() {
    const enabled = !rebalanceSetting(this.config.rebalanceSessions).enabled;
    await this._applyRebalance({ enabled });
  }

  async _doSetRebalanceIdle(input) {
    if (!/^\d+$/.test(input)) {
      this._addLog('Invalid idle time — enter 0 (off) or seconds'); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    await this._applyRebalance({ idleSeconds: Number(input) });
    this.mode = 'settings';
    if (this.running) this.render();
  }

  /** @param {{ enabled?: boolean, idleSeconds?: number }} change */
  async _applyRebalance(change) {
    const prev = this.config.rebalanceSessions;
    let next;
    try { next = setRebalance(this.config, change); }
    catch (/** @type {any} */ e) {
      if (!(e instanceof ConfigOpError)) throw e;
      this.config.rebalanceSessions = prev;
      this._addLog(`Invalid idle time — ${e.message}`);
      if (this.running) this.render();
      return;
    }
    this.am.setRebalance?.(this.config.rebalanceSessions);
    if (!await this._saveSetting('idle rebalance', () => {
      this.config.rebalanceSessions = prev;
      this.am.setRebalance?.(prev);
    })) return;
    this._addLog(`Idle rebalance: ${next.enabled ? `on, after ${next.idleSeconds}s idle` : 'off'}`);
    if (this.running) this.render();
  }

  async _toggleActivityFormat() {
    // 'full' unless set to 'compact'; rows already in the log keep the format
    // they were written in.
    const prev = this.config.activityFormat;
    const next = this._compactActivity() ? 'full' : 'compact';
    this.config.activityFormat = next;
    if (!await this._saveSetting('activity format', () => { this.config.activityFormat = prev; })) return;
    this._addLog(`Activity format: ${next}`);
    if (this.running) this.render();
  }

  async _toggleActivityFold() {
    // On unless set to false; rows already folded stay as they are.
    const prev = this.config.activityFold;
    const on = prev === false;
    this.config.activityFold = on;
    if (!await this._saveSetting('activity folding', () => { this.config.activityFold = prev; })) return;
    this._addLog(`Fold activity: ${on ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  async _toggleSessionRows() {
    // On unless set to false, so the first toggle from a config without the
    // key writes `false`: the comparison, not a negation, again.
    const prev = this.config.sessionRows;
    const on = prev === false;
    this.config.sessionRows = on;
    if (!await this._saveSetting('sessions panel', () => { this.config.sessionRows = prev; })) return;
    this._addLog(`Sessions panel: ${on ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  async _toggleHostLine() {
    // On unless set to false, like the sessions panel.
    const prev = this.config.hostLine;
    const on = prev === false;
    this.config.hostLine = on;
    if (!await this._saveSetting('host line', () => { this.config.hostLine = prev; })) return;
    this._addLog(`Host line: ${on ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  // [local patch 2026-10-27 원장] H: 주간을 다 쓴 계정(주간 사용률이 전환 기준 이상)을 목록에서 숨기기/보이기.
  async _toggleHideSpent() {
    const prev = this.config.hideSpent;
    const on = prev !== true;
    this.config.hideSpent = on;
    if (!await this._saveSetting('hide spent', () => { this.config.hideSpent = prev; })) return;
    this._addLog(on ? '주간 다 쓴 계정 숨김' : '주간 다 쓴 계정 다시 보임');
    if (this.running) this.render();
  }

  /** 주간(unified7d)이 전환 기준 이상인 계정. */
  _isWeeklySpent(/** @type {number} */ i) {
    const a = this.am.accounts[i];
    const u = a?.quota?.unified7d;
    if (u == null) return false;
    const t = typeof this.am.thresholdFor === 'function'
      ? this.am.thresholdFor('unified7d', a)
      : (this.am.effectiveThreshold ?? this.config.switchThreshold ?? 0.98);
    return u >= t;
  }

  /** 5시간 자동 켜기(keep-warm)가 설정에서 켜져 있는지 — 간격이든 일정이든. */
  _autoWarmOn() {
    const c = this.config || {};
    return !!c.warmupSchedule || (Number(c.warmupSeconds) || 0) > 0;
  }

  /** 「자동」 칸의 점(원장 2026-10-28): 녹색 5시간 창 돎 · 빨강 안 돎 · 회색 주간 다 써서 자동이 안 켬. */
  _autoDot(/** @type {number} */ i) {
    if (this._isWeeklySpent(i)) return gray('●');
    const reset = Number(this.am.accounts[i]?.quota?.unified5hReset);
    return reset > Date.now() ? green('●') : red('●');
  }

  /** 대시보드에 그릴 줄: H 로 숨김을 켰으면 주간 다 쓴 계정을 뺀다(선택 화면 등은 전부). */
  _visibleRows(/** @type {number[]} */ indices) {
    if (this.config?.hideSpent !== true || (this.mode !== 'normal' && this.mode !== 'warm')) return indices;
    return indices.filter(i => !this._isWeeklySpent(i));
  }

  async _toggleQuotaBarPercent() {
    // Absent means off (it is opt-in), so the first toggle from a config that
    // predates the key has to write `true` — hence the comparison rather than a
    // negation.
    const prev = this.config.quotaBarPercent;
    const on = prev !== true;
    this.config.quotaBarPercent = on;
    if (!await this._saveSetting('bar percentage', () => { this.config.quotaBarPercent = prev; })) return;
    this._addLog(`Quota bar percentage: ${on ? 'on' : 'off'}`);
    if (this.running) this.render();
  }

  /** The configured account sort; anything unknown reads as `arranged`. */
  _accountSort() {
    const s = this.config?.accountSort;
    return ACCOUNT_SORTS.includes(s) ? s : 'arranged';
  }

  async _cycleAccountSort(dir = 1) {
    // Read by _displayOrder on every frame, so the assignment is the whole
    // application and the save is only what survives a restart.
    const prev = this.config.accountSort;
    const cur = this._accountSort();
    const next = ACCOUNT_SORTS[(ACCOUNT_SORTS.indexOf(cur) + dir + ACCOUNT_SORTS.length) % ACCOUNT_SORTS.length];
    this.config.accountSort = next;
    if (!await this._saveSetting('account sort', () => { this.config.accountSort = prev; })) return;
    this._addLog(`Account sort: ${ACCOUNT_SORT_LABELS[next]}`);
    if (this.running) this.render();
  }

  async _cycleEventLogging(dir = 1) {
    // Claude Code telemetry display/handling: show → hide → block → show.
    const order = ['show', 'hide', 'block'];
    const prev = this.config.eventLogging;
    const cur = prev || 'hide';
    const next = order[(order.indexOf(cur) + dir + order.length) % order.length];
    this.config.eventLogging = next; // shared config object; the server reads it live
    if (!await this._saveSetting('event logging', () => { this.config.eventLogging = prev; })) return;
    this._addLog(`Event logging: ${next}`);
    if (this.running) this.render();
  }

  async _toggleClientMode() {
    // What `teamclaude run` and `env` do when no --mitm/--no-mitm flag is given.
    // Base-URL keeps a shell's other tools off the proxy (#382); MITM covers the
    // hard-coded endpoints and the Codex CLI. Read from disk by those commands,
    // so the save is the whole application.
    const prev = this.config.defaultClientMode;
    const next = prev === 'base-url' ? 'mitm' : 'base-url';
    this.config.defaultClientMode = next;
    if (!await this._saveSetting('client mode', () => { this.config.defaultClientMode = prev; })) return;
    this._addLog(`Default client mode: ${next} (run/env without a flag)`);
    if (this.running) this.render();
  }

  async _doClearSxKey() {
    this.config.sx = null;
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    this.sx.disable();
    this.sxBalance = null;
    this._addLog('sx.org key cleared');
    if (this.running) this.render();
  }

  async _doImport() {
    try {
      this._addLog('Importing credentials...');
      const creds = await this._readCredentials('~/.claude/.credentials.json');
      const profile = await this._readProfile(creds.accessToken);

      if (!canUpsertOAuthAccount(profile, false)) {
        this._addLog(`Import refused: could not identify OAuth account — ${profile?.error || 'profile unavailable'}`);
        return;
      }

      let name;
      if (profile?.email) {
        name = profile.email;
        const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
        if (tier) this._addLog(`Detected Claude ${tier}: ${name}`);
      } else {
        const n = this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
        name = `account-${n}`;
      }

      /** @type {Object<string, any>} */
      const entry = {
        name, type: 'oauth', source: 'import',
        ...oauthIdentityFields(profile),
        organizationType: profile?.organizationType || null,
        rateLimitTier: profile?.rateLimitTier || creds.rateLimitTier || null,
        seatTier: profile?.seatTier || null,
        hasClaudeMax: profile?.hasClaudeMax ?? null,
        hasClaudePro: profile?.hasClaudePro ?? null,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
        // [local patch 2026-10-28 원장] 결제 전 계정은 꺼 둔 채 넣는다(index.js upsertOAuthAccount 와 같은 규칙).
        ...(isPrePlanProfile(profile) ? { disabled: true, pendingPlan: true } : {}),
      };

      // Same rule as the login path: a name match counts only where it is not
      // standing in for a different account+org. Both organizations of one person
      // carry the same email-derived name, and overwriting on that match drops an
      // account here AND rewrites the running one's identity below.
      const idx = findUpsertTarget(this.config.accounts, entry);

      if (idx >= 0) {
        const prev = this.config.accounts[idx];
        this.config.accounts[idx] = updateAccountEntry(prev, entry);
        // The account to update is the one built from this entry. Identity cannot
        // answer that: the entry may have matched on a bare name while carrying no
        // UUID, and then no account matches the freshly profiled identity at all.
        // Falling back to `accounts[idx]` there applied a CONFIG index to this
        // list and wrote the new credential and the new UUID onto whichever
        // account sat at that position — a different person's, once
        // resolveAccounts has dropped anything ahead of it. An entry with no
        // running account now updates nothing, which is what there is to do.
        const amAcct = managerAccountFor(this.am.accounts, prev);
        if (amAcct) {
          amAcct.credential = creds.accessToken;
          amAcct.refreshToken = creds.refreshToken;
          amAcct.expiresAt = creds.expiresAt;
          if (entry.accountUuid) amAcct.accountUuid = entry.accountUuid;
          if (entry.orgUuid) amAcct.orgUuid = entry.orgUuid;
          if (entry.orgName) amAcct.orgName = entry.orgName;
          for (const field of ['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro']) {
            amAcct[field] = entry[field];
          }
          if (amAcct.status === 'error') amAcct.status = 'active';
        }
        this._addLog(`Updated account "${prev.name}"`);
        // Which account a credential belongs to is only known once its profile
        // has been read, so that one lookup cannot go through a proxy it has
        // not found yet. Said, because the operator routed this account to
        // keep its traffic off this machine's address.
        if (prev.routing) this._addLog(`Note: "${safeLine(prev.name, 64)}" has its own proxy, and this import's profile lookup did not go through it`);
      } else {
        // New org for this person: disambiguate colliding email names with " (org)".
        if (profile?.accountUuid) {
          const orgLbl = a => a.orgName || (a.orgUuid ? a.orgUuid.slice(0, 8) : 'org');
          const collisions = this.config.accounts.filter(
            a => a.accountUuid === entry.accountUuid && !sameIdentity(a, entry)
          );
          if (collisions.length > 0) {
            for (const c of collisions) {
              if (!c.name.includes(' (')) c.name = `${c.name} (${orgLbl(c)})`;
            }
            entry.name = `${name} (${orgLbl(entry)})`;
          }
        }
        // One object into both lists, so the account is built carrying its
        // entry's id and the two pair from the moment they exist.
        entry.id = mintAccountId();
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        // Recorded until the save below lands: a reload that reads the file
        // first would find a running account with no row and drop it.
        markAccountAdded(this.config, entry.id);
        this._addLog(`Imported account "${entry.name}"`);
      }

      await this.saveConfig(this.config);
    } catch (e) {
      this._addLog(`Import failed: ${e.message}`);
    }
  }

  async _doAddKey(apiKey) {
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    // One object, not two equal literals: the account has to be built from the
    // entry itself to carry its id, which is what pairs the two afterwards.
    const entry = { id: mintAccountId(), name, type: 'apikey', apiKey };
    this.config.accounts.push(entry);
    this.am.addAccount(entry);
    // Same window as in _doImport: the account exists here before it does on
    // disk, and a reload in between must not read the file as a removal.
    markAccountAdded(this.config, entry.id);
    await this.saveConfig(this.config);
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const name = this.am.accounts[idx].name;
    // Resolved before removeAccount, which splices this list and renumbers it.
    // The selected row is a manager index; applying it to the config list
    // deleted whichever entry sat at that position instead — the credential-less
    // one resolveAccounts dropped, or a neighbour, either of which leaves the
    // fleet running an account whose entry is gone.
    const cfgIdx = configIndexFor(this.config.accounts, this.am.accounts, idx);
    this.am.removeAccount(idx);
    if (cfgIdx >= 0) {
      // Record the id before the row goes: the save adopts rows that are on disk
      // and not in memory (an account added by another process since the last
      // reload), and removal is itself a save — so without this the entry being
      // deleted would be read back off disk and written straight out again.
      markAccountRemoved(this.config, this.config.accounts[cfgIdx]?.id);
      this.config.accounts.splice(cfgIdx, 1);
    }
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    await this.saveConfig(this.config);
    this._addLog(`Removed account "${name}"`);
  }

  async _doToggleDisabled(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const acct = this.am.accounts[idx];
    const next = !acct.disabled;
    const cfgIdx = configIndexFor(this.config.accounts, this.am.accounts, idx);
    // [local patch 2026-10-28 원장] 결제 전 표시가 있는 계정을 손으로 켜면 표시도 지운다(원장의 뜻이
    // 분명하니 따르되, 결제가 안 됐으면 요청이 실패한다고 알린다). 명시적 false — 아래 disabled 와 같은 이유.
    const wasPending = acct.pendingPlan === true;
    if (wasPending && !next) {
      acct.pendingPlan = false;
      if (cfgIdx >= 0) this.config.accounts[cfgIdx].pendingPlan = false;
    }
    this.am.setDisabled(idx, next); // re-enabling also clears a stuck error state
    // Write an explicit boolean (not delete): saveConfig merges over the on-disk
    // entry, so a `delete` would leave a stale `disabled: true` from disk intact.
    // Onto this account's own entry: a manager index is not a config index, so
    // the flag used to land on a neighbour and the next save persisted it there,
    // leaving one account disabled on disk while the operator watched another go
    // grey on screen.
    if (cfgIdx >= 0) this.config.accounts[cfgIdx].disabled = next;
    await this.saveConfig(this.config);
    this._addLog(wasPending && !next
      ? `「${acct.name}」 결제 전 표시를 지우고 켰습니다 — 결제가 안 됐으면 요청이 실패합니다`
      : `${next ? 'Disabled' : 'Enabled'} account "${acct.name}"`);
  }

  /** Move the selected account `delta` rows through the list as drawn.
   *
   *  The array is NOT permuted. `selIdx` is a manager index, and so are route
   *  pins, session pins, `currentIndex`, `TC_ACCT` and the disable/switch CLI
   *  paths — reordering `am.accounts` would silently repoint every one of them
   *  at a different account. So the rows are sorted by a field instead, and
   *  each account keeps the slot it has held since startup.
   *
   *  It is not `priority` either. That field is rotation preference, and a
   *  fleet usually carries one non-default value there — a deliberately
   *  deprioritised backend, say. Deriving it from where a row sits on screen
   *  would re-rank rotation as a side effect of tidying the display, which is a
   *  routing change nobody asked for.
   *
   *  Every arrangeable account is renumbered from its new position rather than
   *  only the two that moved: before the first move there are no numbers to
   *  insert between, and a dense 0..n-1 is the form that reads in a hand-edited
   *  config.
   *
   *  A move stays inside the account's own provider group. _displayOrder sorts
   *  by provider before it reads this field, so swapping numbers with a
   *  neighbour from the other provider would rewrite the config while no row
   *  moved. The locally-served rows are already out of reach: _arrangeable
   *  leaves them out, so neither end of a move can be one.
   *
   *  @param {number} delta  rows to travel: -1 up the list, +1 down it
   */
  _doMoveAccount(delta) {
    const order = this._arrangeable();
    const from = order.indexOf(this.selIdx);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return; // already at the end it was pushed against
    // The edge of a provider group is an end of the list as far as a move goes:
    // nothing is renumbered and nothing is saved.
    if (providerOf(this.am.accounts[order[to]]) !== providerOf(this.am.accounts[order[from]])) return;
    order.splice(to, 0, ...order.splice(from, 1));
    order.forEach((/** @type {number} */ mgrIdx, /** @type {number} */ pos) => {
      this.am.accounts[mgrIdx].displayOrder = pos;
      // Onto this account's own entry: a manager index is not a config index
      // (account-pairing.js), and an account whose entry the config no longer
      // holds keeps its position on screen with nothing to persist.
      const cfgIdx = configIndexFor(this.config.accounts, this.am.accounts, mgrIdx);
      if (cfgIdx >= 0) this.config.accounts[cfgIdx].displayOrder = pos;
    });
    // Nothing is logged on success. The row visibly moves, which is the whole
    // feedback a drag needs, and a held arrow key would otherwise push the
    // activity pane out from under the list being arranged.
    //
    // The save waits for the keys to stop. It is a locked read-merge-write of
    // the whole config, and a held arrow would otherwise run one per repeat.
    if (this._orderSaveTimer) clearTimeout(this._orderSaveTimer);
    this._orderSaveTimer = setTimeout(() => { this._flushOrderSave(); }, ORDER_SAVE_DELAY_MS);
  }

  /** Write an arrangement that is still waiting on its timer, if one is.
   *
   *  Called by the timer, on leaving reorder mode and from stop(), so the wait
   *  is only ever a delay: no way off the screen leaves a move unsaved.
   *
   *  @returns {Promise<void>}
   */
  async _flushOrderSave() {
    if (!this._orderSaveTimer) return;
    clearTimeout(this._orderSaveTimer);
    this._orderSaveTimer = null;
    try { await this.saveConfig(this.config); }
    catch (/** @type {any} */ e) { this._addLog(`Failed to save: ${e.message}`); }
  }

  // ── rendering ──────────────────────────────────────

  render({ force = false } = {}) {
    if (!this.running) return;
    // Nobody can see it: composing a frame for a dead terminal every tick is
    // work for nothing.
    if (this._stdoutDead) return;
    // Guard against re-entry: clearing an expired quota logs, and _addLog calls
    // render() again — without this the nested call would render twice.
    if (this._rendering) return;
    this._rendering = true;
    try {
      this._render(force);
    } finally {
      this._rendering = false;
    }
  }

  /**
   * Write `buf` to the terminal unless it is byte-identical to what is already
   * there. An idle proxy composes the same screen every tick, and writing it
   * again costs a wake-up and a terminal round trip to change nothing.
   */
  _paint(buf, force) {
    // stdout has already failed once: the terminal is gone, every further
    // write would fail the same way, and a stream that never drains would
    // strand the pending-paint handshake below. Serving continues blind.
    if (this._stdoutDead) return;
    const stale = Date.now() - (this._lastPaintAt || 0) >= FORCE_REPAINT_MS;
    if (!force && !stale && buf === this._lastFrame) return;
    // The terminal has not taken the previous frame yet. Painting anyway would
    // only queue another full screen behind it — the operator sees the newest
    // frame either way, so the one in between is worth nothing. Drop it, and
    // paint what is current once the terminal catches up.
    if (process.stdout.writableNeedDrain) {
      this._pendingPaint = true;
      if (!this._drainHandler) {
        this._drainHandler = () => {
          this._drainHandler = null;
          if (this._pendingPaint && this.running) { this._pendingPaint = false; this.render({ force: true }); }
        };
        process.stdout.once('drain', this._drainHandler);
      }
      return;
    }
    this._pendingPaint = false;
    this._lastFrame = buf;
    this._lastPaintAt = Date.now();
    process.stdout.write(buf);
  }

  /** Flip stdout between blocking and non-blocking. A handle without the
   *  method (a pipe in tests, a file) needs neither, and a failure to flip is
   *  worth no more than the old behaviour it leaves in place.
   *  @param {boolean} blocking */
  _setStdoutBlocking(blocking) {
    // `_handle` is Node-internal and untyped; the optional chain is the guard.
    try { /** @type {any} */ (process.stdout)._handle?.setBlocking?.(blocking); } catch {}
  }

  _render(force = false) {
    // Reset the display the instant a quota window (e.g. 5-hour session) expires,
    // instead of waiting for the next request to clear it.
    this.am.refreshExpiredQuotas();
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      this._paint(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`, force);
      return;
    }

    const lines = [];
    // Links to draw on this frame, keyed by the exact line that carries one
    // (see the paint loop at the end).
    /** @type {Map<string, { text: string, url: string, id: string }>} */
    let links = new Map();

    // ── Header
    const left = bold(' Octopus');
    const port = this.config.proxy?.port || 3456;
    const sess = this.am.sessionStats();
    const sessStr = (sess.active || sess.known)
      ? `${sess.active} sess${this.am.distributeSessions
        ? green(this.am.distributionMode === 'adaptive' ? ' adapt' : ' dist')
        : (sess.draining ? yellow(` drain ${sess.draining}`) : '')}  `
      : '';
    // ▼ marks a dashboard that lost contact with the server it polls (attach
    // mode): what is on screen is the last snapshot, not the current state.
    const live = this.am.connected === false ? red('▼') : green('▲');
    const right = this._koLayout()
      ? `${sess.active || sess.known ? `세션 ${sess.active}  ` : ''}포트 ${port} ${live} `
      : `${sessStr}Port ${port} ${live} `;
    // In attach mode the dashboard names the server's build, not this process's,
    // so the account manager's answer wins. It arrives sanitized (applyStatus)
    // and starts empty, which keeps the label hidden until the first poll rather
    // than briefly showing the local checkout's version as if it were the
    // server's. A local AccountManager has neither property.
    const label = this.am.versionLabel ?? this.versionLabel;
    const upd = this.am.updateAvailable ?? this.updateAvailable;
    const mid = label ? dim(label) + (upd ? ` ${green('▲')}` : '') : '';
    const lw = vw(left), rw = vw(right), mw = vw(mid);
    // Centred on the line, not in the gap between the two blocks, so the label
    // holds still as the session segment comes and goes.
    const start = Math.floor((W - mw) / 2);
    // Load-bearing, not cosmetic: both padding runs below would be negative
    // without it, and ' '.repeat(-1) throws. Satisfying it also means the mid
    // branch can never produce the over-wide line the other branch can, so the
    // two are not interchangeable.
    const midFits = mw > 0 && start - lw >= HEAD_GAP && (W - rw) - (start + mw) >= HEAD_GAP;
    lines.push(midFits
      ? left + ' '.repeat(start - lw) + mid + ' '.repeat(W - rw - start - mw) + right
      : left + ' '.repeat(Math.max(1, W - lw - rw)) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));

    // 한글 안내는 세 줄(쓰기 · 계정 관리 · 기타) — 원장 2026-10-28, 80칸에 두 줄로는 다 안 들어감.
    const footerH = this._koLayout() && this.mode === 'normal' && !this.remote ? 4 : 2;
    // While a prompt is open (mode 'input') keep showing the screen it was
    // launched from, so e.g. adding a route stays on the routes screen rather
    // than flashing back to the main dashboard with just the footer prompt.
    // The add-account chooser is a settings flow, so it keeps the settings
    // screen behind its footer too (select-to-remove, by contrast, needs the
    // dashboard: the account table IS the selection UI).
    const view = this.mode === 'input' ? this.inputReturn
      : this.mode === 'add' ? 'settings'
      : this.mode;
    if (view === 'settings') {
      const selLine = this._renderSettings(lines);
      // The settings body grows with every account and every setting, and a
      // short terminal used to cut it off silently: the footer, and the rows
      // past the fold, were pushed off the buffer with nothing said (#445).
      // The body scrolls instead, following the cursor row.
      const headerH = 2;   // the title line and its rule, drawn above
      const body = lines.splice(headerH);
      lines.push(...this._viewport(body, selLine - headerH, H - footerH - headerH));
    } else if (view === 'routes') {
      this._renderRoutes(lines);
    } else if (view === 'pick') {
      this._renderPick(lines);
    } else if (view === 'blocklist') {
      this._renderBlocklist(lines);
    } else if (view === 'move') {
      this._renderMove(lines, W, H - footerH);
    } else if (view === 'focus') {
      this._renderFocus(lines, W, H - footerH);
    } else if (view === 'cleanup') {
      this._renderCleanup(lines, W);
    } else if ((view === 'normal' || view === 'select' || view === 'warm') && this._koLayout() && this.am.accounts.length > 0) {
      this._renderKo(lines, W, H - footerH);
    } else {
    // ── Accounts, or the login panel in their place. The activity pane stays
    // under the panel: the sign-in's own progress lines land there.
    if (view === 'login') {
      const panel = this._loginLines(W);
      lines.push(...panel.lines);
      links = panel.links;
    } else if (this.am.accounts.length === 0) {
      lines.push('');
      // Attach mode cannot add an account, and pointing at a key that does
      // nothing here would be worse than saying only what is known.
      lines.push(yellow(this.remote
        ? '  The server reports no accounts.'
        : '  No accounts configured. Press [g] → Add account.'));
    } else {
      // Two providers, two panes; the titles take the spacer line. One column when
      // the panes cannot draw every bar the rows have.
      const current = this._currentRows();
      const groups = this._providerGroups().map(g => ({ ...g, indices: this._visibleRows(g.indices) }));
      const split = groups.length === 2 ? this._splitLayout(groups, W) : null;
      // The sessions each account is carrying: their colours run under its
      // name. The sessions themselves are listed in their own panel below.
      const sessionRows = this._sessionRowsByAccount();
      if (split) {
        const [a, b] = groups;
        const focusSeg = this._focusSeg();
        if (focusSeg) lines.push(` ${focusSeg}`);
        const host = this._hostLine(W);
        if (host) lines.push(host);
        lines.push(paneTitle(PROVIDERS[a.provider].label, split.leftW) + dim(PANE_GUTTER) + paneTitle(PROVIDERS[b.provider].label, split.rightW));
        const leftRows = this._renderRows(a.indices, split.left, current, sessionRows);
        const rightRows = this._renderRows(b.indices, split.right, current, sessionRows);
        for (let r = 0; r < Math.max(a.indices.length, b.indices.length); r++) {
          const left = r < a.indices.length ? leftRows[r] : '';
          const right = r < b.indices.length ? rightRows[r] : '';
          lines.push(fitLine(left, split.leftW) + dim(PANE_GUTTER) + right);
        }
      } else {
        // The spacer above the list carries the fleet summary when there is one.
        lines.push(this._fleetLine(W, groups));
        const host = this._hostLine(W);
        if (host) lines.push(host);
        const order = this._visibleRows(this._displayOrder());
        const layout = this._listLayout(order, W);
        lines.push(...this._renderRows(order, layout, current, sessionRows));
      }
      // ── Sessions: one line per known session, on the main dashboard only.
      // Every such line is one fewer for the activity log below.
      if (this.mode === 'normal') lines.push(...this._sessionsPanel(W));
    }

    // Routing is surfaced inline on each account row (see _renderAcct): a colored
    // ► marks a route the account serves — next to the F7/S7 bar for a Fable/Sonnet
    // route, at the row start for a general route — bold when it's the route's pin.

    // ── Activity header. Attach mode sees no request traffic — the server logs
    // that in its own process — so the pane is named for what it does hold:
    // messages from the actions taken here.
    lines.push('');
    const ac = this.active.size;
    const acTag = ac > 0 ? `  ${cyan(ac + ' active')}` : '';
    const aHdr = this.remote ? ' Messages ' : ` Activity${acTag} `;
    lines.push(aHdr + dim('─'.repeat(Math.max(1, W - vw(aHdr)))));

    // Active requests
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const m = modelParen(modelLabel(r.model, r.effort), r.effort, true); // filled in as soon as the model is peeked from the stream
      const pin = r.pinned ? dim(' [pin]') : '';
      const a = r.account ? ` → ${r.account}${pin}` : '';
      if (this._compactActivity()) {
        const tag = compactPathTag(r.path);
        const what = [tag && dim(tag), m && unlead(m)].filter(Boolean).join(' ');
        const row = [this._sessionTag(r.sessionId), what, a.trimStart(), dim(`(${el}s...)`)].filter(Boolean).join('  ');
        lines.push(` ${sp} ${gray(r.t)}  ${row}`);
      } else {
        lines.push(` ${sp} ${gray(r.t)}  ${this._sessionTag(r.sessionId)} ${r.method} ${r.path}${m}${a} ${dim(`(${el}s...)`)}`);
      }
    }

    // Completed log
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }
    } // end non-settings body

    // A body taller than the terminal used to push the footer off the bottom,
    // and the footer is where a prompt is typed: on a settings screen longer
    // than the window, the operator typed a value they could not see into a
    // prompt they could not read. The header and footer now always stay, and
    // the body between them is a window that follows the cursor row.
    const HEADER_H = 2;
    const bodyRoom = H - footerH - HEADER_H;
    if (lines.length - HEADER_H > bodyRoom) {
      const body = lines.slice(HEADER_H);
      const at = Math.max(0, body.findIndex(l => strip(l).includes('▸')));
      const from = Math.max(0, Math.min(body.length - bodyRoom, at - Math.floor(bodyRoom / 2)));
      lines.length = HEADER_H;
      lines.push(...body.slice(from, from + bodyRoom));
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    if (footerH > 2) lines.push(...this._renderFooterKo());
    else lines.push(this._renderFooter());

    // Write buffer
    let buf = `${ESC}H`;
    for (let i = 0; i < H; i++) {
      // A link is spliced in only after the line is fitted. Neither the width
      // measure nor truncate knows OSC 8, and truncate must not learn it: it is
      // the last guard against an escape in a foreign value reaching the
      // terminal. A link line whose text was cut to fit simply stays plain.
      const link = links.get(lines[i]);
      const row = fitLine(lines[i] || '', W);
      buf += link ? row.replace(link.text, () => hyperlink(link.url, link.text, { id: link.id })) : row;
      if (i < H - 1) buf += '\r\n';
    }
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    this._paint(buf, force);
  }

  /**
   * The login panel, drawn where the account rows go while a sign-in waits.
   *
   * The URL is drawn in full under a bold label, one piece per line, every
   * piece the same OSC 8 link. The link and the clipboard copy both depend on
   * the terminal (and on tmux passing them through); the text does not, so a
   * terminal that does neither still leaves the URL to select by hand. The
   * pieces start at column 0 and fill the width, so a selection across them
   * picks up nothing but the URL and the line breaks, which a browser's
   * address bar drops on paste.
   *
   * The paste line carries the ▸ the body scroll follows, so on a terminal too
   * short for the whole panel the field is what stays in view.
   *
   * @param {number} W
   * @returns {{ lines: string[], links: Map<string, { text: string, url: string, id: string }> }}
   */
  _loginLines(W) {
    /** @type {string[]} */
    const lines = [''];
    /** @type {Map<string, { text: string, url: string, id: string }>} */
    const links = new Map();
    const login = this.login;
    if (!login) return { lines, links };
    const prompt = login.prompt;
    const brand = prompt?.provider === 'codex' ? 'OpenAI' : prompt ? 'Claude' : '';
    lines.push(` ${bold(`Sign in "${safeLine(login.account, 60)}"`)}${brand ? dim(` · ${brand}`) : ''}`);
    lines.push('');
    if (!prompt) {
      lines.push(dim('   Starting the sign-in...'));
      return { lines, links };
    }

    const textW = Math.max(20, W - 4);
    // A numbered step wraps under its own text, not under its number.
    const prose = (/** @type {string} */ text, paint = (/** @type {string} */ l) => l) => {
      const hang = /^\d+\. /.test(text) ? 3 : 0;
      wrapWords(text, textW - hang).forEach((l, i) => lines.push(`   ${i && hang ? ' '.repeat(hang) : ''}${paint(l)}`));
    };
    /** @param {string} text */
    const linkLine = text => {
      lines.push(text);
      links.set(text, { text, url: prompt.url, id: login.linkId });
    };

    lines.push(`   ${bold(`Open the ${brand} sign-in page:`)}`);
    for (let i = 0; i < prompt.url.length; i += W) linkLine(linkText(prompt.url.slice(i, i + W)));
    prose(`Link sent to your clipboard (if your terminal allows OSC 52).${login.notice ? ` ${login.notice}` : ''}`, dim);
    lines.push('');

    // A browser was opened here only when the flow is listening for it on a
    // local terminal; otherwise the link is the whole way in. Said as what
    // was done on this machine, not as what the person sees: a server whose
    // terminal only looks local (see isRemoteSession) opened it where nobody is.
    const automatic = prompt.listening && !prompt.remote;
    if (automatic) prose('A browser was opened on this machine. Approving the sign-in there finishes it by itself.');
    if (prompt.provider === 'claude') {
      if (automatic) prose('Not at this machine? Open the link on your device, sign in, and paste the code the page shows.');
      else {
        prose('1. Open the link on any device and sign in.');
        prose('2. The page then shows a code. Copy it and paste it below.');
      }
    } else {
      if (automatic) prose('Not at this machine? Open the link on your device. Its browser ends on a localhost:1455 page that does not load; copy that address and paste it below.');
      else {
        prose('1. Open the link on any device and sign in.');
        prose('2. The browser then lands on a localhost:1455 page that does not load. Copy that address from the address bar and paste it below.');
      }
      // The listener is up but out of reach of a browser on another machine,
      // and one ssh flag puts it within reach.
      if (prompt.listening && prompt.remote) prose('Tip: connect with ssh -L 1455:localhost:1455 and the browser reaches this machine, so the sign-in finishes by itself.', dim);
      if (prompt.note) prose(`${safeLine(prompt.note, 200)}, so only a pasted address can finish this sign-in.`, yellow);
    }

    lines.push('');
    const label = `   ${bold('Paste')} ${cyan('▸')} `;
    lines.push(`${label}${tailText(login.buf, Math.max(1, W - vw(label) - 2))}█`);
    if (login.error) prose(`✗ ${login.error}`, red);
    return { lines, links };
  }

  /** Width budget for a list `W` wide, per row category, as one provider's pane when
   *  `pane` is set; `stages` are the widths at which bars, names, then caps fit. */
  _listLayout(/** @type {number[]} */ indices, /** @type {number} */ W, { pane = /** @type {string|null} */ (null), measure = false } = {}) {
    const accts = indices.map(i => this.am.accounts[i]);
    // Routes drive the inline markers; general (non-family) routes get a stable
    // column each at the row start so the marker's position identifies the route.
    const routes = this.am.getRoutes();
    const genRoutes = routes.filter((/** @type {any} */ r) => routeFamily(r) === null
      && (pane == null || providerOf(r) === pane)); // a pane only holds its own provider's routes
    // Bar width, budgeted PER ROW CATEGORY (#234). A subscription row draws
    // Ses/Wk and the S7/F7 family bars; a third-party backend row draws the
    // same slots from its probed windows plus Mon; an API-key row draws
    // Tok/Req and nothing else. The three share no bar, so the three are laid
    // out against separate budgets: rows line up within a category, and no
    // category pays for bars it never draws (or for a blocked-family tag only
    // a subscription row can carry). Within a category the budget is still
    // shared, on purpose: bars line up and equal lengths mean equal
    // percentages, and the whitespace that costs a row without a tag is the
    // price of that.
    //
    // The budget must count every column the widest row in the category
    // actually draws, or the row overruns the terminal and fitLine cuts the
    // tail off — which is how the S7/F7 bars lost the reset countdown they
    // carry. Three parts beyond the bars themselves:
    //   - the fixed prefix (marker, name, type, status, first bar label),
    //   - the route-marker cells, one per general route,
    //   - 6 columns of label for each bar past the first (`  Wk `, ` ►F7  `).
    // The `⊘ Sonnet Fable` tag is reserved for only when some account is
    // actually blocked; the common case where nothing is spends those columns
    // on the bars instead of leaving the row short of the edge.
    const categoryOf = (/** @type {any} */ a) => rowCategory(a);
    const routeCells = genRoutes.length ? genRoutes.length + 1 : 0;
    // The type cell and the space after it, at the width the row pads it to.
    const typeCell = pane == null ? typeColumn(this.am.accounts).width + 1 : 0;
    const floor = pane == null ? LIST_MIN : PANE_MIN;
    // The columns every name needs past NAME_MIN to be whole.
    const longestName = Math.max(0, ...accts.map(a => vw(a.name)));
    const nameWant = Math.max(0, longestName - NAME_MIN);
    const budgetFor = (/** @type {string} */ cat, /** @type {any[]} */ members) => {
      const anyFable = members.some(a => a.quota.unified7dFable != null);
      const anySonnet = members.some(a => a.quota.unified7dSonnet != null);
      const anyMonthly = members.some(a => bwLive(a.quota.backend?.windows?.monthly) != null && bwLive(a.quota.backend?.windows?.weekly) != null);
      const families = (anyFable ? 1 : 0) + (anySonnet ? 1 : 0) + (anyMonthly ? 1 : 0);
      const tagW = members.reduce((w, a) => {
        const names = shownBlockedFamilies(a.quota, key => this.am.thresholdFor(key, a));
        return names.length ? Math.max(w, 4 + vw(names.join(' '))) : w;
      }, 0);
      // Same rule for the money tag (`$`, or the billed amount with its `/cap`):
      // a column the row can draw is a column the budget has to know about, or
      // the row overflows exactly the way #228 fixed.
      // The extra-usage `xu`/`xu!` tag is one more such column, drawn right
      // after it on the same row, so a row's reserve is the two together.
      const spendW = members.reduce((w, a) => {
        const tag = spendTag(a.quota, a.maxSpend);
        const xu = extraUsageTag(a.allowExtraUsage === true, this._onExtraUsage(a));
        return Math.max(w, (tag ? 2 + vw(tag) : 0) + (xu ? 2 + vw(xu) : 0));
      }, 0);
      // Same rule again for the switch-threshold tag (#409) — silent on the
      // common (no override, or one that matches the fleet) row, so it costs
      // the budget nothing there, exactly like the two tags above it. It sits
      // in `fixed`, so `span` and the pane `stages` carry it too: a pane is
      // sized wide enough for the tag, or the split falls back to one column.
      const switchW = members.reduce((/** @type {number} */ w, /** @type {any} */ a) => {
        const tag = switchThresholdTag(a, key => this.am.thresholdFor(key));
        return tag ? Math.max(w, 2 + vw(tag)) : w;
      }, 0);
      // Same rule again for the routing tag: silent for every account on the
      // fleet path, so it costs the budget nothing there.
      const routeW = members.reduce((/** @type {number} */ w, /** @type {any} */ a) => {
        const tag = routingTag(a);
        return tag ? Math.max(w, 2 + vw(tag)) : w;
      }, 0);
      const fixed = 20 + typeCell + NAME_MIN + routeCells + tagW + spendW + switchW + routeW;
      const span = (/** @type {number} */ n, /** @type {number} */ bar) => fixed + 6 * (n - 1) + n * bar;
      const roomFor = (/** @type {number} */ n) => span(n, BAR_MIN) <= W;
      // No Ses bar once every Codex account here has said it meters no 5h window
      // (`sessionWindowStated`, the fact a reading leaves behind; not
      // `unified5h` itself, which the expiry sweep nulls every five hours on a
      // row that does have one); a Claude row or an unreported account keeps it,
      // and so does a reading that is still there (showSessionRow).
      const shortBar = cat !== 'unified'
        || members.some(a => providerOf(a) !== 'codex' || showSessionRow(a.quota) || a.quota.unified7d == null);
      // The family bars are the first thing to go: below the width where they
      // fit even at BAR_MIN they would push the row past the edge, and a row
      // cut mid-bar reads worse than one that simply doesn't draw them (the
      // `⊘` tag still says which family is barred).
      // The second shared bar answers to roomFor too, not just to a width
      // threshold. `W >= 70` alone let the reservations (a 16-column
      // blocked-family tag on two families, plus route cells) leave less than
      // BAR_MIN per bar, and the floor below then overrode the budget: two
      // accounts blocked on both families drew 72 columns at W=70, which
      // fitLine silently cut (#234).
      const showBoth = W >= floor && roomFor(2);
      const showFamily = showBoth && families > 0 && roomFor(2 + families);
      const nbars = (showBoth && shortBar ? 2 : 1) + (showFamily ? families : 0);
      // Backstop for the case no count of bars can fix: when even one bar at
      // BAR_MIN overruns the row, the floor has to yield. A narrow bar reads
      // worse than a wide one; a row cut mid-bar loses the reset countdown its
      // tail carries, and does it without saying so.
      const barRoom = (/** @type {number} */ reserved) => Math.floor((W - fixed - reserved - 6 * (nbars - 1)) / nbars);
      const avail = barRoom(0);
      let bw = avail < BAR_MIN
        ? Math.max(1, avail)
        : Math.min(BAR_MAX, avail);
      // A pane gives names the columns before bars grow past the floor.
      if (pane != null && avail >= BAR_MIN) {
        const named = barRoom(nameWant);
        bw = named >= PANE_BAR_FLOOR ? Math.min(BAR_MAX, named) : Math.min(PANE_BAR_FLOOR, avail);
      }
      const slack = Math.max(0, W - fixed - 6 * (nbars - 1) - nbars * bw);
      const drawn = (shortBar ? 2 : 1) + families;
      // The first step also holds what showBoth and showFamily test, so a
      // width that reaches it draws every bar.
      const s1 = Math.max(floor, span(2 + families, BAR_MIN), span(drawn, PANE_BAR_FLOOR));
      const s2 = Math.max(s1, span(drawn, PANE_BAR_FLOOR) + nameWant);
      const s3 = Math.max(s2, span(drawn, BAR_MAX) + nameWant);
      return {
        bw, showBoth, showFamily, anyFable, anySonnet, slack, shortBar,
        complete: showBoth && (families === 0 || showFamily),
        stages: [s1, s2, s3],
      };
    };
    const budgets = new Map();
    for (const a of accts) {
      const cat = categoryOf(a);
      if (!budgets.has(cat)) budgets.set(cat, budgetFor(cat, accts.filter(m => categoryOf(m) === cat)));
    }
    const all = [...budgets.values()];
    const anyFable = all.some(b => b.anyFable);
    const anySonnet = all.some(b => b.anySonnet);

    // Whatever the chrome and the capped bars leave over goes to the name
    // column, up to the longest name in the list, so a wide terminal shows
    // whole addresses instead of `a-considerab`. The name column is one width
    // for the whole list (it is the prefix every row shares), so it grows by
    // the smallest slack any category has left: `fixed` already reserves
    // NAME_MIN, so only the surplus past it is spent here, and no category's
    // rows are pushed past the budget above.
    const slack = Math.min(...all.map(b => b.slack));
    const nameW = Math.max(NAME_MIN, Math.min(longestName, NAME_MIN + slack));

    // The single account each secondary bucket currently routes to (null = none
    // can serve it right now). Marked next to that account's F7/S7 bar — the
    // secondary-quota analogue of ► marking the default route's current account.
    const familyTarget = {
      fable: anyFable && !measure ? this.am.previewRouteIndex('claude-fable-5') : null,
      sonnet: anySonnet && !measure ? this.am.previewRouteIndex('claude-sonnet-4-6') : null,
    };
    return {
      routes, genRoutes, budgets, nameW, familyTarget, compact: pane != null, width: W,
      complete: all.every(b => b.complete),
      stages: [0, 1, 2].map(k => Math.max(...all.map(b => b.stages[k]))),
    };
  }

  /**
   * The known sessions, newest first, from either manager: the live one
   * reads its tracker, the attached one the server's `sessions.list`. Titles
   * come from this process's SessionTitles when the source has none. Never
   * throws: a frame must not fail on a readout.
   *
   * @param {{ maxAgeMs?: number, limit?: number }} [opts]
   * @returns {{ id: string, title: string|null, account: number|null, accountName: string|null, lastSeen: number, active: boolean, model: string|null, clientPinned: boolean }[]}
   */
  _sessionItems({ maxAgeMs = Infinity, limit = Infinity } = {}) {
    if (typeof this.am.sessionList !== 'function') return [];
    const titles = this.sessionTitles?.enabled ? this.sessionTitles : null;
    const title = titles ? (/** @type {string} */ sid) => titles.get(sid) : null;
    try {
      return this.am.sessionList({ title, maxAgeMs, limit }) || [];
    } catch {
      return [];
    }
  }

  /** What a session is called on screen: its title, else its short id. A row
   *  taken before its title was read asks the cache again, so the picker fills
   *  its names in as the reads land rather than keeping the ids it opened with. */
  _sessionLabel(/** @type {{ id: string, title?: string|null }} */ s) {
    const title = s.title || (this.sessionTitles?.enabled ? this.sessionTitles.get(s.id) : null);
    return (title && safeLine(title, 120)) || shortSid(s.id);
  }

  /**
   * Account index to the sessions pinned there that made a request within
   * SESSION_ROW_WINDOW_MS, newest first; null when sessionRows is off or no
   * session qualifies. The name colours follow it on every screen that draws
   * the rows.
   * @returns {Map<number, any[]>|null}
   */
  _sessionRowsByAccount() {
    if (this.config?.sessionRows === false) return null;
    const items = this._sessionItems({ maxAgeMs: SESSION_ROW_WINDOW_MS });
    if (!items.length) return null;
    /** @type {Map<number, any[]>} */
    const by = new Map();
    for (const s of items) {
      if (s.account == null) continue;
      const list = by.get(s.account);
      if (list) list.push(s); else by.set(s.account, [s]);
    }
    return by;
  }

  /**
   * The Sessions panel under the account list: a header in the Activity
   * header's style, then one line per known session, newest first —
   * `● title  → account  model  3m ago`, the dot in the session's own colour
   * (filled while it is active, hollow after), `[TC_ACCT]` when the client
   * pinned it. At most SESSIONS_PANEL_MAX lines, the rest counted. Empty when
   * sessionRows is off or no session is known, so the panel takes no room.
   * Every line is cut to `W` columns.
   * @param {number} W
   * @returns {string[]}
   */
  _sessionsPanel(W) {
    if (this.config?.sessionRows === false) return [];
    const items = this._sessionItems();
    if (!items.length) return [];
    const shown = items.slice(0, SESSIONS_PANEL_MAX);
    // The label column is as wide as the longest label shown, up to the
    // session-title width; a list of bare ids keeps to their six columns.
    const titleW = Number.isInteger(this.sessionTitles?.width) ? this.sessionTitles.width : DEFAULT_TITLE_WIDTH;
    const labelW = Math.max(SESSION_ID_LEN, Math.min(titleW, Math.max(...shown.map(s => vw(this._sessionLabel(s))))));
    const acctW = Math.min(SESSIONS_PANEL_ACCT_W, Math.max(...shown.map(s => vw(this._sessionAccountName(s)))));
    const modelW = Math.min(SESSIONS_PANEL_MODEL_W, Math.max(...shown.map(s => vw(modelTag(s.model)))));
    const pinned = shown.some(s => s.clientPinned);
    const hdr = ` Sessions (${items.length}) `;
    const out = ['', hdr + dim('─'.repeat(Math.max(1, W - vw(hdr))))];
    for (const s of shown) {
      const dot = fg(sessionColorCode(s.id), s.active ? '●' : '○');
      const label = rpad(truncate(this._sessionLabel(s), labelW), labelW);
      const acct = rpad(truncate(this._sessionAccountName(s), acctW), acctW);
      const model = rpad(truncate(modelTag(s.model), modelW), modelW);
      const pin = s.clientPinned ? `  ${dim('[TC_ACCT]')}` : '';
      const ago = pinned ? rpad(formatAgo(s.lastSeen), 7) : formatAgo(s.lastSeen);
      const row = ` ${dot} ${s.active ? label : dim(label)}  → ${acct}  ${model}  ${dim(ago)}${pin}`;
      out.push(truncate(row.trimEnd(), W));
    }
    const hidden = items.length - shown.length;
    if (hidden) out.push(truncate(`   ${dim(`… +${hidden} more`)}`, W));
    return out;
  }

  // ── session move (`m`) ─────────────────────────────

  // ── 안 쓰는 작업 정리 (원장 2026-10-24, cleanup.js). Windows 의 이 PC 에서만: attach 모드의
  // Host 줄은 서버 PC 것이라 여기서 끄면 엉뚱한 PC 를 정리하게 된다.
  _cleanupAvailable() {
    return this._cleanupPlatform === 'win32' && !this.remote;
  }

  /** Host 줄 샘플 주기(1분)마다 대상 수를 새로 센다. 첫 조회는 부팅 직후 부하를 피해 5초 뒤. */
  _startLeftoverWatch() {
    if (!this._cleanupAvailable() || this._leftoverTimer) return;
    const tick = async () => {
      if (this.config?.hostLine === false || this.mode === 'cleanup') return;
      let items = null;
      try { items = await this._cleanupScan(); } catch { items = null; }
      if (items && this.running && this.mode !== 'cleanup') { this._leftovers = summarizeLeftovers(items); this.render(); }
    };
    const first = setTimeout(tick, 5000);
    first.unref?.();
    this._leftoverTimer = setInterval(tick, 60_000);
    this._leftoverTimer.unref?.();
  }

  _openCleanup() {
    const st = { stage: 'scan', items: [] };
    this.cleanup = st;
    this.mode = 'cleanup';
    this._cleanupScan().then(items => {
      if (this.cleanup !== st || st.stage !== 'scan') return;
      if (items) {
        st.items = items;
        this._leftovers = summarizeLeftovers(items);
      }
      st.stage = items == null ? 'error' : items.length ? 'list' : 'empty';
      if (this.running) this.render();
    }, () => {
      if (this.cleanup !== st) return;
      st.stage = 'error';
      if (this.running) this.render();
    });
  }

  _closeCleanup() {
    this.cleanup = null;
    this.mode = 'normal';
  }

  _keyCleanup(/** @type {string} */ k) {
    const st = this.cleanup;
    if (!st) { this.mode = 'normal'; return; }
    if (st.stage === 'kill') return;
    if (k === 'esc' || k === 'q') { this._closeCleanup(); return; }
    if (k === 'y' && st.stage === 'list') this._doCleanup(st);
  }

  /** 끄기 직전에 목록을 한 번 더 받아, 창을 연 뒤에 끝났거나 pid 가 다른 프로그램에게 재사용된
   *  것은 건드리지 않는다(같은 pid 라도 시작 시각이 같아야 한다). */
  async _doCleanup(/** @type {any} */ st) {
    st.stage = 'kill';
    let targets = [];
    let readFailed = false;
    try {
      const fresh = await this._cleanupScan();
      if (fresh) targets = fresh.filter(f => st.items.some((/** @type {any} */ i) => i.pid === f.pid && i.startedAt === f.startedAt));
      else readFailed = true;
    } catch { readFailed = true; }
    if (readFailed) {
      this._addLog('정리: 프로세스 목록을 읽지 못해 아무것도 끄지 않았습니다');
    } else if (targets.length) {
      const r = killLeftovers(targets, this._cleanupKill ? { kill: this._cleanupKill } : undefined);
      this._addLog(`${r.killed}개 껐습니다 · 메모리 ${formatGB(r.memMB)} 확보${r.failed ? ` · ${r.failed}개 실패` : ''}`);
    } else {
      this._addLog('정리할 작업이 없습니다');
    }
    this._leftovers = null;
    if (this.cleanup === st) this._closeCleanup();
    if (this.running) this.render();
  }

  _renderCleanup(/** @type {string[]} */ lines, /** @type {number} */ W) {
    const st = this.cleanup;
    if (!st) return;
    lines.push('');
    lines.push(bold('  안 쓰는 작업 정리') + dim('  — 화면 없는 테스트 브라우저·주인 없는 검색·남은 테스트 서버·멈춘 검사 스크립트'));
    lines.push('');
    if (st.stage === 'scan' || st.stage === 'kill') { lines.push(gray(st.stage === 'scan' ? '    찾는 중…' : '    끄는 중…')); return; }
    if (st.stage === 'error') { lines.push(yellow('    프로세스 목록을 읽지 못했습니다. Esc 로 닫고 다시 시도하세요.')); return; }
    if (st.stage === 'empty') { lines.push(green('    정리할 작업이 없습니다')); return; }
    const sum = summarizeLeftovers(st.items);
    lines.push(`  ${orange(`${sum.count}개 · 메모리 ${formatGB(sum.memMB)}`)}`);
    lines.push('');
    const kindW = Math.max(...st.items.map((/** @type {any} */ i) => vw(i.kind)));
    const stamp = (/** @type {number} */ ms) => {
      if (!(ms > 0)) return '--/-- --:--';
      const d = new Date(ms);
      const z = (/** @type {number} */ n) => String(n).padStart(2, '0');
      return `${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
    };
    for (const it of st.items) {
      const head = `    ${rpad(it.kind, kindW)}  ${stamp(it.startedAt)}  ${rpad(`${it.memMB}MB`, 7)}  `;
      lines.push(truncate(head + dim(safeLine(it.cmd, 200)), W - 1));
    }
  }

  /** 주간 리셋이 24시간 안이면 ` · 리셋 18h` 꼬리, 아니면 ''. (move·집중 창 공용) */
  _resetTail(/** @type {number|null|undefined} */ wkReset) {
    const untilReset = Number.isFinite(wkReset) ? /** @type {number} */ (wkReset) - Date.now() : NaN;
    return untilReset > 0 && untilReset <= 24 * 3600_000 ? ` · 리셋 ${Math.max(1, Math.ceil(untilReset / 3600_000))}h` : '';
  }

  /** [local patch 2026-10-27 원장] `f`: 집중 계정 고르기 창. 맨 위 「집중 끄기」 + 계정 줄(move 화면과 같은 5h·주 %·구독 꼬리). */
  _openFocus() {
    const cur = typeof this.am.focusInfo === 'function' ? this.am.focusInfo()?.name : null;
    const rows = [{ off: true }, ...this._displayOrder().map((/** @type {number} */ idx) => {
      const a = this.am.accounts[idx];
      const weekly = this._moveWeekly(a, null);
      return {
        idx,
        name: a?.name,
        ok: this._moveAvailable(a, null, weekly),
        current: !!cur && a?.name === cur,
        ses: a?.quota?.unified5h ?? null,
        wk: weekly,
        wkReset: this._moveWeeklyReset(a, null),
      };
    })];
    const at = rows.findIndex(r => r.current);
    this.focus = { rows, idx: at >= 0 ? at : (rows.length > 1 ? 1 : 0) };
    this.mode = 'focus';
  }

  _closeFocus() {
    this.focus = null;
    this.mode = 'normal';
  }

  _keyFocus(/** @type {string} */ k) {
    const f = this.focus;
    if (!f) { this.mode = 'normal'; return; }
    if (k === 'esc' || k === 'q') { this._closeFocus(); return; }
    if (k === 'up' || k === 'k') f.idx = Math.max(0, f.idx - 1);
    else if (k === 'down' || k === 'j') f.idx = Math.min(f.rows.length - 1, f.idx + 1);
    else if (k === 'enter') {
      const row = f.rows[f.idx];
      // 「집중 끄기」 줄, 또는 이미 집중 중인 계정을 다시 고르면 해제.
      this._doFocus(!row || row.off || row.current ? null : row.name);
    }
  }

  /** 집중 계정을 저장하고(우선순위와 같은 설정 잠금) 서버에 적용한다. null 이면 해제. */
  async _doFocus(/** @type {string|null} */ name) {
    this._closeFocus();
    try {
      if (this.setFocusAccount) await this.setFocusAccount(name);
      else {
        // 저장 수단이 없는 구성(시험 등)은 메모리에만.
        if (name) this.config.focusAccount = name; else delete this.config.focusAccount;
        this.am.setFocusAccount?.(name);
      }
    } catch (/** @type {any} */ e) {
      this._addLog(`집중 계정 설정 실패: ${safeLine(e?.message || String(e), 120)}`);
      if (this.running) this.render();
      return;
    }
    this._addLog(name ? `집중 계정: ${safeLine(name, 64)} — 다음 요청부터 이 계정으로 몰립니다` : '집중 계정을 껐습니다 — 원래 배정 규칙으로 돌아갑니다');
    if (this.running) this.render();
  }

  _renderFocus(/** @type {string[]} */ lines, /** @type {number} */ W, /** @type {number} */ bottom) {
    const f = this.focus;
    if (!f) return;
    lines.push('');
    lines.push(bold('  집중 계정') + dim('  — 고른 계정으로 새 세션·고정 세션이 모두 몰립니다 (한도에 걸린 동안만 다른 계정)'));
    lines.push('');
    const accts = f.rows.filter((/** @type {any} */ r) => !r.off);
    const nameW = Math.min(32, Math.max(1, ...accts.map((/** @type {any} */ r) => vw(safeLine(r.name ?? '?', 64)))));
    const cell = (/** @type {number} */ v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—').padStart(4);
    const resetW = Math.max(0, ...accts.map((/** @type {any} */ r) => vw(this._resetTail(r.wkReset))));
    f.rows.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      const cur = i === f.idx;
      const mark = cur ? cyan('▸') : ' ';
      if (r.off) {
        lines.push(`   ${mark} ${cur ? bold('집중 끄기') : '집중 끄기'}${dim('  — 원래 배정 규칙')}`);
        return;
      }
      const warn = (/** @type {number} */ v, /** @type {number} */ limit, /** @type {string} */ text) => {
        if (!Number.isFinite(v) || v < limit) return text;
        const colored = barColor(v) === BAR_RED ? red(text) : orange(text);
        return cur ? `${colored}${BOLD}` : colored;
      };
      const subRaw = this._subscriptionTail(this.am.accounts[r.idx]);
      const reset = this._resetTail(r.wkReset);
      const tail = subRaw ? reset + ' '.repeat(resetW - vw(reset)) : reset;
      const subTail = subRaw && cur ? `${subRaw}${BOLD}` : subRaw;
      const name = rpad(truncate(safeLine(r.name ?? '?', 64), nameW), nameW);
      const body = `${name}  5h ${warn(r.ses, 0.8, cell(r.ses))} · 주 ${warn(r.wk, 0.9, cell(r.wk))}${tail}${subTail}`;
      const note = r.current ? orange('  ◎ 집중 중 (다시 고르면 해제)') : !r.ok ? dim('  (지금은 쓸 수 없음 — 한도 등)') : '';
      lines.push(`   ${mark} ${cur ? bold(body) : body}${note}`);
    });
  }

  /** Open the session picker: every known session, newest first, as it stood
   *  when the key was pressed, so the cursor does not chase a list reordering
   *  under it with every request. */
  _openMove() {
    const items = this._sessionItems();
    if (!items.length) { this._addLog('No sessions to move'); return; }
    this.mode = 'move';
    this.move = { stage: 'session', items, idx: 0, visible: items.length, session: null, accounts: [], aIdx: 0 };
  }

  _closeMove() {
    this.move = null;
    this.mode = 'normal';
  }

  _keyMove(/** @type {string} */ k) {
    const mv = this.move;
    if (!mv) { this.mode = 'normal'; return; }
    if (k === 'esc' || k === 'q') { this._closeMove(); return; }
    const up = k === 'up' || k === 'k';
    const down = k === 'down' || k === 'j';
    if (mv.stage === 'session') {
      const n = Math.max(1, Math.min(mv.items.length, mv.visible));
      if (up) mv.idx = Math.max(0, mv.idx - 1);
      else if (down) mv.idx = Math.min(n - 1, mv.idx + 1);
      else if (k === 'enter') this._moveChooseSession(mv.items[mv.idx]);
      return;
    }
    const rows = mv.accounts;
    if (up || down) {
      const dir = up ? -1 : 1;
      for (let j = mv.aIdx + dir; j >= 0 && j < rows.length; j += dir) {
        if (rows[j].ok) { mv.aIdx = j; break; }
      }
    } else if (k === 'enter') {
      const row = rows[mv.aIdx];
      if (row?.ok) this._doMoveSession(mv.session, row.idx);
    }
  }

  /** The governing weekly utilization of `a` for a request on `model`. */
  _moveWeekly(/** @type {any} */ a, /** @type {string|null} */ model) {
    if (typeof this.am._governingWeekly === 'function') return this.am._governingWeekly(a, model);
    return gatingUtilization(a?.quota, weeklyBucketForModel(model));
  }

  /** When the weekly window governing `model` on `a` resets (ms), or null. */
  _moveWeeklyReset(/** @type {any} */ a, /** @type {string|null} */ model) {
    if (typeof this.am._governingWeeklyReset === 'function') return this.am._governingWeeklyReset(a, model) || null;
    const q = a?.quota;
    return q?.[`${weeklyBucketForModel(model)}Reset`] || q?.unified7dReset || null;
  }

  /** Whether `a` can take a session on `model`. The live manager answers with
   *  the selector's own predicate; an attached one has the server's
   *  model-agnostic reason plus the family bucket against its threshold. */
  _moveAvailable(/** @type {any} */ a, /** @type {string|null} */ model, /** @type {number|null} */ weekly) {
    if (!a || a.disabled) return false;
    if (typeof this.am._isAvailable === 'function') return this.am._isAvailable(a, model);
    if (a.unavailable != null) return false;
    const threshold = this.am.thresholdFor?.(weeklyBucketForModel(model), a);
    return !(Number.isFinite(weekly) && Number.isFinite(threshold) && weekly >= threshold);
  }

  /** Step two: the accounts the chosen session can move to. The cursor starts
   *  where distribution would send a new session, the least-used weekly window
   *  (see _rankedWeeklyUsed), passing over the account it is already on. */
  _moveChooseSession(/** @type {any} */ s) {
    const mv = this.move;
    if (!mv || !s) return;
    if (s.account == null) { this._addLog('That session has not been routed to an account yet'); return; }
    const home = this.am.accounts[s.account];
    const provider = home ? providerOf(home) : null;
    const rows = this._displayOrder().map((/** @type {number} */ idx) => {
      const a = this.am.accounts[idx];
      const weekly = this._moveWeekly(a, s.model);
      const sameProvider = provider == null || providerOf(a) === provider;
      const rank = typeof this.am._rankedWeeklyUsed === 'function'
        ? this.am._rankedWeeklyUsed(a, s.model)
        : (Number.isFinite(weekly) ? weekly : -Infinity);
      return {
        idx,
        ok: sameProvider && this._moveAvailable(a, s.model, weekly),
        current: idx === s.account,
        ses: a?.quota?.unified5h ?? null,
        wk: weekly,
        wkReset: this._moveWeeklyReset(a, s.model),
        rank,
      };
    });
    const elsewhere = rows.filter(r => r.ok && !r.current);
    let best = null;
    for (const r of (elsewhere.length ? elsewhere : rows.filter(r => r.ok))) {
      if (!best || r.rank < best.rank) best = r;
    }
    mv.stage = 'account';
    mv.session = s;
    mv.accounts = rows;
    mv.aIdx = best ? rows.indexOf(best) : 0;
  }

  _doMoveSession(/** @type {any} */ s, /** @type {number} */ idx) {
    this._closeMove();
    const acct = this.am.accounts[idx];
    if (!acct) { this._addLog('That account is no longer listed'); return; }
    if (idx === s.account) { this._addLog(`Session "${safeLine(this._sessionLabel(s), 60)}" is already on "${safeLine(acct.name, 64)}"`); return; }
    if (this.applySessionMove) { this._doMoveSessionRemote(s, acct); return; }
    const res = this.am.moveSession(s.id, idx);
    if (!res?.ok) { this._addLog(`Move failed: ${res?.error || 'unknown error'}`); return; }
    const from = res.from == null ? '?' : this.am.accounts[res.from]?.name ?? '?';
    this._logMoved(s, from, acct.name);
  }

  /** Attach mode: the session lives in the server's tracker, so the move is
   *  a request, and the log says what the server answered. */
  async _doMoveSessionRemote(/** @type {any} */ s, /** @type {any} */ acct) {
    try {
      const res = await this.applySessionMove?.(s.id, acct.name);
      const from = typeof res?.from === 'string' ? res.from : (s.accountName || '?');
      const to = typeof res?.to === 'string' ? res.to : acct.name;
      this._logMoved({ ...s, clientPinned: res?.clientPinned === true || s.clientPinned === true }, from, to);
    } catch (/** @type {any} */ e) {
      this._addLog(`Move failed: ${e.message}`);
    }
    if (this.running) this.render();
  }

  _logMoved(/** @type {any} */ s, /** @type {string} */ from, /** @type {string} */ to) {
    const label = safeLine(this._sessionLabel(s), 60);
    // A client pin (TC_ACCT, `/tc-acct/`) is resolved ahead of the session pin,
    // so the move is recorded but steers nothing while the client sends it.
    const warn = s.clientPinned ? yellow(' — but the client pins it with TC_ACCT; the move has no effect') : '';
    this._addLog(`Moved session "${label}" ${safeLine(from, 64)} → ${safeLine(to, 64)} (applies from its next request)${warn}`);
  }

  /** The account a session is pinned to, for the picker's arrow column. */
  _sessionAccountName(/** @type {any} */ s) {
    if (s.account == null) return '—';
    return safeLine(this.am.accounts[s.account]?.name ?? s.accountName ?? '?', 64) || '?';
  }

  /**
   * The `m` picker. Step one lists sessions, as many as fit and `… N more`
   * after them (no scrolling: the newest are the ones worth moving); step two
   * the accounts, an account that cannot take the session struck through.
   * @param {string[]} lines
   * @param {number} W
   * @param {number} bottom the line the footer starts on
   */
  _renderMove(lines, W, bottom) {
    const mv = this.move;
    if (!mv) return;
    lines.push('');
    if (mv.stage === 'session') {
      lines.push(bold('  Move a session') + dim('  — pick the session, then the account it moves to'));
      lines.push('');
      const room = Math.max(1, bottom - lines.length);
      const visible = mv.items.length <= room ? mv.items.length : Math.max(1, room - 1);
      mv.visible = visible;
      if (mv.idx >= visible) mv.idx = visible - 1;
      const shown = mv.items.slice(0, visible);
      const nameW = Math.min(28, Math.max(1, ...shown.map((/** @type {any} */ s) => vw(this._sessionAccountName(s)))));
      const agoW = 7;
      // Cursor, dot, the arrow, the age, the family and the pin tag around it.
      const fixed = 7 + 4 + nameW + 2 + agoW + 10 + 11;
      const titleW = Math.max(8, Math.min(48, W - fixed));
      shown.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const cur = i === mv.idx;
        const dot = fg(sessionColorCode(s.id), s.active ? '●' : '○');
        const title = rpad(truncate(this._sessionLabel(s), titleW), titleW);
        const acct = rpad(truncate(this._sessionAccountName(s), nameW), nameW);
        const fam = modelTag(s.model);
        const pin = s.clientPinned ? `  ${yellow('[TC_ACCT]')}` : '';
        lines.push(`   ${cur ? cyan('▸') : ' '} ${dot} ${cur ? bold(title) : title}  → ${acct}  ${gray(rpad(formatAgo(s.lastSeen), agoW))}${fam ? `  ${dim(`(${fam})`)}` : ''}${pin}`);
      });
      if (visible < mv.items.length) lines.push(dim(`     … ${mv.items.length - visible} more`));
      return;
    }
    const s = mv.session;
    lines.push(bold(`  Move "${truncate(this._sessionLabel(s), 40)}"`)
      + dim(`  — now on ${this._sessionAccountName(s)}; applies from its next request`));
    lines.push('');
    if (!mv.accounts.some((/** @type {any} */ r) => r.ok)) lines.push(yellow('    No account can take this session right now.'));
    const nameW = Math.min(32, Math.max(1, ...mv.accounts.map((/** @type {any} */ r) => vw(safeLine(this.am.accounts[r.idx]?.name ?? '?', 64)))));
    // [local patch 2026-10-27 원장] 구독 꼬리가 모든 줄에서 같은 열에서 시작하도록 「리셋 Nh」 자리를 맞춘다.
    const resetW = Math.max(0, ...mv.accounts.map((/** @type {any} */ r) => vw(this._resetTail(r.wkReset))));
    mv.accounts.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      const cur = i === mv.aIdx && r.ok;
      const name = rpad(truncate(safeLine(this.am.accounts[r.idx]?.name ?? '?', 64), nameW), nameW);
      // [local patch 2026-10-23 원장] 옮길 계정을 고르면서 계정별 5시간·주간
      // 사용률을 본다. 5시간 80%↑·주간 90%↑ 는 막대와 같은 경고색(주황·빨강),
      // 주간 리셋이 24시간 안이면 남은 시간을 꼬리로 붙인다.
      const warn = (/** @type {number} */ v, /** @type {number} */ limit, /** @type {string} */ text) => {
        if (!r.ok || !Number.isFinite(v) || v < limit) return text;
        const colored = barColor(v) === BAR_RED ? red(text) : orange(text);
        return cur ? `${colored}${BOLD}` : colored; // the cursor row stays bold past the colour reset
      };
      const cell = (/** @type {number} */ v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—').padStart(4);
      const subRaw = this._subscriptionTail(this.am.accounts[r.idx], !r.ok);
      const reset = this._resetTail(r.wkReset);
      const tail = subRaw ? reset + ' '.repeat(resetW - vw(reset)) : reset;
      // 구독 갱신일 (원장 2026-10-24). 못 가는 계정(취소선)은 색 없이, 커서 줄은 색 뒤 굵기를 되살린다.
      const subTail = subRaw && r.ok && cur ? `${subRaw}${BOLD}` : subRaw;
      const body = `${name}  5h ${warn(r.ses, 0.8, cell(r.ses))} · 주 ${warn(r.wk, 0.9, cell(r.wk))}${tail}${subTail}`;
      const shown = !r.ok ? dim(strike(body)) : cur ? bold(body) : body;
      lines.push(`   ${cur ? cyan('▸') : ' '} ${shown}${r.current ? dim('  (current)') : ''}`);
    });
  }

  /** Draw one row against a layout from _listLayout. `parts`, when given, collects the row's
   *  body and subscription tail instead of joining them (see _renderRows). */
  _renderRow(/** @type {number} */ idx, /** @type {any} */ L, /** @type {Set<number>} */ current, /** @type {Map<number, any[]>|null} */ sessions = null, /** @type {any[]|null} */ parts = null) {
    const b = L.budgets.get(rowCategory(this.am.accounts[idx]));
    return this._renderAcct(idx, b.bw, b.showBoth, L.routes, L.genRoutes, L.familyTarget, b.showFamily, L.nameW, { current, compact: L.compact, shortBar: b.shortBar, sessions: sessions?.get(idx) || null, width: L.width, parts });
  }

  /**
   * [local patch 2026-10-27 원장] 한 목록의 계정 줄들을 그린다 — 구독 꼬리(`· 구독 10/28 D-2`)가 모든 줄에서
   * 같은 열에서 시작하도록 줄 몸통을 빈칸으로 맞춘 뒤 붙인다(F7·S7 칸이 있든 없든). 모자랄 때의 규칙은
   * f57b973 그대로(F7·S7 먼저 빼고, 그래도 안 되면 꼬리 통째로 — 반쪽 금지)이고 alignSubTails 가 맡는다.
   * @param {number[]} indices
   * @param {any} L
   * @param {Set<number>} current
   * @param {Map<number, any[]>|null} [sessions]
   * @returns {string[]}
   */
  _renderRows(indices, L, current, sessions = null) {
    /** @type {any[]} */
    const parts = [];
    for (const idx of indices) this._renderRow(idx, L, current, sessions, parts);
    return alignSubTails(parts);
  }

  /** The accounts of each provider present, in the order its rows are drawn. */
  _providerGroups() {
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    for (const i of this._displayOrder()) {
      const provider = providerOf(this.am.accounts[i]);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)?.push(i);
    }
    return [...groups].map(([provider, indices]) => ({ provider: /** @type {keyof typeof PROVIDERS} */ (provider), indices }));
  }

  /** Two pane layouts, or null when `W` cannot fit both. Width goes stage by stage,
   *  both panes reaching one before either starts the next, a partial one shared pro rata.
   *  Width past the last stage stays unused on the right: shared between the panes, it
   *  set the Codex pane mid-screen on an ultrawide, hundreds of columns from its neighbour. */
  _splitLayout(/** @type {{ provider: string, indices: number[] }[]} */ groups, /** @type {number} */ W) {
    const [a, b] = groups;
    const avail = W - vw(PANE_GUTTER);
    const size = (/** @type {{ provider: string, indices: number[] }} */ g) => this._listLayout(g.indices, avail, { pane: g.provider, measure: true });
    const sa = size(a).stages;
    const sb = size(b).stages;
    if (sa[0] + sb[0] > avail) return null;
    let leftW = sa[0];
    let rightW = sb[0];
    for (let k = 1; k < sa.length; k++) {
      const wantA = sa[k] - leftW;
      const wantB = sb[k] - rightW;
      const room = avail - leftW - rightW;
      if (room < wantA + wantB) {
        const give = Math.round(room * wantA / (wantA + wantB));
        leftW += give;
        rightW += room - give;
        break;
      }
      leftW += wantA;
      rightW += wantB;
    }
    const left = this._listLayout(a.indices, leftW, { pane: a.provider });
    const right = this._listLayout(b.indices, rightW, { pane: b.provider });
    return left.complete && right.complete ? { leftW, rightW, left, right } : null;
  }

  /** Manager indices in the order the rows are drawn: grouped by provider, then
   *  accounts served by a local process last, every other account in the order
   *  the operator arranged.
   *
   *  A local backend (a translating proxy in front of another vendor, say) is
   *  infrastructure rather than a seat to rotate between, so it reads as noise
   *  wedged among the accounts that do rotate. Config order cannot keep it out
   *  of the way on its own, because a newly added account is appended AFTER it
   *  and puts it back in the middle. That rule is a category, not a preference,
   *  so it wins over the arrangement rather than competing with it.
   *
   *  Display only. `selIdx`, `currentIndex`, session pins and route entries all
   *  stay manager indices, so nothing about selection or routing moves with the
   *  rows — see _keySelect, which walks this order but still stores an index.
   *  Which is also why the arrangement is a sort key rather than a permutation
   *  of `am.accounts`: see _doMoveAccount.
   *
   *  With a reset sort (`accountSort`) the soonest reset goes before the
   *  arrangement, which then only breaks ties. Not on the reorder screen, and
   *  not when `arranged` is asked for: the arrangement is what that screen
   *  edits, so it must see that order.
   *
   *  @param {{ arranged?: boolean }} [opts]
   */
  _displayOrder({ arranged = false } = {}) {
    const resetOf = arranged || (this.mode === 'select' && this.selAction === 'reorder')
      ? null : SORT_RESET[this._accountSort()];
    const now = Date.now();
    return this.am.accounts
      .map((/** @type {any} */ _, /** @type {number} */ i) => i)
      .sort((/** @type {number} */ x, /** @type {number} */ y) => {
        const px = PROVIDER_ORDER.indexOf(providerOf(this.am.accounts[x]));
        const py = PROVIDER_ORDER.indexOf(providerOf(this.am.accounts[y]));
        const sx = isLocalUpstream(this.am.accounts[x]) ? 1 : 0;
        const sy = isLocalUpstream(this.am.accounts[y]) ? 1 : 0;
        // Provider, then the local category, then the sort: the first two are
        // what a row IS, so no sort and no number the operator set crosses them.
        if (px !== py) return px - py;
        if (sx !== sy) return sx - sy;
        if (resetOf) {
          const tx = resetRank(resetOf(this.am.accounts[x].quota || {}), now);
          const ty = resetRank(resetOf(this.am.accounts[y].quota || {}), now);
          if (tx !== ty) return tx < ty ? -1 : 1; // Infinity - Infinity is NaN, so compare
        }
        const rx = listRank(this.am.accounts[x]);
        const ry = listRank(this.am.accounts[y]);
        // Infinity !== Infinity is false, so two unplaced accounts fall through
        // to the index rather than subtracting to NaN.
        return rx === ry ? x - y : rx - ry; // ties keep list order, so the sort is stable
      });
  }

  /** Manager indices of the rows the operator can arrange, in drawn order.
   *
   *  Every account except the locally-served ones: _displayOrder pins those to
   *  the end of the list whatever a number says, so they hold no position and
   *  their array slots are simply stepped over.
   *
   *  Always in the arranged order, whatever `accountSort` says: a move
   *  renumbers every account from this list, so a sorted list here would
   *  write the sort into `displayOrder`.
   */
  _arrangeable() {
    return this._displayOrder({ arranged: true }).filter((/** @type {number} */ i) => !isLocalUpstream(this.am.accounts[i]));
  }

  /** The rows that carry ►: the cursor, or in a mixed pool each provider's current
   *  account, since `currentIndex` only names the pool that moved last. */
  _currentRows() {
    const providers = new Set(this.am.accounts.map((/** @type {any} */ a) => providerOf(a)));
    if (providers.size < 2) return new Set([this.am.currentIndex]);
    /** @type {Set<number>} */
    const rows = new Set();
    for (const provider of providers) {
      const idx = this.am.currentIndexFor(provider);
      if (idx != null) rows.add(idx);
    }
    return rows;
  }

  /**
   * One line over the account list summing up the fleet: the average weekly
   * use of the enabled subscription accounts that report one, and the least
   * used of them; how many have their five-hour window under half (an empty
   * window, which the expiry sweep leaves at reset, is unused); and how many
   * sit at their switch threshold on the five-hour or the weekly window.
   *
   * It takes the spacer line the list already has, so nothing below it moves,
   * and it is that empty spacer, as before, with fewer than two such accounts
   * or with two providers on screen, whose quotas do not add up. Segments drop
   * from the end when the terminal is too narrow for them.
   *
   * @param {number} W
   * @param {{ provider: string, indices: number[] }[]} groups
   * @returns {string}
   */
  _fleetLine(W, groups) {
    // [local patch 2026-10-27 원장] 집중 계정이 있으면 이 줄 맨 앞에 `🎯 집중 …`. 요약이 없는 구성
    // (계정 2개 미만·두 공급자)에서도 집중 표시만은 남긴다.
    const focusSeg = this._focusSeg();
    const only = focusSeg ? ` ${focusSeg}` : '';
    if (groups.length !== 1) return only;
    const accts = this.am.accounts.filter((/** @type {any} */ a) => a && !a.disabled && isSubscriptionAccount(a));
    if (accts.length < 2) return only;
    const num = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
    const pct = (/** @type {number} */ v) => `${Math.round(v * 100)}%`;
    const thFor = (/** @type {string} */ k, /** @type {any} */ a) =>
      (typeof this.am.thresholdFor === 'function' ? this.am.thresholdFor(k, a) : this.am.switchThreshold);
    const segs = [];
    const weekly = accts.filter((/** @type {any} */ a) => num(a.quota?.unified7d));
    if (weekly.length) {
      const avg = weekly.reduce((/** @type {number} */ s, /** @type {any} */ a) => s + a.quota.unified7d, 0) / weekly.length;
      const low = weekly.reduce((/** @type {any} */ m, /** @type {any} */ a) => (a.quota.unified7d < m.quota.unified7d ? a : m));
      segs.push(`Wk avg ${pct(avg)} ${dim(`(lowest ${safeLine(low.name, 40)} ${pct(low.quota.unified7d)})`)}`);
    }
    const under = accts.filter((/** @type {any} */ a) => !num(a.quota?.unified5h) || a.quota.unified5h < 0.5).length;
    segs.push(`5h: ${under}/${accts.length} under 50%`);
    const atLimit = accts.filter((/** @type {any} */ a) => {
      const q = a.quota || {};
      const at = (/** @type {string} */ k) => num(q[k]) && num(thFor(k, a)) && q[k] >= thFor(k, a);
      return at('unified5h') || at('unified7d');
    }).length;
    segs.push(atLimit ? red(`${atLimit} at limit`) : dim('0 at limit'));
    if (focusSeg) segs.unshift(focusSeg);
    const head = ` ${bold('Fleet')}  `;
    while (segs.length) {
      const line = head + segs.join(dim('  ·  '));
      if (vw(line) <= W - 1) return line;
      segs.pop();
    }
    return only;
  }

  /** [local patch 2026-10-27 원장] `🎯 집중 이름` (한도 때문에 잠시 넘겨준 상태면 꼬리 안내). 없으면 ''. */
  _focusSeg() {
    const info = typeof this.am.focusInfo === 'function' ? this.am.focusInfo() : null;
    if (!info?.name) return '';
    const name = safeLine(info.name, 64);
    return info.state === 'away'
      ? orange(`${bold(`🎯 집중 ${name}`)} (한도 — 잠시 다른 계정)`)
      : orange(bold(`🎯 집중 ${name}`));
  }

  /**
   * The Host line under the fleet line: this process's sampler when it has
   * one, else the snapshot the server sent (attach mode). '' when hostLine is
   * off or there is nothing to show. Never waits on a sample.
   * @param {number} W
   */
  _hostLine(W) {
    if (this.config?.hostLine === false) return '';
    let snap = null;
    try { snap = this.hostStats ? this.hostStats.snapshot() : (this.am.host ?? null); } catch { snap = null; }
    return formatHostLine(snap, W, this._cleanupAvailable() ? (this._leftovers ?? {}) : null);
  }

  _renderAcct(idx, bw, showBoth, routes = this.am.getRoutes(), genRoutes = routes.filter(r => routeFamily(r) === null), familyTarget = {}, showFamily = true, nameW = NAME_MIN, { current = this._currentRows(), compact = false, shortBar = true, sessions = null, width = 0, parts = null } = {}) {
    const a = this.am.accounts[idx];
    const isCur = current.has(idx);
    const isSel = this.mode === 'select' && idx === this.selIdx;

    // Prefix: selection marker + current marker.
    //
    // In switch mode with a Fable/Sonnet route as the pin target, the cursor
    // moves to that family's bar — in front of `F7` / `S7`, where the pin's ►
    // will land — and the row start keeps a dim `>` so the row stays easy to
    // find. The move only happens when the row draws that bar; a row without
    // it keeps the cursor at the start, since there is nothing to point at.
    const q = a.quota;
    const selFamily = isSel && this.selAction === 'switch' && this.selRoute ? routeFamily(this.selRoute) : null;
    const barShown = fam => showBoth && showFamily && q[fam === 'fable' ? 'unified7dFable' : 'unified7dSonnet'] != null;
    const cursorAt = selFamily && barShown(selFamily) ? selFamily : null;
    // [local patch 2026-10-27 원장] 집중 계정 줄: 선택 칸에 주황 ◎, 이름은 굵은 주황.
    const focusName = typeof this.am.focusInfo === 'function' ? this.am.focusInfo()?.name : null;
    const isFocus = !!focusName && a.name === focusName;
    const sel = !isSel ? (isFocus ? orange('◎') : ' ') : cursorAt ? dim('>') : cyan('>');
    // [local patch 2026-10-27 원장] 초록 ► (현재 계정) 표시는 설정 currentArrow:false 면 뺀다 — 세션마다 계정이 달라 의미가 없다. 칸은 유지.
    const cur = isCur && this.config?.currentArrow !== false ? green('►') : ' ';
    // The column before a family bar's marker: the cursor when it moved here, else the separator space.
    const famLead = fam => (cursorAt === fam ? cyan('>') : ' ');

    // General-route markers: one fixed column per general route (stable order), so
    // the same route always sits in the same slot across accounts. A member shows
    // its colored ►, others a blank. Family routes (fable/sonnet) are drawn by the
    // F7/S7 bars below instead.
    const memberOf = (route) => route.accounts.find(x => x.name === a.name);
    const startCells = genRoutes.map(r => {
      const m = memberOf(r);
      return m ? routeGlyph(routeColorFn(r.color), m.eligible, r.pinned === a.name) : ' ';
    });
    const startSlot = genRoutes.length ? `${startCells.join('')} ` : '';

    // Family (Fable/Sonnet) marker for this account's F7/S7 bar: a single ► on the
    // one account that bucket currently routes to — the secondary-quota analogue of
    // the default route's ►, not one marker per eligible account. Every account
    // meters the bucket, so "membership" is meaningless here; only the live routing
    // target matters. Bold when that target is the route's manual pin; the route's
    // configured color is honored, else cyan.
    const familyMark = (fam) => {
      if (familyTarget[fam] !== idx) return ' ';
      const r = routes.find(x => routeFamily(x) === fam);
      const pinned = r ? r.pinned === a.name : false;
      return routeGlyph(routeColorFn(r?.color), true, pinned);
    };

    // Name (bold if selected), cut and padded in display columns. A
    // slice/padEnd pair counts UTF-16 units instead, so a six-character CJK
    // name keeps all six characters and still collects six columns of padding,
    // shifting everything after it. truncate stops a column short of the limit
    // when it drops a wide glyph that would straddle it, so rpad finishes the
    // cell.
    const rawName = rpad(truncate(a.name, nameW), nameW);
    // The colours of the sessions pinned here run under the name; the cursor's
    // bold name wins on the selected row.
    const name = isSel ? bold(rawName)
      : sessions?.length ? sessionNameCell(a.name, nameW, sessions)
      : isFocus ? orange(bold(rawName))
      : rawName;

    // Type — or the provider, once the pool serves more than one.
    //
    // One person's ChatGPT and Claude subscriptions are usually the same email, so a
    // mixed pool lists that address twice and the name column cannot tell the two rows
    // apart. `oauth` repeated down every row is what the column says instead, which the
    // operator already knew. Width follows the labels actually present, so nothing is
    // truncated and a single-provider pool keeps the column it has today.
    // A pane draws no type cell: its title names the provider.
    const { mixed, width: typeW } = typeColumn(this.am.accounts);
    const type = compact ? '' : `${gray((mixed ? PROVIDERS[providerOf(a)].label : a.type).padEnd(typeW))} `;

    // Status — a disabled account is shown as such regardless of its quota state.
    // So is one rotation will not reach although its own status says active: the
    // entitlement cooldown a 403 arms and the usage caps live beside the status,
    // not in it, and a row reading `active` for an account that receives nothing
    // sent operators looking at the wrong thing (#468). Live, the manager says;
    // in attach mode the status payload carries the same reason.
    const barred = typeof this.am.unavailableReason === 'function'
      ? this.am.unavailableReason(a)
      : (a.unavailable ?? null);
    let status;
    if (a.disabled) {
      status = gray('disabled');
    } else if (barred === 'entitlement') {
      const until = typeof a.entitlementDeniedUntil === 'string' ? Date.parse(a.entitlementDeniedUntil) : a.entitlementDeniedUntil;
      const left = formatReset(until);
      status = yellow(left ? `denied ${left}` : 'denied');
    } else if (typeof barred === 'string' && /capped$/.test(barred)) {
      status = yellow('capped');
    } else switch (a.status) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'throttled': status = yellow('throttled'); break;
      case 'exhausted': status = red('exhausted'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    status = rpad(status, 10);

    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null, w1 = null, w2 = null;

    const backendWindows = q.backend?.windows
      ? { fiveHour: bwLive(q.backend.windows.fiveHour), weekly: bwLive(q.backend.windows.weekly), monthly: bwLive(q.backend.windows.monthly) }
      : undefined;
    let r2BackendMonthly = false;
    const category = rowCategory(a);
    if (category !== 'metered') {
      // A third-party backend has no unified readings; its probed windows fill
      // the same slots. No threshold: rotation gates nothing on a backend, so
      // its bars never redden at one.
      r1 = q.unified5h ?? backendWindows?.fiveHour?.utilization ?? null;
      r2 = q.unified7d ?? backendWindows?.weekly?.utilization ?? null;
      t1 = q.unified5hReset ?? backendWindows?.fiveHour?.resetAt ?? null;
      t2 = q.unified7dReset ?? backendWindows?.weekly?.resetAt ?? null;
      w1 = FIVE_HOUR_MS;
      w2 = SEVEN_DAY_MS;
      // A plan with a monthly window and no weekly one (the newer Kimi plans)
      // puts the month in the Wk slot rather than leaving it empty.
      if (r2 == null && q.unified7d == null && backendWindows?.monthly != null) {
        l2 = 'Mon';
        r2 = backendWindows.monthly.utilization;
        t2 = backendWindows.monthly.resetAt;
        w2 = MONTH_MS;
        r2BackendMonthly = true;
      }
    } else {
      l1 = 'Tok';
      l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
      t2 = t1;
    }

    // The live routing threshold, so a bucket the rotation already refuses to
    // use reads red however healthy its pace looks.
    // Each bar reddens at ITS bucket's threshold (a per-bucket table may set
    // the weekly one lower than the 5-hour one), further overridden by THIS
    // account's own switchThreshold (#409) when it has one; the attach-mode
    // manager mirrors thresholdFor(bucket, account), so both dashboards agree
    // with the gate.
    const thFor = (k) => (typeof this.am.thresholdFor === 'function' ? this.am.thresholdFor(k, a) : this.am.switchThreshold);
    // A per-account cap (accounts[].maxUsage) is the lower ceiling when it is
    // set, and it is the harder one — past it the account is sent nothing at
    // all. Reddening at the cap keeps the bar honest about where this account
    // actually stops. Read straight off the account so the attached dashboard,
    // which has the payload but no AccountManager, agrees with the server.
    const limFor = (k) => {
      const cap = resolveMaxUsage(a.maxUsage, k);
      const th = thFor(k);
      return cap == null ? th : (typeof th === 'number' ? Math.min(th, cap) : cap);
    };
    // Per slot, not per row: a slot filled from a backend window carries no
    // threshold (rotation gates nothing on it), whatever its neighbour holds.
    const r1Backend = q.unified5h == null && backendWindows?.fiveHour != null;
    const r2Backend = q.unified7d == null && backendWindows?.weekly != null;
    let th1 = r1Backend ? null : limFor(r1 === q.unified5h ? 'unified5h' : 'tokens');
    const th2 = (r2Backend || r2BackendMonthly) ? null : limFor(r2 === q.unified7d ? 'unified7d' : 'requests');

    // A list with no five-hour window to draw (see _listLayout) starts the row
    // at the weekly bar.
    const weeklyFirst = !shortBar && category !== 'metered';
    // A Codex row whose subscription meters no five-hour window draws only the
    // weekly bar even while Claude rows on the same list keep Ses/Wk: a `Ses -`
    // cell there said nothing. Keyed on the fact the reading left behind
    // (`sessionWindowStated`, see _updateCodexQuota), never on `unified5h`
    // being empty: the expiry sweep nulls that every five hours on a row that
    // does have a session window, and the row would swing between the two
    // shapes. An account that has not reported keeps both cells, so the row
    // does not change shape at startup. A reading that is still present keeps
    // its cell whatever the flag says (showSessionRow): it may be the one
    // holding the account out of rotation. The weekly bar takes the two cells'
    // width (bar + `  Wk ` + bar) so the row still ends where its neighbours do.
    const weeklyOnly = !weeklyFirst && showBoth && category === 'unified'
      && providerOf(a) === 'codex' && !showSessionRow(q) && q.unified7d != null;
    if (weeklyFirst || weeklyOnly) [l1, r1, t1, w1, th1] = [l2, r2, t2, w2, th2];
    const bw1 = weeklyOnly ? bw * 2 + 6 : bw;

    // Keep the optional chaining: _renderAcct is called on instances built
    // without a config, and it read none before this line existed.
    const pctInBar = this.config?.quotaBarPercent === true;

    let line = ` ${sel}${cur} ${startSlot}${name} ${type}${status} ${l1} ${bar(r1, bw1, t1, w1, th1, pctInBar)}`;
    /** 구독 꼬리가 모자랄 때 먼저 빼는 모델별 주간 칸(S7·F7, 뒤에서부터). */
    const droppable = [];
    if (showBoth) {
      if (!weeklyFirst && !weeklyOnly) line += `  ${l2} ${bar(r2, bw, t2, w2, th2, pctInBar)}`;
      // A backend's monthly window has no unified slot; it draws its own bar
      // and is budgeted as a family column, like S7/F7.
      if (showFamily && backendWindows?.monthly != null && l2 !== 'Mon') {
        line += `  Mon ${bar(backendWindows.monthly.utilization, bw, backendWindows.monthly.resetAt, MONTH_MS, null, pctInBar)}`;
      }
      // Sonnet weekly bar — only shown when the usage probe has populated it. A
      // leading ► (in place of a padding space) marks a Sonnet route on this account.
      if (showFamily && q.unified7dSonnet != null) {
        const seg = `${famLead('sonnet')}${familyMark('sonnet')}S7  ${bar(q.unified7dSonnet, bw, q.unified7dSonnetReset, SEVEN_DAY_MS, limFor('unified7dSonnet'), pctInBar)}`;
        line += seg;
        if (cursorAt !== 'sonnet') droppable.push(seg);
      }
      // Fable weekly bar — only shown when the usage probe has populated it.
      if (showFamily && q.unified7dFable != null) {
        const seg = `${famLead('fable')}${familyMark('fable')}F7  ${bar(q.unified7dFable, bw, q.unified7dFableReset, SEVEN_DAY_MS, limFor('unified7dFable'), pctInBar)}`;
        line += seg;
        if (cursorAt !== 'fable') droppable.push(seg);
      }
    }
    // Explicit "disabled for these models" tag (issue #85): a family the account
    // can't serve even while it is otherwise active. A spent shared 5h blocks
    // everything and is already conveyed by the Ses bar + status, so it's not
    // repeated here.
    //
    // limFor, not thresholdFor: it is min(per-bucket threshold, per-account cap),
    // so the tag covers both ceilings and still judges each family against its
    // OWN configured threshold.
    const blocked = shownBlockedFamilies(q, limFor);
    if (blocked.length) line += `  ${red('⊘ ' + blocked.join(' '))}`;
    // Money tag last, so it sits at the end of the row where the eye lands after
    // the bars. Red once real money has moved, yellow while it only could.
    const money = spendTag(q, a.maxSpend);
    // Red once real money has moved (the tag then carries an amount), yellow
    // while it only could (a bare `$`, with or without its `/cap`).
    if (money) line += `  ${(/\d/.test(money.split('/')[0]) ? red : yellow)(money)}`;
    // Extra-usage fallback: allowed reads yellow like a bare `$`; serving on
    // it is billing now, so red like a billed amount.
    const xu = extraUsageTag(a.allowExtraUsage === true, this._onExtraUsage(a));
    if (xu) line += `  ${(xu === 'xu!' ? red : yellow)(xu)}`;
    // Free reset credits sit beside the money tag: both report what this
    // account holds in reserve rather than what it is currently spending.
    const credits = resetCreditTag(q);
    if (credits) line += `  ${cyan(credits)}`;
    // Switch-threshold tag (issue #409) trails everything else: it is a config
    // fact about the account, not a live state like the two tags above it, and
    // it is silent for the common case (no override, or one that just repeats
    // the fleet's own numbers) — see switchThresholdTag.
    const switchTag = switchThresholdTag(a, key => this.am.thresholdFor(key));
    if (switchTag) line += `  ${cyan(switchTag)}`;
    // Routing tag trails even that: where the account's traffic physically
    // leaves the machine, when the operator pinned it to its own proxy.
    const routeTag = routingTag(a);
    if (routeTag) line += `  ${cyan(routeTag)}`;
    // [local patch 2026-10-24 원장] 월 구독 갱신일 — 맨 끝.
    // [local patch 2026-10-26 원장] 줄 너비(width)를 알면 글자 중간에서 잘리지 않게:
    // 먼저 F7→S7 칸을 차례로 빼 보고, 그래도 안 들어가면 꼬리를 통째로 뺀다.
    const subTag = this._subscriptionTail(a);
    // 목록 그리기(_renderRows)는 몸통과 꼬리를 따로 받아 열을 맞춘 뒤 붙인다.
    if (parts) { parts.push({ body: line, droppable, tail: subTag, width }); return line; }
    if (subTag) {
      if (!(width > 0)) line += subTag;
      else {
        let cand = line;
        for (;;) {
          if (vw(cand) + vw(subTag) <= width) { line = cand + subTag; break; }
          const seg = droppable.pop();
          if (!seg) break;
          cand = cand.replace(seg, '');
        }
      }
    }
    return line;
  }

  /**
   * [local patch 2026-10-24 원장] ` · 구독 11/22 D-29` 꼬리(색 포함). 정보가 없으면 ''.
   * 로컬은 계정의 subscriptionCreatedAt, attach 모드는 status 의 subscription 에서 읽는다.
   * D-3 이하는 주황, D-day·비활성 상태는 빨강.
   * @param {any} a
   * @param {boolean} [plain]  색 없이 글자만
   */
  _subscriptionTail(a, plain = false) {
    const src = a?.subscription ?? (a?.subscriptionCreatedAt || a?.renewDate ? { createdAt: a.subscriptionCreatedAt, status: a.subscriptionStatus, renewDate: a.renewDate } : null);
    const t = subscriptionText(src);
    if (!t) return '';
    const body = ` · ${t.text}`;
    if (plain) return body;
    return t.level >= 2 ? red(body) : t.level === 1 ? orange(body) : dim(body);
  }

  /** Whether the account behind this row is serving on extra usage. Asked of
   * the manager, which answers the same way in-process and attached.
   * @param {{ index: number, onExtraUsage?: boolean }} a */
  _onExtraUsage(a) {
    return typeof this.am.onExtraUsage === 'function' ? this.am.onExtraUsage(a.index) : a.onExtraUsage === true;
  }

  /**
   * The `viewH` lines of `body` to draw, scrolled so that line `sel` (the
   * cursor row, or -1 for none) is on screen and never under the edge markers.
   * A body that fits is returned as is. Otherwise the first and last visible
   * lines become `↑ N more` / `↓ N more` markers whenever there is something
   * past them, so the fold is never silent. The scroll position persists
   * between frames (`setScroll`) and only moves when the cursor would leave
   * the window, so paging with ↑↓ reads like a list, not a jump per keypress.
   * @param {string[]} body
   * @param {number} sel
   * @param {number} viewH
   */
  _viewport(body, sel, viewH) {
    const n = body.length;
    if (n <= viewH || viewH < 3) { this.setScroll = 0; return body.slice(0, Math.max(0, viewH)); }
    let top = Math.min(Math.max(0, this.setScroll || 0), n - viewH);
    if (sel >= 0) {
      // One line of margin at each edge is where a marker may be drawn; the
      // cursor row must never be the line a marker replaces.
      if (sel < top + 1) top = Math.max(0, sel - 1);
      if (sel > top + viewH - 2) top = Math.min(n - viewH, sel - viewH + 2);
    }
    this.setScroll = top;
    const out = body.slice(top, top + viewH);
    if (top > 0) out[0] = dim(`  ↑ ${top} more`);
    if (top + viewH < n) out[viewH - 1] = dim(`  ↓ ${n - top - viewH} more`);
    return out;
  }

  /**
   * Draws the settings screen into `lines`; returns the index in `lines` of the
   * cursor row, or -1 when no row is selected (so the caller can keep it on screen).
   * @param {string[]} lines
   */
  _renderSettings(lines) {
    const fields = this._settingsFields();
    if (this.setIdx >= fields.length) this.setIdx = Math.max(0, fields.length - 1);
    const selId = fields[this.setIdx]?.id;
    let selLine = -1;
    const byId = id => fields.find(f => f.id === id);

    // Render a navigable setting row with a BIOS-style highlight bar on the
    // cursor row. Read-only info rows pass field=null and never highlight.
    const row = field => {
      const selected = field && field.id === selId;
      const label = (field ? field.label : '').padEnd(16);
      const value = field ? field.value() : '';
      if (selected) {
        selLine = lines.length;   // the row is pushed right after this returns
        const hint = field.hint ? `   ${dim(field.hint)}` : '';
        const inner = rpad(` ${label}  ${strip(value)} `, 34);
        return `  ${cyan('▸')}${REV}${inner}${RESET}${hint}`;
      }
      return `    ${dim(label)}  ${value}`;
    };
    // A plain read-only info line (not selectable), aligned with the rows above.
    const info = (label, value) => `    ${dim(label.padEnd(16))}  ${value}`;

    lines.push('');
    // ── Rotation
    lines.push(bold('  Rotation') + dim('  — switch accounts when quota crosses the threshold'));
    lines.push(row(byId('threshold')));
    lines.push(row(byId('autoRedeemResets')));
    lines.push(dim('  Spend a free Codex rate-limit reset credit when the whole pool'));
    lines.push(dim('  is dry. Irreversible and scarce — off unless you say otherwise.'));
    lines.push(row(byId('rebalance')));
    lines.push(dim('  A session back from a break (its cache gone) moves to a less-spent'));
    lines.push(dim('  account. Acts only with session distribution on.'));
    lines.push('');
    // ── Quota probe
    lines.push(bold('  Quota probe') + dim('  — refresh idle accounts from the usage endpoint'));
    lines.push(row(byId('probe')));
    lines.push('');
    // ── Quota bars
    lines.push(bold('  Quota bars') + dim('  — what the bar on each account row carries'));
    lines.push(row(byId('quotaBarPercent')));
    lines.push('');
    // ── Dashboard
    lines.push(bold('  Dashboard') + dim('  — what is drawn around the account list'));
    lines.push(row(byId('sessionRows')));
    lines.push(dim('  A panel under the accounts listing each known session and its account.'));
    lines.push(row(byId('hostLine')));
    lines.push(dim('  Memory in use and the busiest processes, under the fleet line.'));
    lines.push('');
    // ── Activity log
    lines.push(bold('  Activity log') + dim('  — what to do with Claude Code\'s telemetry'));
    lines.push(row(byId('eventlog')));
    lines.push(row(byId('activityFormat')));
    lines.push(row(byId('activityFold')));
    if (byId('sessionTitles')) lines.push(row(byId('sessionTitles')));
    lines.push('');
    // ── Launch
    lines.push(bold('  Launch') + dim('  — how `octopus run` and `env` reach the proxy when no flag says'));
    lines.push(row(byId('clientMode')));
    lines.push('');
    // ── Routing
    lines.push(bold('  Routing') + dim('  — pin model families to specific accounts, or block them outright'));
    lines.push(row(byId('routes')));
    lines.push(row(byId('blocklist')));
    lines.push('');
    // ── Accounts
    lines.push(bold('  Accounts') + dim('  — add (import / API key), remove, or set the order they list in'));
    lines.push(row(byId('addAccount')));
    if (byId('removeAccount')) lines.push(row(byId('removeAccount')));
    if (byId('orderAccounts')) lines.push(row(byId('orderAccounts')));
    if (byId('accountSort')) {
      lines.push(row(byId('accountSort')));
      lines.push(dim('  A reset sort lists the account whose window ends soonest first;'));
      lines.push(dim('  S7/F7 read the weekly window on an account without one. The'));
      lines.push(dim('  arranged order breaks ties.'));
    }
    lines.push('');
    // ── Network
    // Drawn before the sx.org block, which returns early when sx is unavailable:
    // this setting is the one a host behind a corporate proxy needs, and it must
    // not disappear along with an unrelated integration.
    lines.push(bold('  Network') + dim('  — how this machine reaches Anthropic'));
    lines.push(row(byId('upstreamProxy')));
    if (byId('accountProxy')) lines.push(row(byId('accountProxy')));
    lines.push(dim('  Set when the machine has no direct route out (HTTPS_PROXY is'));
    lines.push(dim('  picked up automatically). Applies to requests, login and refresh.'));
    if (byId('accountProxy')) {
      lines.push(dim('  An account proxy carries ONE account instead, all of its traffic:'));
      lines.push(dim('  socks5h://user:pass@host:1080 (also socks5, socks4a, socks4, http).'));
    }
    lines.push('');
    // ── sx.org
    lines.push(bold('  sx.org proxy') + dim('  — route upstream via a residential IP (429 workaround)'));
    lines.push('');
    if (!this.sx) { lines.push(yellow('  Unavailable in this build.')); return selLine; }
    const key = this.config.sx?.apiKey;
    const mode = this.sx.getMode();
    const p = this.sx.getProxy?.();
    const proxyStr = mode === 'off' ? gray('—')
      : this.sx.isProvisioned() ? green(`${p.host}:${p.port}`)
      : key ? yellow('not provisioned')
      : gray('no key');
    const b = this.sxBalance;
    lines.push(row(byId('sxmode')));
    lines.push(row(byId('sxkey')));
    lines.push(info('Proxy', proxyStr));
    lines.push(info('Balance', b ? green('$' + Number(b.balance).toFixed(4)) : dim('…')));
    if (byId('sxclear')) lines.push(row(byId('sxclear')));
    lines.push('');
    lines.push(dim('  always    tunnel ALL upstream traffic through sx.org'));
    lines.push(dim('  on 429    only retry through sx.org after a 429 (fresh IP)'));
    lines.push(dim('  off       never use sx.org (API key is kept)'));
    lines.push('');
    lines.push(dim('  TLS stays end-to-end; residential traffic is metered by sx.org.'));
    if (!key) {
      lines.push('');
      lines.push(dim('  No sx.org account yet? Signing up via https://sx.org/c/ufVrLW'));
      lines.push(dim('  costs nothing extra and supports TeamClaude development.'));
    }
    return selLine;
  }

  // ── routes editor ──────────────────────────────────

  _keyRoutes(k) {
    const routes = this.config.routes || [];
    const n = routes.length;
    if (this.routeIdx >= n) this.routeIdx = Math.max(0, n - 1);
    if ((k === 'up' || k === 'k') && n) this.routeIdx = (this.routeIdx - 1 + n) % n;
    else if ((k === 'down' || k === 'j') && n) this.routeIdx = (this.routeIdx + 1) % n;
    else if (k === 'a') this._routeEdit(null);
    else if (k === 'e' && n) this._routeEdit(routes[this.routeIdx]);
    else if (k === 'd' && n) this._routeDelete(this.routeIdx);
    else if (k === 'esc' || k === 'q') { this.mode = 'settings'; this.setIdx = 0; }
  }

  // Prompt for one route field, prefilled, returning to the routes screen.
  // Unlike _promptInput this passes empty values through (so optional fields can
  // be left blank) and lets the caller chain the next prompt.
  _routePrompt(label, prefill, cb) {
    this.mode = 'input';
    this.inputReturn = 'routes';
    this.inputPrompt = label;
    this.inputBuf = prefill || '';
    this.inputCb = v => cb((v || '').trim());
  }

  // A modal list picker used by the routes editor so fixed-choice fields are
  // selected rather than typed. `multi` gives a checkbox multi-select (Space
  // toggles, Enter confirms the set); otherwise it's single-select (Enter picks
  // the highlighted row). `cb` receives the chosen value(s). Esc/q cancels
  // without calling cb — which, like the text prompts, abandons the whole edit.
  _openPicker({ title, hint, items, multi, selected, cb }) {
    this.mode = 'pick';
    this.pickReturn = 'routes';
    this.pick = {
      title, hint, items, multi, cb,
      idx: multi ? 0 : Math.max(0, items.findIndex(it => it.value === (selected || ''))),
      sel: new Set(multi ? (selected || []) : []),
    };
  }

  // Checklist of the loaded accounts. Preselects the route's current members;
  // selecting none means "all accounts" (route.accounts is then omitted).
  _pickAccounts(preselected, cb) {
    this._openPicker({
      title: 'Route accounts',
      hint: 'Space toggles — none selected = all accounts',
      multi: true,
      selected: preselected,
      items: this.am.accounts.map(a => ({ label: a.name, value: a.name })),
      cb,
    });
  }

  // Which weekly quota bucket meters the route (auto = pick by model family).
  _pickBucket(current, cb) {
    this._openPicker({
      title: 'Quota bucket',
      hint: 'weekly bucket this route is metered against',
      multi: false,
      selected: current,
      items: [
        { label: 'auto (by model family)', value: '' },
        { label: 'unified7d (shared weekly)', value: 'unified7d' },
        { label: 'unified7dFable', value: 'unified7dFable' },
        { label: 'unified7dSonnet', value: 'unified7dSonnet' },
      ],
      cb,
    });
  }

  // The dashboard marker color for the route (default = plain cyan).
  _pickColor(current, cb) {
    this._openPicker({
      title: 'Marker color',
      hint: 'highlights this route on the dashboard',
      multi: false,
      selected: current,
      items: [
        { label: 'default', value: '' },
        ...ROUTE_COLORS.map(c => ({ label: c, value: c, paint: routeColorFn(c) })),
      ],
      cb,
    });
  }

  _keyPick(k) {
    const p = this.pick;
    if (!p) { this.mode = this.pickReturn; return; }
    const len = p.items.length;
    if (k === 'up' || k === 'k') p.idx = Math.max(0, p.idx - 1);
    else if (k === 'down' || k === 'j') p.idx = Math.min(len - 1, p.idx + 1);
    else if (p.multi && (k === ' ' || k === 'x')) {
      const v = p.items[p.idx]?.value;
      if (v != null) { p.sel.has(v) ? p.sel.delete(v) : p.sel.add(v); }
    }
    else if (k === 'enter') {
      const cb = p.cb;
      this.pick = null;
      this.mode = this.pickReturn;
      if (p.multi) cb?.(p.items.filter(it => p.sel.has(it.value)).map(it => it.value));
      else cb?.(p.items[p.idx]?.value ?? '');
    }
    else if (k === 'esc' || k === 'q') { this.pick = null; this.mode = this.pickReturn; }
  }

  _renderPick(lines) {
    const p = this.pick;
    if (!p) return;
    lines.push('');
    lines.push(bold('  ' + p.title) + (p.hint ? dim('  — ' + p.hint) : ''));
    lines.push('');
    if (!p.items.length) {
      lines.push(gray('    (no accounts loaded — a route with none set serves all)'));
      return;
    }
    p.items.forEach((it, i) => {
      const cur = i === p.idx;
      const cursor = cur ? cyan('▸') : ' ';
      const mark = p.multi
        ? (p.sel.has(it.value) ? green('[x]') : dim('[ ]'))
        : (cur ? cyan('◉') : dim('◯'));
      const paint = it.paint || (s => s);
      lines.push(`   ${cursor} ${mark} ${paint(cur ? bold(it.label) : it.label)}`);
    });
  }

  // Guided add/edit: name → glob(s) → accounts → bucket → save. `orig` is the
  // existing route being edited, or null when adding.
  _routeEdit(orig) {
    const draft = {
      match: (orig ? (Array.isArray(orig.match) ? orig.match : [orig.match]) : []).join(', '),
      accounts: (orig?.accounts || []).join(', '),
      bucket: orig?.bucket || '',
      color: orig?.color || '',
    };
    this._routePrompt('Route name', orig?.name || '', name => {
      if (!name) { this._addLog('Route name required — cancelled'); this.mode = 'routes'; return; }
      draft.name = name;
      this._routePrompt('Model glob(s), comma-separated (e.g. *fable*)', draft.match, match => {
        if (!match) { this._addLog('At least one glob required — cancelled'); this.mode = 'routes'; return; }
        draft.match = match;
        // Accounts, bucket and color are all fixed-choice, so they're pickers
        // rather than typed fields — no free text, and no giant account-name hint
        // that used to spill off the footer (issue #130). Only name and glob stay
        // typed, since those are arbitrary strings.
        this._pickAccounts(splitCsv(draft.accounts), accts => {
          draft.accounts = accts.join(', ');
          this._pickBucket(draft.bucket, bucket => {
            draft.bucket = bucket;
            this._pickColor(draft.color, color => {
              draft.color = color;
              this._routeSave(draft, orig);
            });
          });
        });
      });
    });
  }

  async _routeSave(draft, orig) {
    const route = { name: draft.name, match: splitCsv(draft.match) };
    const accounts = splitCsv(draft.accounts);
    if (accounts.length) route.accounts = accounts;
    if (draft.bucket) route.bucket = draft.bucket;
    if (draft.color) {
      if (isRouteColor(draft.color)) route.color = draft.color.toLowerCase();
      else this._addLog(`Unknown color "${draft.color}" — using default`);
    }

    this.config.routes = this.config.routes || [];
    const at = orig ? this.config.routes.indexOf(orig)
      : this.config.routes.findIndex(r => r.name === route.name);
    if (at >= 0) this.config.routes[at] = route; else this.config.routes.push(route);

    this.am.setRoutes(this.config.routes); // apply to the running rotation immediately
    try { await this.saveConfig(this.config); this._addLog(`Route "${route.name}" saved`); }
    catch (e) { this._addLog(`Failed to save route: ${e.message}`); }
    this.mode = 'routes';
    this.routeIdx = at >= 0 ? at : this.config.routes.length - 1;
    if (this.running) this.render();
  }

  async _routeDelete(idx) {
    const routes = this.config.routes || [];
    const r = routes[idx];
    if (!r) return;
    routes.splice(idx, 1);
    this.am.setRoutes(routes);
    try { await this.saveConfig(this.config); this._addLog(`Route "${r.name}" deleted`); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    this.routeIdx = Math.max(0, Math.min(idx, routes.length - 1));
    if (this.running) this.render();
  }

  _keyBlocklist(k) {
    const list = this.config.blockedModels || [];
    const n = list.length;
    if (this.blockIdx >= n) this.blockIdx = Math.max(0, n - 1);
    if ((k === 'up' || k === 'k') && n) this.blockIdx = (this.blockIdx - 1 + n) % n;
    else if ((k === 'down' || k === 'j') && n) this.blockIdx = (this.blockIdx + 1) % n;
    else if (k === 'a') this._blocklistAdd();
    else if (k === 'd' && n) this._blocklistDelete(this.blockIdx);
    else if (k === 'esc' || k === 'q') { this.mode = 'settings'; this.setIdx = 0; }
  }

  // Prompt for a model glob and add it to the blocklist, staying on the editor.
  _blocklistAdd() {
    this.mode = 'input';
    this.inputReturn = 'blocklist';
    this.inputPrompt = 'Block model glob (e.g. *fable*)';
    this.inputBuf = '';
    this.inputCb = v => this._doBlocklistAdd((v || '').trim());
  }

  async _doBlocklistAdd(pat) {
    if (!pat) { this._addLog('Blocklist add cancelled'); return; }
    this.config.blockedModels = this.config.blockedModels || [];
    if (this.config.blockedModels.includes(pat)) { this._addLog(`"${pat}" already blocked`); return; }
    this.config.blockedModels.push(pat);
    this.blockIdx = this.config.blockedModels.length - 1;
    try { await this.saveConfig(this.config); this._addLog(`Blocked model "${pat}"`); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    if (this.running) this.render();
  }

  async _blocklistDelete(idx) {
    const list = this.config.blockedModels || [];
    const pat = list[idx];
    if (pat == null) return;
    list.splice(idx, 1);
    this.blockIdx = Math.max(0, Math.min(idx, list.length - 1));
    try { await this.saveConfig(this.config); this._addLog(`Unblocked "${pat}"`); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    if (this.running) this.render();
  }

  _renderBlocklist(lines) {
    const list = this.config.blockedModels || [];
    lines.push('');
    lines.push(bold('  Blocked models') + dim('  — requests whose model matches a glob are rejected, not forwarded'));
    lines.push('');
    if (!list.length) {
      lines.push(gray('    Nothing blocked. Press [a] to add a glob (e.g. *fable*).'));
    } else {
      list.forEach((pat, i) => {
        const sel = i === this.blockIdx;
        const cursor = sel ? cyan('▸') : ' ';
        lines.push(`   ${cursor} ${red('✗')} ${sel ? bold(pat) : pat}`);
      });
    }
  }

  _renderRoutes(lines) {
    const routes = this.config.routes || [];
    lines.push('');
    lines.push(bold('  Routes') + dim('  — pin model globs to specific accounts (first match wins)'));
    lines.push('');
    if (!routes.length) {
      lines.push(gray('    No routes configured. Press [a] to add one.'));
    } else {
      routes.forEach((r, i) => {
        const sel = i === this.routeIdx;
        const cursor = sel ? cyan('▸') : ' ';
        const match = (Array.isArray(r.match) ? r.match : [r.match]).join(', ');
        const accts = (r.accounts && r.accounts.length) ? r.accounts.join(' ') : dim('(all accounts)');
        const bucket = r.bucket ? dim(`  [${r.bucket}]`) : '';
        const name = rpad(r.name || '(unnamed)', 14);
        lines.push(`   ${cursor} ${sel ? bold(name) : name} ${cyan(rpad(match, 22))} ${dim('→')} ${accts}${bucket}`);
      });
    }
    // Auto-detected routes (read-only) for context — a family metered separately
    // with no configured route. Pin one by adding a route with the same glob.
    const auto = this.am.getRoutes().filter(r => r.autocreated);
    if (auto.length) {
      lines.push('');
      lines.push(dim('  Auto-detected (not saved):'));
      for (const r of auto) {
        lines.push(dim(`     ${r.match.join(', ')} → ${r.accounts.map(a => a.name).join(' ')}`));
      }
    }
  }

  // ── [local patch 2026-10-27 원장] 한글 화면(설정 koLayout: true) ─────────────
  // 막대 이름은 머리글 한 줄(5시간 · 일주일 · Fable · 구독), 정상 계정엔 상태 글자 없음,
  // 세션은 시작 순 고정 + 최근 요청 칸, 아래는 알림(요청 줄 없이 전환·오류만).

  _koLayout() {
    return this.config?.koLayout === true;
  }

  /** 세션이 처음 보인 순서(번호)와 그 순서대로의 색. 서버를 다시 켜면 처음부터. */
  _sessSeq(/** @type {string} */ sid) {
    let n = this._sessOrder.get(sid);
    if (n == null) { n = this._sessOrder.size; this._sessOrder.set(sid, n); }
    return n;
  }

  _sessColor(/** @type {string} */ sid) {
    return KO_SESSION_FG[this._sessSeq(sid) % KO_SESSION_FG.length];
  }

  /** 계정 상태 분류: ok · rest(5시간/주간 기준 이상) · error · off. */
  _koState(/** @type {any} */ a) {
    // 결제 전에 미리 넣어 둔 계정(원장 2026-10-28): 꺼 둔 것과 같이 그리되 글자는 「결제 전」.
    if (a.pendingPlan) return 'pending';
    if (a.disabled) return 'off';
    if (a.status === 'error') return 'error';
    const q = a.quota || {};
    const th = (/** @type {string} */ b) => (typeof this.am.thresholdFor === 'function' ? this.am.thresholdFor(b, a) : (this.config.switchThreshold ?? 0.98));
    if ((q.unified5h != null && q.unified5h >= th('unified5h')) || (q.unified7d != null && q.unified7d >= th('unified7d'))) return 'rest';
    return 'ok';
  }

  /** @param {string[]} lines @param {number} W @param {number} bottom */
  _renderKo(lines, W, bottom) {
    const accts = this.am.accounts;
    const states = accts.map((/** @type {any} */ a) => this._koState(a));
    const cnt = (/** @type {string} */ k) => states.filter((/** @type {string} */ x) => x === k).length;
    const okN = cnt('ok'), restN = cnt('rest'), errN = cnt('error'), offN = cnt('off'), pendN = cnt('pending');
    const summary = ` 계정 ${accts.length} · ${okN ? green(`사용 가능 ${okN}`) : red('사용 가능 0')} · 쉬는 중 ${restN} · ${errN ? red(`오류 ${errN}`) : '오류 0'}${offN ? ` · 꺼 둠 ${offN}` : ''}${pendN ? ` · ${orange(`결제 전 ${pendN}`)}` : ''}`;
    const focus = this._focusSeg();
    lines.push(focus && vw(summary) + vw(focus) + 3 <= W ? summary + ' '.repeat(W - vw(summary) - vw(focus) - 1) + focus : summary);
    const host = this._hostLine(W);
    if (host) lines.push(host);
    lines.push(' ' + dim('─'.repeat(W - 2)));

    // 세션 목록(시작 순)과 계정별 세션 점
    const items = this._sessionItems();
    for (const s of items) this._sessSeq(s.id);
    items.sort((/** @type {any} */ x, /** @type {any} */ y) => this._sessSeq(x.id) - this._sessSeq(y.id));
    /** @type {Map<number, any[]>} */
    const byAcct = new Map();
    for (const s of items) {
      if (s.account == null || !s.active) continue;
      const l = byAcct.get(s.account);
      if (l) l.push(s); else byAcct.set(s.account, [s]);
    }

    // 계정 표
    const order = this._visibleRows(this._displayOrder());
    const BW = 16;
    const nameW = Math.min(24, Math.max(10, ...order.map((/** @type {number} */ i) => vw(accts[i].name.replace(KO_DOMAIN_RE, '')))));
    const anyFable = order.some((/** @type {number} */ i) => accts[i].quota?.unified7dFable != null);
    const cols = ['5시간', '일주일', ...(anyFable ? ['Fable'] : [])];
    // 「자동」 칸(5시간 막대 오른쪽, 원장 2026-10-28): 머리글 색 = 자동 켜기 설정(녹색 켬 · 빨강 끔),
    // 줄의 점 = 그 계정 5시간 창이 지금 도는지(_autoDot).
    const AUTO_W = vw('자동');
    const autoOn = this._autoWarmOn();
    const barsW = cols.length * BW + (cols.length - 1) * 2 + AUTO_W + 2;
    // 세션 점은 5시간 막대 바로 왼쪽(막히는 기준이 5시간이라 — 원장 2026-10-27). 최대 4개, 넘으면 +N.
    const DOT_MAX = 4;
    const dotsW = Math.min(DOT_MAX + 2, Math.max(0, ...order.map((/** @type {number} */ i) => {
      const n = (byAcct.get(i) || []).length;
      return n > DOT_MAX ? DOT_MAX + 2 : n;
    })));
    const dotCol = dotsW ? dotsW + 1 : 0;
    const hdr = cols.map(c => dim(rpad(c, BW)));
    hdr.splice(1, 0, (autoOn ? green : red)(rpad('자동', AUTO_W)));
    lines.push(`  ${' '.repeat(nameW)}  ${' '.repeat(dotCol)}${hdr.join('  ')}  ${dim('구독')}`);
    const th = (/** @type {any} */ a, /** @type {string} */ b) => (typeof this.am.thresholdFor === 'function' ? this.am.thresholdFor(b, a) : null);
    const pctOn = true;
    // W: 켤 계정(확인 화면)·켜는 중인 계정은 노란 * 로.
    const warmSet = this.mode === 'warm' ? new Set(this._warmPick || []) : this._warming;
    for (const i of order) {
      const a = accts[i];
      const q = a.quota || {};
      const isSel = this.mode === 'select' && i === this.selIdx;
      const warmOn = !!warmSet?.has(a);
      const focusName = typeof this.am.focusInfo === 'function' ? this.am.focusInfo()?.name : null;
      const mark = isSel ? cyan('>') : warmOn ? yellow('*') : (focusName && a.name === focusName ? orange('◎') : ' ');
      const nm = rpad(truncate(a.name.replace(KO_DOMAIN_RE, ''), nameW), nameW);
      const st = states[i];
      // 꺼 둔 계정과 결제 전 계정은 이름·막대·자동 점이 진한 회색.
      const off = st === 'off' || st === 'pending';
      const nameTxt = isSel ? bold(nm) : warmOn ? yellow(nm) : off ? offGray(nm) : nm;
      let body;
      // 언제부터인지 같이(서버를 다시 켜면 다시 시도한 시각) — 원장 2026-10-28.
      if (st === 'error') body = red(`⚠ 다시 로그인 필요 (L)${a.errorReason?.since ? ` · ${koClock(a.errorReason.since)}부터` : ''}`);
      else {
        // 꺼 둔 계정(원장 2026-10-28 「구독이 남아서 잠깐 안 쓰는 것」)도 막대·구독은 그대로, 색만 진한 회색.
        const paint = (/** @type {string} */ s) => off ? offGray(strip(s)) : s;
        const cells = [
          paint(bar(q.unified5h, BW, q.unified5hReset, FIVE_HOUR_MS, th(a, 'unified5h'), pctOn)),
          rpad(off ? offGray('●') : this._autoDot(i), AUTO_W),
          paint(bar(q.unified7d, BW, q.unified7dReset, SEVEN_DAY_MS, th(a, 'unified7d'), pctOn)),
        ];
        if (anyFable) cells.push(paint(q.unified7dFable != null
          ? bar(q.unified7dFable, BW, q.unified7dFableReset, SEVEN_DAY_MS, th(a, 'unified7dFable'), pctOn)
          : dim(rpad(' '.repeat(Math.floor(BW / 2)) + '─', BW))));
        body = cells.join('  ');
      }
      const subRaw = this._subscriptionTail(a, true).replace(/^ · 구독 /, '');
      const subT = subscriptionText(a?.subscription ?? (a?.subscriptionCreatedAt || a?.renewDate ? { createdAt: a.subscriptionCreatedAt, status: a.subscriptionStatus, renewDate: a.renewDate } : null));
      // 결제 전 계정(원장 2026-10-28)은 구독 자리에 주황 「결제 전」 — 결제가 확인되면 저절로 켜진다.
      const sub = st === 'pending' ? `${subRaw ? offGray(`${subRaw}  `) : ''}${orange('결제 전')}`
        : st === 'off' ? offGray(`${subRaw ? `${subRaw}  ` : ''}꺼 둠`)
        : !subRaw ? '' : subT && subT.level >= 2 ? red(subRaw) : subT && subT.level === 1 ? orange(subRaw) : dim(subRaw);
      const bodyW = st === 'error' ? vw(strip(body)) : barsW;
      const pad = ' '.repeat(Math.max(0, barsW - bodyW));
      const mine = byAcct.get(i) || [];
      const dots = mine.slice(0, DOT_MAX).map((/** @type {any} */ s) => fg(this._sessColor(s.id), '●')).join('')
        + (mine.length > DOT_MAX ? dim(`+${mine.length - DOT_MAX}`) : '');
      const dotCell = dotCol ? `${' '.repeat(Math.max(0, dotsW - vw(strip(dots))))}${dots} ` : '';
      lines.push(truncate(`${mark} ${nameTxt}  ${dotCell}${body}${pad}  ${sub}`, W));
    }
    const hidden = accts.length - order.length;
    if (hidden > 0) lines.push(dim(`  … 주간 다 쓴 계정 ${hidden}개 숨김 (H 로 보이기)`));
    if (this.mode !== 'normal') return;

    // 세션 + 최근 요청
    lines.push(' ' + dim('─'.repeat(W - 2)));
    const shown = items.slice(0, SESSIONS_PANEL_MAX);
    lines.push(` ${bold('세션')} ${dim('(시작 순)')}`);
    const now = Date.now();
    /** @type {Map<string, any>} */
    const live = new Map();
    for (const [, r] of this.active) if (r.sessionId) {
      const prev = live.get(r.sessionId);
      if (!prev || r.started < prev.started) live.set(r.sessionId, r);
    }
    const labelW = Math.min(22, Math.max(6, ...shown.map((/** @type {any} */ s) => vw(this._sessionLabel(s)))));
    const acctW = Math.min(16, Math.max(6, ...shown.map((/** @type {any} */ s) => vw(this._sessionAccountName(s).replace(KO_DOMAIN_RE, '')))));
    for (const s of shown) {
      const c = this._sessColor(s.id);
      const dot = fg(c, s.active ? '●' : '○');
      const label = rpad(truncate(this._sessionLabel(s), labelW), labelW);
      const acct = rpad(truncate(this._sessionAccountName(s).replace(KO_DOMAIN_RE, ''), acctW), acctW);
      const model = rpad(truncate(modelTag(s.model), 6), 6);
      const r = live.get(s.id);
      let last;
      if (r) last = `${cyan(SPINNER[this.frame])} 진행 중 ${((now - r.started) / 1000).toFixed(1)}s`;
      else {
        const L = this._sessLast.get(s.id);
        last = L ? `${L.ok ? green('✓') : red(`✗ ${L.status}`)} ${L.dur}s · ${koAgo(now - L.at)}` : dim(koAgo(now - s.lastSeen));
      }
      lines.push(truncate(` ${dot} ${s.active ? fg(c, label) : dim(label)}  → ${acct}  ${dim(model)}  ${last}`, W));
    }
    if (items.length > shown.length) lines.push(dim(`   … 세션 ${items.length - shown.length}개 더`));

    // 알림(요청 줄 없이)
    lines.push(' ' + dim('─'.repeat(W - 2)));
    lines.push(` ${bold('알림')}`);
    const space = Math.max(0, bottom - lines.length);
    for (let k = 0; k < space && k < this.log.length; k++) lines.push(`   ${gray(this.log[k].t)}  ${this.log[k].msg}`);
  }

  _renderFooterKo() {
    const k = (/** @type {string} */ key, /** @type {string} */ t) => `${bold(key)} ${t}`;
    // 1줄 쓰기 · 2줄 계정 관리 · 3줄 기타 (각 줄 80칸 안).
    const line1 = [k('S', '계정전환'), k('M', '대화옮기기'), k('F', '집중'), ...(this.warmNow ? [k('W', '5시간켜기')] : []), k('P', '사용량조회'), k('R', '새로고침')];
    const line2 = [...(this.loginAccount ? [k('L', '다시로그인'), k('N', '새계정')] : []), k('D', '끄기/켜기'), k('O', '순서'), k('B', '계정빼기'), k('H', this.config?.hideSpent === true ? '다쓴계정 보이기' : '다쓴계정 숨기기')];
    const line3 = [...(this._cleanupAvailable() ? [k('X', '정리')] : []), k('G', '설정'), k('Q', '종료')];
    return [` ${line1.join('  ')}`, ` ${line2.join('  ')}`, ` ${line3.join('  ')}`];
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal':
        return this.remote
          ? ` ${bold('S')} 계정전환  ${bold('M')} 대화옮기기  ${bold('R')} 새로고침  ${bold('Q')} 종료`
          : ` ${bold('S')} 계정전환  ${bold('M')} 대화옮기기  ${bold('F')} 집중  ${bold('D')} 끄기/켜기  ${this.loginAccount ? `${bold('L')} 로그인  ${bold('N')} 새계정  ` : ''}${bold('P')} 사용량조회  ${this.warmNow ? `${bold('W')} 5시간켜기  ` : ''}${this._cleanupAvailable() ? `${bold('X')} 정리  ` : ''}${bold('H')} ${this.config?.hideSpent === true ? '다쓴계정 보이기' : '다쓴계정 숨기기'}  ${bold('R')} 새로고침  ${bold('G')} 설정  ${bold('Q')} 종료`;
      case 'warm': {
        const picks = this._warmPick || [];
        const names = picks.map(a => String(a.name).replace(KO_DOMAIN_RE, '')).join(', ');
        // 한글 화면은 대상 줄에 * 가 붙으니 이름은 옛 화면에서만 덧붙인다(좁으면 끝부터 잘린다).
        return ` ${yellow(`5시간이 안 도는 계정 ${picks.length}개(*)를 지금 켤까요?`)}  ${bold('Enter')} 켜기  ${bold('Esc')} 취소  ${dim('· 계정마다 짧은 메시지 1개')}${this._koLayout() ? '' : `  ${dim(names)}`}`;
      }
      case 'cleanup':
        return this.cleanup?.stage === 'list'
          ? ` ${bold('y')} 모두 끄기  ${bold('Esc')} 닫기`
          : this.cleanup?.stage === 'kill' ? ' 끄는 중…' : ` ${bold('Esc')} 닫기`;
      case 'focus':
        return ` ${dim('↑↓')} 선택  ${bold('Enter')} 집중 계정으로  ${bold('Esc')} 닫기`;
      case 'move':
        return this.move?.stage === 'account'
          ? ` ${dim('↑↓')} select  ${bold('Enter')} move here  ${bold('Esc')} cancel`
          : ` ${dim('↑↓')} select  ${bold('Enter')} choose  ${bold('Esc')} cancel`;
      case 'settings':
        return ` ${dim('↑↓')} navigate  ${dim('←→')} change  ${bold('Enter')} edit  ${bold('Esc')} back`;
      case 'routes':
        return ` ${dim('↑↓')} select  ${bold('a')}dd  ${bold('e')}dit  ${bold('d')}elete  ${bold('Esc')} back`;
      case 'pick':
        return this.pick?.multi
          ? ` ${dim('↑↓')} move  ${bold('Space')} toggle  ${bold('Enter')} confirm  ${bold('Esc')} cancel`
          : ` ${dim('↑↓')} move  ${bold('Enter')} select  ${bold('Esc')} cancel`;
      case 'blocklist':
        return ` ${dim('↑↓')} select  ${bold('a')}dd  ${bold('d')}elete  ${bold('Esc')} back`;
      case 'select': {
        if (this.selAction === 'switch' && this.remote) {
          return ` ${dim('↑↓')} select  ${bold('Enter')} switch  ${bold('Esc')} cancel`;
        }
        if (this.selAction === 'switch') {
          const target = this.selRoute
            ? routeColorFn(this.selRoute.color)(`route ${this.selRoute.name}`)
            : 'default';
          return ` ${dim('↑↓')} select  ${dim('←→')} target: ${target}  ${bold('Enter')} pin  ${bold('Esc')} cancel`;
        }
        // Both keys leave, because each move is applied as it is made and written
        // on the way out at the latest: there is no pending change for one to
        // commit and the other to throw away, and
        // offering "cancel" would promise an undo this screen does not have.
        if (this.selAction === 'reorder') {
          // [local patch 2026-10-28 원장] 한글 화면: 어느 화살표가 위·아래인지 바로 보이게.
          if (this._koLayout()) return ` ${dim('↑↓')} 고르기  ${bold('←')} 위로  ${bold('→')} 아래로  ${bold('Enter')}/${bold('Esc')} 끝 (옮기는 대로 저장)`;
          return ` ${dim('↑↓')} select  ${dim('←→')} move  ${bold('Enter')}/${bold('Esc')} done`;
        }
        if (this.selAction === 'login') {
          return ` ${dim('↑↓')} select  ${bold('Enter')} sign in via browser  ${bold('Esc')} cancel`;
        }
        if (this.selAction === 'removeKo') {
          const nm = this.am.accounts[this.selIdx]?.name ?? '';
          return this._removeArmed === this.selIdx
            ? ` ${red(`「${nm}」을 정말 뺄까요? 다시 쓰려면 다시 로그인해야 합니다.`)}  ${bold('Enter')} 빼기  ${bold('Esc')} 취소`
            : ` ${dim('↑↓')} 고르기  ${bold('Enter')} 이 계정 빼기  ${bold('Esc')} 취소`;
        }
        const act = this.selAction === 'toggle' ? 'enable/disable'
          : this.selAction === 'routing' ? 'set its proxy' : 'remove';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'add':
        return ` ${bold('i')}mport Claude Code  ${bold('k')} API key  ${bold('Esc')} cancel`;
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputSecret ? '*'.repeat(this.inputBuf.length) : this.inputBuf}█`;
      case 'login': {
        // `c` is only a key while the field is empty (see _keyLogin), so it
        // is only offered then.
        const login = this.login;
        const panelKeys = login?.prompt && !login.buf ? `  ${bold('c')} copy link` : '';
        return ` ${bold('Enter')} submit  ${bold('Esc')} cancel${panelKeys}`;
      }
      default:
        return '';
    }
  }
}
