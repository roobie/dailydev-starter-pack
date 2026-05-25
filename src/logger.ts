// Safe logger. The only sanctioned log surface in functions/ and src/.
//
// PAT discipline:
// - Rejects keys matching /^(pat|token|authorization|cookie|secret)$/i
// - Rejects string values that look like a PAT (long base64-url-ish strings)
// - All other code MUST NOT call console.log directly (biome enforces via
//   suspicious.noConsole; this file's lone console.log is opt-out marked)

const SENSITIVE_KEY = /^(pat|token|authorization|cookie|secret)$/i;
const PAT_LIKE = /^[A-Za-z0-9_-]{20,}$/;

function redactValue(v: unknown): unknown {
  if (typeof v === "string" && PAT_LIKE.test(v)) {
    return "[REDACTED:value-shape]";
  }
  if (Array.isArray(v)) {
    return v.map(redactValue);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED:key]" : redactValue(val);
    }
    return out;
  }
  return v;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  const safe = redactValue(fields) as Record<string, unknown>;
  const entry = { ts: new Date().toISOString(), event, ...safe };
  // biome-ignore lint/suspicious/noConsole: sanctioned log surface
  console.log(JSON.stringify(entry));
}
