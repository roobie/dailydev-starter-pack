// HTML rendering for the pack page.
//
// Two consumption patterns:
//
// 1. Synchronous, all-at-once: `renderPackHtml(data)` returns a complete
//    document. Used for the github-only path where there's no async wait
//    worth streaming around.
//
// 2. Streaming: the section-level functions can be written into a
//    `TransformStream` as data becomes available. The route writes the
//    shell + header + languages + loading placeholder immediately, then
//    awaits the daily.dev fan-out, then writes the rest. The browser
//    paints each chunk as it arrives — no JS needed; a CSS rule hides the
//    placeholder once the real sections are streamed in.
//
// Trust boundary:
// - Every untrusted text interpolation flows through escapeHtml().
// - Every untrusted URL flows through safeUrl() with a hostname allowlist
//   where applicable.
// - URLs we construct ourselves (daily.dev tag pages, GitHub user URLs)
//   use encodeURIComponent on the slug.

import { escapeHtml, safeUrl } from "./html";

export interface PackArticle {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  tags: string[];
  source: string | null;
  frequency: number;
  matchedKeywords: string[];
}

export interface PackRepo {
  name: string;
  language: string | null;
  stars: number;
  pushed_at: string;
  topics: string[];
}

export interface PackPageData {
  username: string;
  stage: "github-only" | "github-and-dailydev";
  topics: string[];
  repos: PackRepo[];
  articles?: PackArticle[];
  tags?: Array<{ name: string; count: number }>;
  sources?: Array<{ name: string; count: number }>;
}

const DAILYDEV_HOST = "https://app.daily.dev";

// ---------- Shell ----------

// `origin` is the request-derived absolute URL prefix (e.g. https://host)
// used to build canonical og:url and og:image. Required because OGP scrapers
// (Discord, some Slack bots) don't resolve relative URLs against the document.
export function renderShellOpen(
  username: string,
  repoCount: number,
  origin: string,
): string {
  const u = escapeHtml(username);
  const userHref = `https://github.com/${encodeURIComponent(username)}`;
  const slug = encodeURIComponent(username);
  const pageUrl = `${origin}/pack/${slug}`;
  const ogImage = `${origin}/og/${slug}.png`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack for @${u} — PackGen for daily.dev</title>
<meta name="description" content="A daily.dev starter pack seeded from @${u}'s public GitHub profile.">
<link rel="canonical" href="${pageUrl}">
<link rel="stylesheet" href="/styles.css">
<meta property="og:title" content="@${u}'s daily.dev starter pack">
<meta property="og:description" content="Languages, top tags, sources, and articles seeded from a public GitHub profile.">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ogImage}">
</head>
<body>
<main class="pack" data-pack-root data-username="${u}">
<header>
<h1>Pack for <a href="${userHref}" rel="noopener">@${u}</a></h1>
<p class="tagline">Seeded from ${repoCount} public repo${repoCount === 1 ? "" : "s"} on GitHub.</p>
</header>
`;
}

// Shell for the client-rendered path. The server-side route returns this
// instantly (no daily.dev await); /scripts/pack.js fetches the full pack
// from /pack/<u>?format=json and inserts sections under [data-pack-content].
//
// The user-visible bit between header and footer is a <div data-pack-content>
// containing the loading placeholder. Once JS runs, it clears the placeholder
// and renders the daily.dev sections; the rest of the document
// (header, languages, footer) is identical to the all-at-once path.
//
// Falls back to a <noscript> message — without JS, no daily.dev content
// appears. For tooling that wants the data, hit /pack/<u>?format=json
// directly (server-side, no JS needed).
export function renderClientRenderedPack(
  username: string,
  repoCount: number,
  languages: readonly string[],
  origin: string,
): string {
  return (
    renderShellOpen(username, repoCount, origin) +
    renderLanguagesSection(languages) +
    `<div data-pack-content>${renderLoadingPlaceholder()}</div>
<noscript>
<p class="degraded">This page needs JavaScript to load the daily.dev sections. For the raw JSON instead, request <code>/pack/${escapeHtml(username)}?format=json</code>.</p>
</noscript>
<script src="/scripts/pack.js" defer></script>
` +
    renderShellClose()
  );
}

export function renderShellClose(): string {
  return `<footer>
<p><a href="/">← back to home</a> · A daily.dev Hackathon 2026 entry.</p>
</footer>
</main>
</body>
</html>`;
}

// ---------- Sections ----------

export function uniqueLanguages(repos: readonly PackRepo[]): string[] {
  const set = new Set<string>();
  for (const r of repos) {
    if (r.language) set.add(r.language);
  }
  return [...set].sort();
}

export function renderLanguagesSection(langs: readonly string[]): string {
  if (langs.length === 0) return "";
  return `<section class="languages">
