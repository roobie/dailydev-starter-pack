// GET /pack/:username — pack page route handler.
//
// Streams HTML progressively when the daily.dev path is taken so the visitor
// sees the header + languages immediately while the /recommend/semantic
// fan-out runs in the background. JSON output (?format=json or Accept:
// application/json without text/html) is always synchronous — tooling wants
// the whole object, not a stream.
//
// Trust boundary:
// - Path param `username` is validated before any fetch.
// - All untrusted strings flow through escapeHtml / safeUrl inside
//   src/render.ts. Direct interpolation in this file is limited to the
//   already-validated username for redirects.
//
// Graceful degradation: if DAILY_DEV_API_TOKEN is unset (typical local
// dev without .dev.vars), the pack renders synchronously with the
// github-only stage — daily.dev sections become a "preview only" notice.

import type { Env } from "../../src/env";
import {
  fetchRepos,
  filterRepos,
  rankRepos,
  unionTopics,
  isValidUsername,
  type Repo,
} from "../../src/github";
import {
  recommendBatch,
  aggregate,
  tallyTags,
  tallySources,
} from "../../src/dailydev";
import {
  renderPackHtml,
  renderClientRenderedPack,
  uniqueLanguages,
  type PackPageData,
} from "../../src/render";
import { log } from "../../src/logger";

// Pack-data cache. Keyed by username, 24h TTL.
// Composes with the keyword cache in src/dailydev.ts: a warm pack cache
// short-circuits the whole pipeline; a cold pack cache still benefits
// from per-keyword cache hits during recompute.
const PACK_CACHE_PREFIX = "pack-data:v1:";
const PACK_CACHE_TTL = 86_400;

async function readPackCache(
  env: Env,
  username: string,
): Promise<PackPageData | null> {
  if (!env.PACK_KV) return null;
  try {
    return await env.PACK_KV.get<PackPageData>(
      PACK_CACHE_PREFIX + username,
      "json",
    );
  } catch {
    return null;
  }
}

async function writePackCache(
  env: Env,
  username: string,
  data: PackPageData,
): Promise<void> {
  if (!env.PACK_KV) return;
  try {
    await env.PACK_KV.put(
      PACK_CACHE_PREFIX + username,
      JSON.stringify(data),
      { expirationTtl: PACK_CACHE_TTL },
    );
  } catch {
    /* cache write failed; next request will re-derive — not fatal */
  }
}

export const onRequestGet: PagesFunction<Env, "username"> = async (
  context,
) => {
  const { username } = context.params;
  if (!isValidUsername(username)) {
    return error400("invalid username");
  }

  const wantJson = wantsJson(context.request);
  const reqUrl = new URL(context.request.url);
  const refresh = reqUrl.searchParams.get("refresh") === "1";
  // Absolute origin for canonical og:url / og:image. Dynamic so preview
  // deploys and any future custom domain both produce correct unfurls.
  const origin = reqUrl.origin;
  const hasToken = !!context.env.DAILY_DEV_API_TOKEN;

  // ── Cache-first dispatch (only meaningful when token is configured) ──
  // Skips GitHub fetch + daily.dev fan-out entirely. JSON path returns the
  // cached object as-is; HTML shell path reads cached.repos to compute
  // language chips and repo count without touching GitHub.
  if (hasToken && !refresh) {
    const cached = await readPackCache(context.env, username);
    if (cached) {
      log("pack.cache_hit", { username, format: wantJson ? "json" : "html" });
      if (wantJson) {
        return json({ ok: true, ...cached, cache: "hit" });
      }
      return html(
        renderClientRenderedPack(
          username,
          cached.repos.length,
          uniqueLanguages(cached.repos),
          origin,
        ),
      );
    }
  }

  // ── Cache miss (or no token): full pipeline ───────────────────────
  // Stage 1 — GitHub derivation. Cheap, single fetch, ~200ms.
  const repos = await fetchRepos(username, {
    operatorPat: context.env.GH_OPERATOR_PAT,
  });
  const filtered = filterRepos(repos);
  const ranked = rankRepos(filtered).slice(0, 10);
  const topics = unionTopics(ranked);
  const baseRepos = summarizeRepos(ranked);

  // ── JSON path: synchronous, all-or-nothing ────────────────────────
  if (wantJson) {
    if (!hasToken) {
      // github-only is the degraded path; don't cache it (a future request
      // arriving after the token is configured would otherwise see stale
      // partial data until TTL).
      return json({ ok: true, ...githubOnly(username, topics, baseRepos) });
    }
    log("pack.cache_miss", { username, refresh });
    const data = await buildFullPack(
      username,
      topics,
      baseRepos,
      context.env.DAILY_DEV_API_TOKEN as string,
      context.env.PACK_KV,
    );
    await writePackCache(context.env, username, data);
    return json({ ok: true, ...data });
  }

  // ── HTML, github-only path: synchronous (no daily.dev to await) ───
  if (!hasToken) {
    log("pack.dailydev_skipped", { username, reason: "no_operator_pat" });
    return html(renderPackHtml(githubOnly(username, topics, baseRepos), origin));
  }

  // ── HTML, client-rendered daily.dev path ──────────────────────────
  // Server returns a small shell instantly: header + languages chips +
  // a loading placeholder. /scripts/pack.js then fetches
  // /pack/<u>?format=json and renders the daily.dev sections via DOM API.
  //
  // Browser fires `load` within ~100ms regardless of daily.dev latency —
  // the tab spinner stops, status indicators clear. The slow XHR happens
  // in JS-land where it's tracked separately by the browser. The XHR
  // benefits from the pack-data cache; the shell pays the GitHub fetch
  // on cold misses only.
  return html(
    renderClientRenderedPack(
      username,
      ranked.length,
      uniqueLanguages(baseRepos),
      origin,
    ),
  );
};

async function buildFullPack(
  username: string,
  topics: readonly string[],
  baseRepos: ReturnType<typeof summarizeRepos>,
  token: string,
  cache?: KVNamespace,
): Promise<PackPageData> {
  const batch = await recommendBatch(topics, token, {
    limit: 10,
    concurrency: 6,
    cache,
  });
  const articles = aggregate(batch, 18);
  const tagTally = tallyTags(articles, 10);
  const sourceTally = tallySources(articles, 5);
  log("pack.full_derive", {
    username,
    topic_count: topics.length,
    keyword_hits: batch.byKeyword.size,
    cache_hits: batch.cacheHits,
    api_calls: batch.apiCalls,
    keyword_errors: batch.errors,
    article_count: articles.length,
    tag_count: tagTally.length,
    source_count: sourceTally.length,
  });
  return {
    username,
    stage: "github-and-dailydev",
    topics: [...topics],
    repos: [...baseRepos],
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      summary: a.summary,
      tags: a.tags,
      source: a.source?.handle ?? null,
      frequency: a.frequency,
      matchedKeywords: a.matchedKeywords,
    })),
    tags: tagTally,
    sources: sourceTally,
  };
}

function githubOnly(
  username: string,
  topics: readonly string[],
  repos: ReturnType<typeof summarizeRepos>,
): PackPageData {
  return {
    username,
    stage: "github-only",
    topics: [...topics],
    repos: [...repos],
  };
}

function summarizeRepos(ranked: readonly Repo[]) {
  return ranked.map((r) => ({
    name: r.name,
    language: r.language,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    topics: r.topics,
  }));
}

function wantsJson(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("format") === "json") return true;
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function error400(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
