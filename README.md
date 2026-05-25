# PackGen — daily.dev seed-the-account tool

A Cloudflare Pages app that takes a GitHub username, pulls public repo
metadata, derives the developer's topic stack, queries daily.dev's
`/recommend/semantic` endpoint, and (when a Plus subscriber pastes
their PAT) writes back to their daily.dev account: follows tags,
follows sources, bookmarks starter articles, creates a custom feed.
The output is a shareable "pack" URL.

Submitted to the **daily.dev Hackathon 2026** (Track 1: Developer
Identity).

## Status

🟢 **Live:** https://dailydev-starter-pack.pages.dev

Featured demo: https://dailydev-starter-pack.pages.dev/pack/roobie

## What's interesting

The whole pipeline is deterministic:
GitHub repo topics and language metadata, fed into
`/recommend/semantic` one keyword at a time, ranked by tag-frequency
intersection. No Anthropic, no OpenAI, no local model. The cost
structure is the API call you'd make anyway, not an unbounded
per-user inference budget.

## Operational fixtures

The pipeline takes a GitHub **username**, not a repo name.
Probe-validated archetype-pure fixtures:

- `/pack/roobie` — mixed Rust/Zig/Go/Python/Astro stack; featured demo

## Hard constraints baked into the design

1. **Zero per-user LLM calls.** No model inference in the hot path.
2. **`/recommend/semantic` is keyword-AND.**.
3. **Plus-gating:** the daily.dev API requires Plus. Pack URLs render
   statically without a viewer-side PAT; only the apply-action takes a
   PAT, used once, never stored server-side.
4. **Not a daily.dev clone.** Bookmarks, devcard, streaks, briefings
   are out of scope. This tool is strictly the seeding phase.

## Running locally

```bash
# One-time
cp .dev.vars.example .dev.vars
# Edit .dev.vars to set DAILY_DEV_API_TOKEN (your daily.dev Plus PAT)
# and optionally GH_OPERATOR_PAT (lifts GitHub quota from 60 to 5000/hr).

npx wrangler pages dev public
# or, with mise:
mise run dev
```

## Deploying

Target: Cloudflare Pages.

```bash
# One-time
wrangler pages secret put DAILY_DEV_API_TOKEN
wrangler pages secret put GH_OPERATOR_PAT       # optional
# Create your own KV namespace and put its id in wrangler.toml:
wrangler kv namespace create PACK_KV
# Change `name` in wrangler.toml to your Pages project name.

# Each deploy
wrangler pages deploy public --project-name <your-project> --branch main
```

## License

MIT. See `LICENSE`.
