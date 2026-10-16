// Per-session coloring: a stable color derived from the session id lets you
// tell concurrent sessions apart at a glance. Palette avoids red (error) and
// gray (timestamps); includes bright variants for separation. The values are
// SGR foreground codes. Shared by the TUI and by GET /teamclaude/session, so a
// status line outside the proxy can paint a session in the colour the
// dashboard gives it.
export const SESSION_FG = [36, 35, 34, 33, 94, 95, 96, 93, 92];

/** @param {string} sid @returns {number} the session's SGR foreground code */
export function sessionColorCode(sid) {
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
  return SESSION_FG[h % SESSION_FG.length];
}
