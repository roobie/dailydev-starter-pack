// daily.dev Public API client.
//
// Read path: GET /recommend/semantic?q=<single-keyword>&limit=N
// /recommend/semantic is empirically keyword-AND, not natural language:
// single keyword per call. Long sentences silently return empty. Zero-result
// keywords are dropped during aggregation (graceful degradation).
//
// Write path: endpoints are sequenced from least-state-mutating (tags follow)
// to most-identity-shaping. The first three writes are required for the
// aggregate ok:true verdict; later steps degrade gracefully.
//
// Auth: operator DAILY_DEV_API_TOKEN for reads (env string). Visitor PAT
// for writes via the branded `Pat` class — `.unsafeValue()` is the only
// legitimate dereference and lives at one fetch call site.

import { Pat } from "./pat";

const BASE = "https://api.daily.dev/public/v1";

// Keyword cache (KV-backed). Key prefix is versioned so we can invalidate
// the entire cache via prefix bump without enumerating keys.
const CACHE_KEY_PREFIX = "recommend:v1:";
const CACHE_TTL_POSITIVE = 86_400; // 24h — articles drift slowly enough
const CACHE_TTL_NEGATIVE = 3_600;  //  1h — re-probe empty results sooner

export interface FeedPostSource {
  id: string;
  name: string;
  handle: string;
  image: string | null;
}

export interface FeedPost {
  id: string;
  title: string;
  url: string;
  image: string | null;
  summary: string | null;
  type: string;
  publishedAt: string | null;
  createdAt: string;
  commentsPermalink: string;
  source: FeedPostSource;
  tags: string[];
  readTime: number | null;
  numUpvotes: number;
  numComments: number;
  author: { name: string; image: string } | null;
}

export interface RecommendResult {
  posts: FeedPost[];
  source: "cache" | "api";
}

