// POST /pack/:username/apply — seed a visitor's daily.dev account from a
// derived pack. Partial-failure semantics: the first three steps (follow
// tags, follow sources, bookmark posts) are required for ok:true; the
// custom-feed step degrades gracefully — its failure is recorded but does
// not flip the aggregate verdict.
//
// The pack data (tags / sources / postIds / languages) arrives as a hidden
// `pack` form field populated by /scripts/pack.js after the client-side
// render. Embedding the payload in the form avoids a server-side recompute
// or a pack-level KV read on this hot path; tamper risk is benign because
// the visitor's PAT only mutates the visitor's own daily.dev account.
//
// PAT discipline: `pat` form field → `Pat.from(...)` (throws on shape
// mismatch). Never logged. Dereferenced exactly once inside src/dailydev.ts
// when building the Authorization header.

import type { Env } from "../../../src/env";
import { isValidUsername } from "../../../src/github";
import { Pat } from "../../../src/pat";
import {
  followTags,
  followSources,
  bookmarkPosts,
  createCustomFeed,
  // addStackEntry — intentionally not imported. /profile/stack/ POST is
  // broken upstream (see the skip block below + src/dailydev.ts export).
  type StepResult,
  type ApplyResponse,
} from "../../../src/dailydev";
import { escapeHtml } from "../../../src/html";
import { log } from "../../../src/logger";

interface PackPayload {
  tags: string[];        // top 10 tag names
  sources: string[];     // top 5 source handles
  postIds: string[];     // top 15 post ids for bookmarks
  languages: string[];   // up to 5 primary-stack tools
}

const MAX_TAGS = 10;
const MAX_SOURCES = 5;
// daily.dev enforces a 10/mutation hard cap on POST /bookmarks/. Larger
// batches return 400 "Exceeded the maximum bookmarks per mutation (10)".
const MAX_POST_IDS = 10;
const MAX_LANGUAGES = 5;

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Parse the `pack` form field. Strings only, all arrays capped. Anything
// off-shape returns null and the endpoint replies 400.
function parsePayload(raw: unknown): PackPayload | null {
  if (typeof raw !== "string") return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (typeof j !== "object" || j === null) return null;
  const obj = j as Record<string, unknown>;
  const onlyStrings = (v: unknown, cap: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, cap) : [];
  return {
    tags: onlyStrings(obj.tags, MAX_TAGS),
    sources: onlyStrings(obj.sources, MAX_SOURCES),
    postIds: onlyStrings(obj.postIds, MAX_POST_IDS),
    languages: onlyStrings(obj.languages, MAX_LANGUAGES),
  };
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  // application/json without text/html → tooling. A browser form post sends
  // text/html in Accept; we render HTML for it.
  return accept.includes("application/json") && !accept.includes("text/html");
}

export const onRequestPost: PagesFunction<Env, "username"> = async (context) => {
  const { username } = context.params;
  if (typeof username !== "string" || !isValidUsername(username)) {
    return badRequest("invalid username");
  }

  const ct = context.request.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded") && !ct.includes("multipart/form-data")) {
    return badRequest("expected application/x-www-form-urlencoded");
  }

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return badRequest("malformed form body");
  }

  let pat: Pat;
  try {
    pat = Pat.from(form.get("pat"));
  } catch {
    return badRequest("invalid PAT shape");
  }

  const payload = parsePayload(form.get("pack"));
  if (!payload) return badRequest("malformed pack payload");

  // Write sequence:
  //   1-3 required for ok:true (tags, sources, bookmarks)
  //   4   graceful degradation (custom feed)
  const results: StepResult[] = [];

  results.push(await followTags(pat, payload.tags));
  results.push(await followSources(pat, payload.sources));
  results.push(await bookmarkPosts(pat, payload.postIds));

  const requiredOk = results.every((r) => r.ok);

  // daily.dev rejects special characters (including `@`) in feed names with
  // 400 "Feed name should not contain special characters". Plain ASCII
  // letters / digits / spaces only.
  const feedName = `Starter pack from ${username}`;
  results.push(await createCustomFeed(pat, feedName, {
    tags: payload.tags,
    sources: payload.sources,
  }));

  // Profile-stack writes are intentionally skipped. POST /public/v1/profile/stack/
  // returned 500 Internal Server Error for every payload shape probed
  // (with/without startDate, mixed case, with and without trailing slash),
  // even though GET /profile/stack/ works. The public API v1 stack-write
  // surface appears to be non-functional; app.daily.dev itself uses GraphQL
  // for this. Re-enable by reinstating the for-loop over payload.languages
  // once a re-probe shows a 2xx response. Until then, surfacing 5×500 in
  // the apply result is pure noise.
  void payload.languages;

  const response: ApplyResponse = { ok: requiredOk, results };
  if (requiredOk) {
    response.redirect = `/pack/${encodeURIComponent(username)}?applied=1`;
  }

  // Safe summary log — counts and aggregate verdict only. No PAT, no body,
  // no per-step error text (which could include daily.dev response noise).
  log("apply.complete", {
    username,
    ok: response.ok,
    stepCount: results.length,
    failedCount: results.filter((r) => !r.ok).length,
  });

  if (wantsJson(context.request)) {
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(renderResultHtml(username, response), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

function renderResultHtml(username: string, r: ApplyResponse): string {
  const safeUser = escapeHtml(username);
  const rows = r.results
    .map((step) => {
      const safeStep = escapeHtml(step.step);
      if (step.ok) return `<li class="ok"><span class="mark">✓</span> ${safeStep}</li>`;
      const reason = escapeHtml(step.error.slice(0, 120));
      return `<li class="fail"><span class="mark">✗</span> ${safeStep} <span class="reason">(${step.status}: ${reason})</span></li>`;
    })
    .join("\n");

  const headline = r.ok
    ? `Pack applied to @${safeUser}'s daily.dev`
    : `Pack partially applied to @${safeUser}'s daily.dev`;

  const subhead = r.ok
    ? `<p>Required steps succeeded. Open <a href="https://app.daily.dev/" rel="noopener">daily.dev</a> to see the seeded feed.</p>`
    : `<p>Required steps failed. The PAT may lack write scope, or daily.dev returned an error. Submit the form again to retry.</p>`;

  const backHref = `/pack/${encodeURIComponent(username)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Apply result for @${safeUser}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="pack apply-result">
<header class="pack-header">
<h1>${headline}</h1>
</header>
${subhead}
<ul class="step-list">
${rows}
</ul>
<p class="back-link"><a href="${backHref}">Back to pack</a></p>
</main>
</body>
</html>`;
}