<h2>Languages</h2>
<ul class="chips">${langs.map((l) => `<li class="chip">${escapeHtml(l)}</li>`).join("")}</ul>
</section>
`;
}

// Loading placeholder for the streaming path. The class name is matched by
// `renderHideLoadingStyle()` which streams a `<style>` rule once daily.dev
// data is ready — the placeholder retroactively hides via CSS, no JS needed.
export function renderLoadingPlaceholder(): string {
  return `<div class="loading-pack" role="status" aria-live="polite">
<span class="loading-pack-spinner" aria-hidden="true"></span>
<span>Loading tags, sources, and articles from daily.dev…</span>
</div>
`;
}

export function renderHideLoadingStyle(): string {
  // Allowed because CSP has `style-src 'self' 'unsafe-inline'`.
  return `<style>.loading-pack{display:none}</style>
`;
}

export function renderTagsSection(
  tags: ReadonlyArray<{ name: string; count: number }>,
): string {
  if (tags.length === 0) return "";
  return `<section class="tags">
<h2>Top tags</h2>
<ul class="chips">${tags
    .map((t) => {
      const href = `${DAILYDEV_HOST}/tags/${encodeURIComponent(t.name)}`;
      return `<li class="chip"><a href="${href}" rel="noopener">${escapeHtml(t.name)}</a> <span class="count">×${t.count}</span></li>`;
    })
    .join("")}</ul>
</section>
`;
}

export function renderSourcesSection(
  sources: ReadonlyArray<{ name: string; count: number }>,
): string {
  if (sources.length === 0) return "";
  return `<section class="sources">
<h2>Top sources</h2>
<ul class="chips">${sources
    .map((s) => {
      const href = `${DAILYDEV_HOST}/sources/${encodeURIComponent(s.name)}`;
      return `<li class="chip"><a href="${href}" rel="noopener">${escapeHtml(s.name)}</a> <span class="count">×${s.count}</span></li>`;
    })
    .join("")}</ul>
</section>
`;
}

export function renderArticlesSection(articles: readonly PackArticle[]): string {
  if (articles.length === 0) return "";
  return `<section class="articles">
<h2>Sample articles</h2>
<ol class="article-list">${articles.map(renderArticleItem).join("")}</ol>
</section>
`;
}

function renderArticleItem(a: PackArticle): string {
  // safeUrl rejects non-https and returns "". We render an inert "#" link in
  // that case so the markup stays well-formed without leaking the bad URL.
  const href = safeUrl(a.url) || "#";
  const sourceChip =
    a.source !== null
      ? ` <span class="source">via <a href="${DAILYDEV_HOST}/sources/${encodeURIComponent(a.source)}" rel="noopener">${escapeHtml(a.source)}</a></span>`
      : "";
  const summary = a.summary
    ? `<p class="summary">${escapeHtml(a.summary)}</p>`
    : "";
  return `<li class="article">
<h3><a href="${href}" rel="noopener">${escapeHtml(a.title)}</a></h3>
${summary}
<p class="meta"><span class="freq">${a.frequency} match${a.frequency === 1 ? "" : "es"}</span>${sourceChip}</p>
</li>`;
}

export function renderDegradedSection(): string {
  return `<section class="degraded">
<h2>Preview only — GitHub stage</h2>
<p>This server isn't configured with a daily.dev operator token, so we can only show the GitHub-side derivation. The full pack would also include top tags, sources, and sample articles fetched from <code>/recommend/semantic</code>.</p>
</section>
`;
}

export function renderApplyForm(username: string, dailydev: boolean): string {
  if (!dailydev) return "";
  const action = `/pack/${encodeURIComponent(username)}/apply`;
  return `<section class="apply">
<h2>Apply this pack</h2>
<p>Paste your daily.dev Plus PAT to seed your account with these tags, sources, and bookmarks.</p>
<form action="${action}" method="post" autocomplete="off" spellcheck="false">
<label for="pat">daily.dev Plus PAT</label>
<input type="password" id="pat" name="pat" required autocomplete="off">
<button type="submit">Apply pack</button>
</form>
<p class="note">Used once for the writes, then discarded. Never stored server-side.</p>
</section>
`;
}

// ---------- All-at-once composition (non-streaming path) ----------

export function renderPackHtml(data: PackPageData, origin: string): string {
  const languages = uniqueLanguages(data.repos);
  const dailydev = data.stage === "github-and-dailydev";
  const middle = dailydev
    ? renderTagsSection(data.tags ?? []) +
      renderSourcesSection(data.sources ?? []) +
      renderArticlesSection(data.articles ?? [])
    : renderDegradedSection();
  return (
    renderShellOpen(data.username, data.repos.length, origin) +
    renderLanguagesSection(languages) +
    middle +
    renderApplyForm(data.username, dailydev) +
    renderShellClose()
  );
}
