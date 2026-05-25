// HTML output helpers.
//
// Trust boundaries and output escaping:
// - Every untrusted text interpolation goes through escapeHtml().
// - Every untrusted URL goes through safeUrl().
// - There are no other "safe by default" template helpers — these two are it.
// - CSP from functions/_middleware.ts is defense-in-depth, not a substitute.

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

// Returns a safe https:// URL string or "" if rejected. Empty string is the
// signal callers must check before interpolating into href/src attributes.
export function safeUrl(s: string, allowedHosts?: readonly string[]): string {
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    if (allowedHosts && !allowedHosts.includes(u.hostname)) return "";
    return u.toString();
  } catch {
    return "";
  }
}