export async function recommendSemantic(
  keyword: string,
  token: string,
  limit = 10,
  cache?: KVNamespace,
): Promise<RecommendResult> {
  const cacheKey = `${CACHE_KEY_PREFIX}${keyword}`;

  // Cache-first. Treat KV errors / shape mismatches as a miss and fall
  // through to the API — the cache is an optimization, not source of truth.
  if (cache) {
    try {
      const hit = await cache.get<{ posts: FeedPost[] }>(cacheKey, "json");
      if (hit && Array.isArray(hit.posts)) {
        return { posts: hit.posts, source: "cache" };
      }
    } catch {
      /* fall through to API */
    }
  }

  const url = `${BASE}/recommend/semantic?q=${encodeURIComponent(keyword)}&limit=${limit}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error("daily.dev: 401 (operator PAT invalid)");
    if (r.status === 429) throw new Error("daily.dev: 429 (rate limited)");
    throw new Error(`daily.dev: ${r.status} for keyword "${keyword}"`);
  }
  const body = (await r.json()) as { data?: FeedPost[] };
  const posts = body.data ?? [];

  // Cache the result. Negative caching uses a shorter TTL — an empty
  // result today may have content tomorrow. Awaited (not fire-and-forget)
  // so the worker doesn't terminate the put before it completes; cost is
  // ~10-20ms per write, negligible against ~15s API latency.
  if (cache) {
    const ttl = posts.length > 0 ? CACHE_TTL_POSITIVE : CACHE_TTL_NEGATIVE;
    try {
      await cache.put(cacheKey, JSON.stringify({ posts }), {
        expirationTtl: ttl,
      });
    } catch {
      /* cache write failed; next request will re-fetch — not fatal */
    }
  }

  return { posts, source: "api" };
}

export interface BatchResult {
  byKeyword: Map<string, FeedPost[]>;
  cacheHits: number;
  apiCalls: number;
  errors: number;
}

// Fan out semantic queries with bounded concurrency. Keywords that return 0
// posts are silently dropped. Per-keyword errors are also swallowed — one
// bad keyword should not collapse the whole pack render.
//
// When `cache` is supplied, each lookup checks `recommend:v1:<keyword>`
// in KV first; a hit avoids the daily.dev call entirely. Cache hits and
// API calls are counted so the caller can log hit-rate per pack render.
export async function recommendBatch(
  keywords: readonly string[],
  token: string,
  opts: { limit?: number; concurrency?: number; cache?: KVNamespace } = {},
): Promise<BatchResult> {
  const { limit = 10, concurrency = 5, cache } = opts;
  const byKeyword = new Map<string, FeedPost[]>();
  let cacheHits = 0;
  let apiCalls = 0;
  let errors = 0;
  let i = 0;

  async function worker(): Promise<void> {
    while (i < keywords.length) {
      const idx = i++;
      const kw = keywords[idx]!;
      try {
        const { posts, source } = await recommendSemantic(kw, token, limit, cache);
        if (source === "cache") cacheHits++;
        else apiCalls++;
        if (posts.length > 0) byKeyword.set(kw, posts);
      } catch {
        errors++;
      }
    }
  }

  const workers = Math.min(Math.max(1, concurrency), Math.max(1, keywords.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { byKeyword, cacheHits, apiCalls, errors };
}

export interface RankedPost extends FeedPost {
  // Number of keywords that surfaced this post in /recommend/semantic.
  frequency: number;
  // Keywords that surfaced this post (in encounter order).
  matchedKeywords: string[];
}

// Dedupe across the per-keyword maps, score by frequency, keep top N
// (default 18 — empirically a good shape: enough variety to surface a real
// stack, few enough to render without scroll fatigue). Tiebreak by
// numUpvotes so popular posts float up when two articles have the same
// frequency.
//
// Accepts either a raw Map (legacy) or a BatchResult (current). The
// overload keeps existing callers working while letting the route layer
// pass through the full BatchResult for richer logging.
export function aggregate(
  byKeyword: ReadonlyMap<string, FeedPost[]>,
  topN?: number,
): RankedPost[];
export function aggregate(
  batch: BatchResult,
  topN?: number,
): RankedPost[];
export function aggregate(
  arg: ReadonlyMap<string, FeedPost[]> | BatchResult,
  topN = 18,
): RankedPost[] {
  const byKeyword =
    arg instanceof Map ? arg : (arg as BatchResult).byKeyword;
  const merged = new Map<string, RankedPost>();
  for (const [kw, posts] of byKeyword) {
    for (const post of posts) {
      const existing = merged.get(post.id);
      if (existing) {
        existing.frequency += 1;
        existing.matchedKeywords.push(kw);
      } else {
        merged.set(post.id, {
          ...post,
          frequency: 1,
          matchedKeywords: [kw],
        });
      }
    }
  }
  return [...merged.values()]
    .sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return b.numUpvotes - a.numUpvotes;
    })
    .slice(0, topN);
}

export interface Tally {
  name: string;
  count: number;
}

// Top-N tags by appearance count across the ranked article set. Cap of 10
// matches the apply payload limit (see MAX_TAGS in apply.ts).
export function tallyTags(posts: readonly RankedPost[], topN = 10): Tally[] {
  return countBy(posts.flatMap((p) => p.tags), topN);
}

// Top-N source handles by appearance count. Use `source.handle` (not name)
// because the daily.dev /feeds/filters/sources/follow write API expects
// handles. Cap of 5 matches MAX_SOURCES in apply.ts.
export function tallySources(posts: readonly RankedPost[], topN = 5): Tally[] {
  const handles = posts
    .map((p) => p.source?.handle)
    .filter((h): h is string => !!h);
  return countBy(handles, topN);
}

function countBy(items: readonly string[], topN: number): Tally[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

// ────────────────────────── WRITE PATH ────────────────────────────────────
//
// Sequence: tags → sources → bookmarks (required for ok:true) → custom feed
// (graceful degradation). All writes share one private fetch helper so the
// `.unsafeValue()` PAT dereference happens at exactly one grep-distinctive
// call site.

export type StepResult =
  | { step: string; ok: true }
  | { step: string; ok: false; status: number; error: string };

export interface ApplyResponse {
  ok: boolean;
  results: StepResult[];
  redirect?: string;
}

async function writeJson(
  endpoint: string,
  pat: Pat,
  body: unknown,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat.unsafeValue()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
  if (r.ok) return { ok: true };
  // Truncate upstream error text so it can't bloat the response or carry a
  // surprise reflection of headers. The PAT is never echoed by daily.dev,
  // but capping keeps the surface small.
  let text = "";
  try { text = (await r.text()).slice(0, 200); } catch { /* swallow */ }
  return { ok: false, status: r.status, error: text || `HTTP ${r.status}` };
}

export async function followTags(pat: Pat, tags: readonly string[]): Promise<StepResult> {
  if (tags.length === 0) return { step: "tags", ok: true };
  const r = await writeJson("/feeds/filters/tags/follow", pat, { tags: [...tags] });
  return r.ok ? { step: "tags", ok: true } : { step: "tags", ok: false, status: r.status, error: r.error };
}

export async function followSources(pat: Pat, sources: readonly string[]): Promise<StepResult> {
  if (sources.length === 0) return { step: "sources", ok: true };
  const r = await writeJson("/feeds/filters/sources/follow", pat, { sources: [...sources] });
  return r.ok ? { step: "sources", ok: true } : { step: "sources", ok: false, status: r.status, error: r.error };
}

export async function bookmarkPosts(pat: Pat, postIds: readonly string[]): Promise<StepResult> {
  if (postIds.length === 0) return { step: "bookmarks", ok: true };
  const r = await writeJson("/bookmarks/", pat, { postIds: [...postIds] });
  return r.ok ? { step: "bookmarks", ok: true } : { step: "bookmarks", ok: false, status: r.status, error: r.error };
}

export async function createCustomFeed(
  pat: Pat,
  name: string,
  filters: { tags?: readonly string[]; sources?: readonly string[] },
): Promise<StepResult> {
  // The exact `filters` shape for /feeds/custom/ is not nailed down — the
  // endpoint is Plus-gated and not in the public OpenAPI. Sending the
  // obvious shape; a 4xx surfaces in the result and degrades gracefully
  // (the apply verdict is determined by the prior three required writes).
  const body = {
    name,
    filters: {
      tags: filters.tags ? [...filters.tags] : [],
      sources: filters.sources ? [...filters.sources] : [],
    },
  };
  const r = await writeJson("/feeds/custom/", pat, body);
  return r.ok ? { step: "custom-feed", ok: true } : { step: "custom-feed", ok: false, status: r.status, error: r.error };
}

export async function addStackEntry(
  pat: Pat,
  name: string,
  section: "primary" | "hobby" | "learning" | "past" = "primary",
): Promise<StepResult> {
  const r = await writeJson("/profile/stack/", pat, { name, section });
  const step = `stack:${name}`;
  return r.ok ? { step, ok: true } : { step, ok: false, status: r.status, error: r.error };
}
