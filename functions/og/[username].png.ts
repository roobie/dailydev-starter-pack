// GET /og/:username.png — OG card route.
//
// All OG rendering goes through `workers-og` (workerd-targeted satori +
// @resvg/resvg-wasm wrapper). `@vercel/og` crashes at worker init with
// `new URL("index_bg.wasm", void 0)` — its bundle assumes `import.meta.url`
// is set, which workerd's bundling makes `void 0`. workers-og does not have
// that pattern and ships in workerd dev.
//
// Single codepath: the runtime route produces both the personalized card and
// the generic default card (cached under `og:v2:_default`). No build-time PNG
// emission, single dep, no Node/workerd dual-runtime surface.
//
// Cache prefix versioning: bump the OG_CACHE_PREFIX suffix (v1, v2, …) to
// invalidate all warmed PNG entries when text-affecting render changes ship.
//
// Flow:
//   1. Validate username (strip .png suffix, regex check).
//   2. KV pre-render cache hit at `og:v2:<u>` → return cached bytes.
//   3. Pack cache hit at `pack-data:v1:<u>` → render personalized card,
//      cache PNG bytes in KV (waitUntil so it doesn't block).
//   4. No pack cache (cold username) → render the generic default card
//      via workers-og, KV-cache under `og:v2:_default`, return. Cold hits
//      for *any* unknown username land on this shared cache entry.
//
// Trust boundaries (§4.5): username regex-validated before any KV read or
// render. All untrusted strings flow into satori as plain text children;
// satori doesn't parse strings as HTML, so there's no XSS surface in the
// rendered PNG.

import { ImageResponse } from "workers-og";
import type { Env } from "../../src/env";
import { isValidUsername } from "../../src/github";

const PACK_CACHE_PREFIX = "pack-data:v1:";
const OG_CACHE_PREFIX = "og:v2:";
const OG_DEFAULT_KEY = "og:v2:_default";
const OG_CACHE_TTL = 86_400;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Brand tokens (mirror public/styles.css).
const BG = "#0e1217";
const BG_ELEV = "#161b22";
const FG = "#e6e9ef";
const FG_MUTED = "#99a3b3";
const ACCENT = "#ff7300";
const BORDER = "#2a313c";

interface PackTally {
  name: string;
  count: number;
}
interface CachedPackRepo {
  name: string;
  language: string | null;
}
interface CachedPack {
  username: string;
  stage: string;
  tags?: PackTally[];
  sources?: PackTally[];
  repos: CachedPackRepo[];
}

const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
};

function primaryLanguage(repos: readonly CachedPackRepo[]): string | null {
  const counts = new Map<string, number>();
  for (const r of repos) {
    if (!r.language) continue;
    counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
  }
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count };
  }
  return best?.name ?? null;
}

// React-element-shape descriptor tree. workers-og accepts the same
// {type, props} shape satori expects directly — avoids the whitespace-as-
// child-node trap of the HTML-string parser, and avoids any JSX runtime.

type El = { type: string; props: Record<string, unknown> };
function el(
  type: string,
  props: Record<string, unknown>,
  ...children: Array<El | string | null | false | Array<El | string>>
): El {
  const flat: Array<El | string> = [];
  for (const c of children) {
    if (c === null || c === false) continue;
    if (Array.isArray(c)) {
      for (const cc of c) flat.push(cc);
    } else {
      flat.push(c);
    }
  }
  return {
    type,
    props: { ...props, children: flat.length === 1 ? flat[0] : flat },
  };
}

function chip(label: string): El {
  return el(
    "div",
    {
      style: {
        background: BG_ELEV,
        border: `1px solid ${BORDER}`,
        borderRadius: 999,
        padding: "10px 22px",
        fontSize: 24,
        color: FG,
      },
    },
    label,
  );
}

