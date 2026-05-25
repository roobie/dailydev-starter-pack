// Readiness probe. Returns 200 iff DAILY_DEV_API_TOKEN is bound and
// non-empty; otherwise 503. Doesn't call api.daily.dev (no per-probe
// cost, no rate-limit pressure) — only checks that the operator PAT
// binding is wired through. A 200 here does NOT prove the token is
// valid against the upstream API; the first /pack/<u> request does.
//
// PAT discipline: only presence vs absence is exposed; the probe deliberately
// does not echo any portion of the token, and the token is never read into a
// string concatenation site.

import type { Env } from "../../src/env";

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const token = context.env.DAILY_DEV_API_TOKEN;
  if (!token) {
    return new Response("DAILY_DEV_API_TOKEN not configured\n", {
      status: 503,
      headers: TEXT_HEADERS,
    });
  }
  return new Response("ok\n", { headers: TEXT_HEADERS });
};
