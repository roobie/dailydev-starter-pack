// GitHub-side of the pipeline: fetch public repos, filter, rank, and
// extract the topic set per repo. Pure logic where possible, single
// side-effecting fetch in `fetchRepos`.
//
// Trust boundary:
// - Username is validated against the GitHub username regex BEFORE this
//   module is called. The route layer is responsible for that.
// - Repo fields are treated as untrusted strings when interpolated into
//   HTML downstream — that's the caller's job (escapeHtml / safeUrl).

export interface Repo {
  name: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
  fork: boolean;
  private: boolean;
}

// Tokens used for the GitHub API request. Optional operator PAT pushes the
// rate-limit quota from 60/hr (unauthenticated) to 5000/hr.
export interface GithubAuth {
  operatorPat?: string;
}

const GH_BASE = "https://api.github.com";

// User-Agent is required by the GitHub REST API; an empty UA returns 403.
const USER_AGENT = "dailydev-cold-start-co-pilot (https://dailydev-starter-pack.pages.dev)";

export async function fetchRepos(
  username: string,
  auth: GithubAuth = {},
): Promise<Repo[]> {
  const url = `${GH_BASE}/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=20`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (auth.operatorPat) {
    headers["Authorization"] = `Bearer ${auth.operatorPat}`;
  }
  const r = await fetch(url, { headers });
  if (!r.ok) {
    throw new Error(`github: ${r.status} ${r.statusText} for ${username}`);
  }
  return (await r.json()) as Repo[];
}

// Drop forks; require at least one signal (description, topics, or language).
export function filterRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter(
    (r) =>
      !r.fork &&
      !r.private &&
      (!!r.description || r.topics.length > 0 || !!r.language),
  );
}

// Rank by pushed_at × log(stars + 1). Newer + more-starred floats up.
// Returns a copy; does not mutate input.
export function rankRepos(repos: readonly Repo[]): Repo[] {
  const now = Date.now();
  const scored = repos.map((r) => {
    const ageMs = Math.max(1, now - Date.parse(r.pushed_at));
    // Recency: 1.0 for "now", decays toward 0 as age grows. Use log to soften.
    const recency = 1 / Math.log(2 + ageMs / 86_400_000); // age in days
    const popularity = Math.log(r.stargazers_count + 1) + 1;
    return { repo: r, score: recency * popularity };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.repo);
}

// Tokens that should never be treated as topics. Combines:
//  - common English connectives and fillers
//  - generic verbs that slip through naive tokenization
//  - style adjectives that don't represent technical topics
//  - common URL-fragment leftovers (https, com, dev, www, …) — the URL
//    stripping pass below catches most, this is the fallback
//
// False-positive topics still get silently dropped by /recommend/semantic
// (no matches → no articles), but every survivor costs ~1-15s of fan-out
// latency, so we filter aggressively here.
const STOP: ReadonlySet<string> = new Set([
  // articles, prepositions, conjunctions, common fillers
  "and", "any", "are", "but", "for", "from", "have", "has", "had",
  "into", "its", "not", "now", "off", "only", "out", "over", "than",
  "that", "the", "their", "them", "then", "there", "these", "this",
  "via", "was", "were", "what", "when", "where", "which", "while",
  "with", "will", "you", "your", "yours", "they", "also", "some",
  "more", "most", "less", "least", "etc", "yet", "still",
  "another", "either", "neither", "both", "such",
  // style adjectives
  "modern", "simple", "fast", "lightweight", "minimal", "tiny", "small",
  "easy", "clean", "powerful", "robust", "elegant", "blazing", "best",
  "better", "great", "good", "nice", "awesome", "every", "many", "much",
  "very", "just", "really", "first", "next", "last",
  // generic verbs / verb-forms
  "use", "uses", "using", "used", "make", "makes", "made", "build",
  "builds", "built", "create", "creates", "created", "creating",
  "run", "runs", "ran", "running", "add", "adds", "adding",
  "get", "gets", "got", "set", "sets", "take", "takes", "taking",
  "give", "gives", "gave", "send", "sent", "find", "finds", "found",
  "fetch", "fetches", "want", "wants", "need", "needs", "needed",
  "can", "could", "should", "would", "may", "might", "must",
  "do", "does", "did", "doing", "done",
  // URL-shaped fragments left after the stripping pass
  "https", "http", "www", "com", "org", "net", "app", "info",
  "html", "page", "site",
]);

// Pull candidate topic tokens from a free-text description.
//
// Pipeline (applied in order):
//   1. lowercase
//   2. strip URLs (https?://… and bare-domain forms like "example.dev")
//   3. split on non-word-or-hyphen runs
//   4. drop tokens shorter than 4 chars, pure digits, or in STOP
//
// The 4-char floor drops most low-signal noise (use/add/dev/but/can) while
// keeping legitimate short technical terms (sql, llm, css are 3 chars and
// will be lost — accept that trade for the latency win). 3-letter tags
// that matter usually appear in the GH `topics` field too, which is
// merged in unfiltered by `unionTopics` below.
export function descriptionKeywords(desc: string | null): string[] {
  if (!desc) return [];
  return desc
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b\w+\.(?:com|org|net|io|app|dev|so|me|co|sh)\b/g, " ")
    .split(/[^a-z0-9-]+/)
    .filter(
      (w) =>
        w.length >= 4 &&
        !STOP.has(w) &&
        !/^[0-9]+$/.test(w) &&
        /[a-z]/.test(w),
    );
}