function personalCard(username: string, pack: CachedPack): El {
  const topTags = (pack.tags ?? []).slice(0, 5).map((t) => t.name);
  const lang = primaryLanguage(pack.repos);
  // daily.dev sources its profile avatars from GitHub OAuth (empirical from
  // probe of GET /profile/ — `image` field is the user's GitHub avatar URL).
  // github.com/<user>.png 302-redirects to avatars.githubusercontent.com,
  // which satori follows transparently. The resolved PNG gets baked into
  // the cached OG bytes, so warm hits don't refetch the avatar.
  const avatarUrl = `https://github.com/${username}.png?size=240`;

  const brandHeader = el(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 18 } },
    el(
      "div",
      {
        style: {
          width: 48,
          height: 48,
          borderRadius: 12,
          background: ACCENT,
          color: BG,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 32,
          fontWeight: 800,
        },
      },
      "d",
    ),
    el(
      "div",
      { style: { fontSize: 30, color: FG_MUTED, letterSpacing: "-0.01em" } },
      "daily.dev",
    ),
  );

  const userLine = el(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "baseline",
        gap: 14,
        fontSize: 80,
        fontWeight: 800,
        color: FG,
        letterSpacing: "-0.03em",
        lineHeight: 1,
      },
    },
    el("span", { style: { display: "flex", color: ACCENT } }, "@"),
    el("span", { style: { display: "flex" } }, username),
  );

  const langChip = lang
    ? el(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 14 } },
        el(
          "div",
          { style: { fontSize: 26, color: FG_MUTED } },
          "primary language",
        ),
        el(
          "div",
          {
            style: {
              background: ACCENT,
              color: BG,
              borderRadius: 999,
              padding: "10px 22px",
              fontSize: 24,
              fontWeight: 700,
            },
          },
          lang,
        ),
      )
    : null;

  const textBlock = el(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 18, flexGrow: 1 } },
    el(
      "div",
      { style: { fontSize: 30, color: FG_MUTED } },
      "PackGen for",
    ),
    userLine,
    langChip,
  );

  const avatar = el("img", {
    src: avatarUrl,
    width: 180,
    height: 180,
    style: {
      borderRadius: 90,
      border: `4px solid ${ACCENT}`,
      flexShrink: 0,
    },
  });

  // Headline row: avatar on the left, text stack on the right.
  const headlineBlock = el(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 36 } },
    avatar,
    textBlock,
  );

  const chipsBlock = topTags.length
    ? el(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 16 } },
        el(
          "div",
          { style: { fontSize: 22, color: FG_MUTED } },
          "Top tags in pack",
        ),
        el(
          "div",
          { style: { display: "flex", gap: 14, flexWrap: "wrap" } },
          topTags.map(chip),
        ),
      )
    : el(
        "div",
        {
          style: { fontSize: 24, color: FG_MUTED, fontFamily: "monospace" },
        },
        `/pack/${username}`,
      );

  return el(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: BG,
        color: FG,
        padding: "72px 88px",
        fontFamily: "sans-serif",
      },
    },
    brandHeader,
    headlineBlock,
    chipsBlock,
  );
}

function defaultCard(): El {
  // Generic landing/fallback card. Used when no pack data is cached for a
  // username yet, and as the og:image for the landing page. Mirrors the
  // brand tokens and visual layout that build/generate-og.mjs used to emit
  // as public/og/default.png — that build step was removed when @vercel/og
  // was dropped, so this card is now rendered by workers-og at runtime
  // and KV-cached under `og:v2:_default`.
  const wordmark = el(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 18 } },
    el(
      "div",
      {
        style: {
          width: 48,
          height: 48,
          borderRadius: 12,
          background: ACCENT,
          color: BG,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 32,
          fontWeight: 800,
        },
      },
      "d",
    ),
    el(
      "div",
      { style: { fontSize: 30, color: FG_MUTED, letterSpacing: "-0.01em" } },
      "daily.dev",
    ),
  );

  const headline = el(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 24 } },
    el(
      "div",
      {
        style: {
          fontSize: 84,
          fontWeight: 800,
          color: FG,
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
        },
      },
      "PackGen",
    ),
    el(
      "div",
      { style: { fontSize: 36, color: FG_MUTED, lineHeight: 1.3, maxWidth: 920 } },
      "Seed a new daily.dev account from a public GitHub profile in three seconds.",
    ),
  );

  const footerRow = el(
    "div",
    {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
      },
    },
    el(
      "div",
      { style: { display: "flex", gap: 14 } },
      ["tags", "sources", "bookmarks", "feed"].map(chip),
    ),
    el(
      "div",
      { style: { fontSize: 22, color: ACCENT, fontFamily: "monospace" } },
      "/pack/<github-username>",
    ),
  );

  return el(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: BG,
        color: FG,
        padding: "80px 88px",
        fontFamily: "sans-serif",
      },
    },
    wordmark,
    headline,
    footerRow,
  );
}

