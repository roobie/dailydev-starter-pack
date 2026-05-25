// Pages-level middleware. Adds security headers to every response.
//
// PAT discipline: no request / header / body content is logged from this
// middleware. The visitor PAT only exists in the body of POST requests to
// /pack/<u>/apply, and it must never appear in a log line.
//
// CSP: starts permissive on img-src (https: data:) so daily.dev's article and
// source images render. Tighten to an explicit allowlist once the actual host
// set is known after the first end-to-end render.

import type { Env } from "../src/env";

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join("; ");

export const onRequest: PagesFunction<Env> = async (context) => {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