// Topic set for a single repo: language ∪ topics ∪ description keywords.
// Language is lowercased; topics are passed through as-is (kebab-case is
// the convention). Returns a unique-ordered list.
export function extractTopics(repo: Repo): string[] {
  const out = new Set<string>();
  if (repo.language) out.add(repo.language.toLowerCase());
  for (const t of repo.topics) out.add(t.toLowerCase());
  for (const k of descriptionKeywords(repo.description)) out.add(k);
  return [...out];
}

// Maximum number of description-derived ("low-signal") keywords to admit
// into the topic union. Language and GH-topics ("high-signal") are kept
// unconditionally — they're curated by the repo owner.
const MAX_LOW_SIGNAL_TOPICS = 20;

// Union of topics across a ranked list of repos.
//
// High-signal sources (language + repo.topics) are admitted in full.
// Low-signal sources (description keywords) are scored by cross-repo
// frequency and capped at MAX_LOW_SIGNAL_TOPICS — a keyword appearing in
// multiple repo descriptions is genuinely thematic, not one-off noise.
//
// This bounds the /recommend/semantic fan-out at roughly:
//   ~languages (1-5) + ~GH topics per repo (0-15) + 20 low-signal
// ≈ 25-40 keywords for a typical active GH user, down from ~100-150 in
// the naive union. With concurrency=6 and ~15s/call, that's ~5-7
// rounds × 15s ≈ 75-100s cold path — still slow but materially better,
// and the further wins come from caching (keyword-keyed and pack-keyed).
export function unionTopics(repos: readonly Repo[]): string[] {
  const highSignal = new Set<string>();
  const lowSignalFreq = new Map<string, number>();

  for (const repo of repos) {
    if (repo.language) highSignal.add(repo.language.toLowerCase());
    for (const t of repo.topics) highSignal.add(t.toLowerCase());
    for (const k of descriptionKeywords(repo.description)) {
      if (!highSignal.has(k)) {
        lowSignalFreq.set(k, (lowSignalFreq.get(k) ?? 0) + 1);
      }
    }
  }

  // Top-K by frequency, tiebreak alphabetic for deterministic ordering.
  const topLowSignal = [...lowSignalFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LOW_SIGNAL_TOPICS)
    .map(([k]) => k);

  return [...highSignal, ...topLowSignal];
}

// GitHub username regex per the GitHub spec.
const USERNAME_RE = /^[a-zA-Z0-9-]{1,39}$/;

export function isValidUsername(s: string): boolean {
  return USERNAME_RE.test(s);
}