async function readPack(env: Env, username: string): Promise<CachedPack | null> {
  if (!env.PACK_KV) return null;
  try {
    return await env.PACK_KV.get<CachedPack>(
      PACK_CACHE_PREFIX + username,
      "json",
    );
  } catch {
    return null;
  }
}

async function readOgCache(
  env: Env,
  username: string,
): Promise<ArrayBuffer | null> {
  if (!env.PACK_KV) return null;
  try {
    return await env.PACK_KV.get(OG_CACHE_PREFIX + username, "arrayBuffer");
  } catch {
    return null;
  }
}

async function writeOgCache(
  env: Env,
  username: string,
  bytes: ArrayBuffer,
): Promise<void> {
  if (!env.PACK_KV) return;
  try {
    await env.PACK_KV.put(OG_CACHE_PREFIX + username, bytes, {
      expirationTtl: OG_CACHE_TTL,
    });
  } catch {
    /* cache write failed; next request will re-render — not fatal */
  }
}

export const onRequestGet: PagesFunction<Env, "username"> = async (context) => {
  const raw = context.params.username;
  const name = typeof raw === "string" ? raw.replace(/\.png$/i, "") : "";
  if (!isValidUsername(name)) {
    return new Response("invalid username", { status: 400 });
  }

  const refresh =
    new URL(context.request.url).searchParams.get("refresh") === "1";

  // 1. Pre-rendered cache hit
  if (!refresh) {
    const cached = await readOgCache(context.env, name);
    if (cached) {
      return new Response(cached, { status: 200, headers: CACHE_HEADERS });
    }
  }

  // 2. Need pack data to personalize
  const pack = await readPack(context.env, name);
  if (!pack || pack.stage !== "github-and-dailydev") {
    // Cold username → render (or serve cached) generic default. Cached
    // under a shared `og:v2:_default` key, NOT per-user — once this
    // user's pack lands, the next request will render their personal
    // card and cache it under `og:v2:<u>`.
    if (!refresh && context.env.PACK_KV) {
      try {
        const cachedDefault = await context.env.PACK_KV.get(
          OG_DEFAULT_KEY,
          "arrayBuffer",
        );
        if (cachedDefault) {
          return new Response(cachedDefault, {
            status: 200,
            headers: CACHE_HEADERS,
          });
        }
      } catch {
        /* cache read failed — re-render path follows */
      }
    }
    const defaultResponse = new ImageResponse(defaultCard() as never, {
      width: OG_WIDTH,
      height: OG_HEIGHT,
    });
    const defaultBytes = await defaultResponse.arrayBuffer();
    if (context.env.PACK_KV) {
      context.waitUntil(
        context.env.PACK_KV.put(OG_DEFAULT_KEY, defaultBytes, {
          expirationTtl: OG_CACHE_TTL,
        }).catch(() => {
          /* cache write failed; next cold hit will re-render */
        }),
      );
    }
    return new Response(defaultBytes, { status: 200, headers: CACHE_HEADERS });
  }

  // 3. Render personalized card
  const response = new ImageResponse(personalCard(name, pack) as never, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
  });
  const bytes = await response.arrayBuffer();

  context.waitUntil(writeOgCache(context.env, name, bytes));

  return new Response(bytes, { status: 200, headers: CACHE_HEADERS });
};
