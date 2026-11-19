/**
 * compile-case — turns the most heated Hacker News thread into a playable
 * HN Court case, validated against schemas/case.ts and proven solvable by the
 * DAG solver before anything is written.
 *
 *   npx tsx scripts/compile-case.ts                  compile the next case into content/cases/
 *   npx tsx scripts/compile-case.ts --dry-run        print the case JSON, write nothing
 *   npx tsx scripts/compile-case.ts --story 4502173  compile a specific story
 *   npx tsx scripts/compile-case.ts --validate       validate every case on disk (schema + solver)
 *
 * Drama heuristics (all must hold):
 *   - reply depth >= 5 along the chosen comment chain
 *   - skewed comment-to-upvote ratio (descendants / score >= 1.5)
 *   - sharp sentiment flip between consecutive replies (<= -0.5)
 *   - testimony char caps (20..280 chars, verbatim, never truncated)
 *
 * Circuit breaker: at most --max-attempts candidate stories (default 3) and a
 * --budget-ms wall clock (default 5 minutes). When it trips the process exits
 * with code 75 (EX_TEMPFAIL) so the caller can keep yesterday's buffer case.
 *
 * Exit codes: 0 ok / nothing to do · 1 validation or usage error · 75 breaker open.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { solveCase } from "../engine/dagRunner";
import { LIMITS, safeParseCase, type Card, type CaseFile, type Edge, type TestimonyNode } from "../schemas/case";

const HN_API = "https://hacker-news.firebaseio.com/v0";
const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_BREAKER = 75;

export const HEURISTICS = {
  minReplyDepth: 5,
  minCommentRatio: 1.5,
  minDescendants: 40,
  maxSentimentFlip: -0.5,
  minChars: LIMITS.testimonyMin,
  maxChars: LIMITS.testimonyMax,
  minTestimony: 3,
  maxTurns: 5,
  maxTreeNodes: 450,
  maxTreeDepth: 12,
} as const;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: npx tsx scripts/compile-case.ts [options]

  --date YYYY-MM-DD   docket date (default: today, UTC)
  --story <id>        compile this HN story instead of scanning top stories
  --limit <n>         top stories to scan (default 100)
  --max-attempts <n>  candidate stories to try before the breaker opens (default 3)
  --budget-ms <ms>    total wall-clock budget (default 300000)
  --out <dir>         case directory (default content/cases)
  --keep-handles      keep real HN usernames (default: anonymised)
  --force             compile even if a case already exists for --date
  --dry-run           print the JSON instead of writing it
  --validate          validate every case in --out and exit
  --help              show this help`;

interface Options {
  date: string;
  story: number | null;
  limit: number;
  maxAttempts: number;
  budgetMs: number;
  out: string;
  keepHandles: boolean;
  force: boolean;
  dryRun: boolean;
  validate: boolean;
  help: boolean;
}

function readOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      date: { type: "string" },
      story: { type: "string" },
      limit: { type: "string", default: "100" },
      "max-attempts": { type: "string", default: "3" },
      "budget-ms": { type: "string", default: "300000" },
      out: { type: "string", default: "content/cases" },
      "keep-handles": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      validate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  const int = (name: string, raw: string | undefined, min: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
    return n;
  };
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError("--date must be YYYY-MM-DD");
  return {
    date,
    story: values.story === undefined ? null : int("story", values.story, 1),
    limit: int("limit", values.limit, 1),
    maxAttempts: int("max-attempts", values["max-attempts"], 1),
    budgetMs: int("budget-ms", values["budget-ms"], 1000),
    out: path.resolve(values.out ?? "content/cases"),
    keepHandles: values["keep-handles"] ?? false,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    validate: values.validate ?? false,
    help: values.help ?? false,
  };
}

class UsageError extends Error {}
class CircuitOpenError extends Error {}
class DramaError extends Error {}

// ---------------------------------------------------------------------------
// Budgeted HN client
// ---------------------------------------------------------------------------

class Budget {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  readonly deadline: number;

  constructor(ms: number) {
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => this.controller.abort(), ms);
    this.timer.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  check(): void {
    if (this.controller.signal.aborted || Date.now() >= this.deadline) {
      throw new CircuitOpenError("time budget exhausted");
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

interface HNItem {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;
  text?: string;
  title?: string;
  kids?: number[];
  score?: number;
  descendants?: number;
  time?: number;
  dead?: boolean;
  deleted?: boolean;
  parent?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson<T>(url: string, budget: Budget, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    budget.check();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.any([budget.signal, AbortSignal.timeout(8_000)]),
        headers: { Accept: "application/json", "User-Agent": "hn-court-compiler/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (error) {
      if (budget.signal.aborted) throw new CircuitOpenError("time budget exhausted");
      if (attempt >= retries) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

const fetchItem = (id: number, budget: Budget) => fetchJson<HNItem | null>(`${HN_API}/item/${id}.json`, budget);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Text + sentiment
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function cleanHnText(html: string): string {
  const stripped = html
    .replace(/<p>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<a\s[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "");
  const decoded = stripped.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
  return decoded.replace(/\s+/g, " ").trim();
}

const POSITIVE = new Set(
  "good great love agree fine nice excellent works fast simple easy best better right correct useful helpful thanks fair solid clean reasonable elegant sane mature reliable".split(
    " ",
  ),
);
const NEGATIVE = new Set(
  "bad wrong hate terrible awful slow broken stupid nonsense worse worst negligent malpractice garbage bloated overkill disagree ridiculous absurd insane toxic bug bugs fail fails failure pain nightmare lie lies fud cult hype scared afraid incompetent useless dumb mess outage".split(
    " ",
  ),
);
const INTENSIFIERS = new Set("very really extremely absolutely totally completely literally honestly clearly".split(" "));
const NEGATIONS = new Set("not no never dont don't isn't wasn't can't cannot won't doesn't".split(" "));

/** Lexicon sentiment in (-1, 1), VADER-style normalisation. */
export function sentiment(text: string): number {
  const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let score = 0;
  tokens.forEach((token, i) => {
    let value = POSITIVE.has(token) ? 1 : NEGATIVE.has(token) ? -1 : 0;
    if (value === 0) return;
    const window = tokens.slice(Math.max(0, i - 3), i);
    if (window.some((t) => NEGATIONS.has(t))) value *= -0.8;
    if (window.some((t) => INTENSIFIERS.has(t))) value *= 1.5;
    score += value;
  });
  if (/!{2,}/.test(text)) score *= 1.2;
  return score / Math.sqrt(score * score + 15);
}

/** Sharpest drop between consecutive replies; more negative = bigger flip. */
export function sentimentFlip(texts: readonly string[]): number {
  let flip = 0;
  for (let i = 1; i < texts.length; i += 1) {
    flip = Math.min(flip, sentiment(texts[i] as string) - sentiment(texts[i - 1] as string));
  }
  return Math.max(-1, flip);
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Thread model
// ---------------------------------------------------------------------------

interface ThreadComment {
  id: number;
  by: string;
  text: string;
  depth: number;
  parent: number;
  kids: number[];
}

interface Thread {
  story: HNItem;
  comments: Map<number, ThreadComment>;
}

async function fetchThread(story: HNItem, budget: Budget): Promise<Thread> {
  const comments = new Map<number, ThreadComment>();
  let frontier = (story.kids ?? []).map((id) => ({ id, depth: 1, parent: story.id }));
  while (frontier.length > 0 && comments.size < HEURISTICS.maxTreeNodes) {
    const batch = frontier.slice(0, HEURISTICS.maxTreeNodes - comments.size);
    const items = await mapLimit(batch, 8, (entry) => fetchItem(entry.id, budget));
    const nextFrontier: typeof frontier = [];
    items.forEach((item, i) => {
      const entry = batch[i];
      if (!entry || !item || item.dead || item.deleted || item.type !== "comment" || !item.by || !item.text) return;
      comments.set(item.id, {
        id: item.id,
        by: item.by,
        text: cleanHnText(item.text),
        depth: entry.depth,
        parent: entry.parent,
        kids: item.kids ?? [],
      });
      if (entry.depth < HEURISTICS.maxTreeDepth) {
        for (const kid of item.kids ?? []) nextFrontier.push({ id: kid, depth: entry.depth + 1, parent: item.id });
      }
    });
    frontier = nextFrontier;
  }
  return { story, comments };
}

interface Chain {
  comments: ThreadComment[];
  usable: ThreadComment[];
  witness: string;
  flip: number;
  depth: number;
  score: number;
}

const withinCaps = (text: string) => text.length >= HEURISTICS.minChars && text.length <= HEURISTICS.maxChars;

function ancestry(thread: Thread, leaf: ThreadComment): ThreadComment[] {
  const chain: ThreadComment[] = [];
  let cursor: ThreadComment | undefined = leaf;
  while (cursor) {
    chain.unshift(cursor);
    cursor = thread.comments.get(cursor.parent);
  }
  return chain;
}

/** Finds the most dramatic root-to-leaf reply chain that passes every heuristic. */
export function findDramaChain(thread: Thread): Chain {
  let best: Chain | null = null;
  let deepest = 0;
  let sharpest = 0;
  for (const comment of thread.comments.values()) {
    deepest = Math.max(deepest, comment.depth);
    if (comment.depth < HEURISTICS.minReplyDepth) continue;
    const comments = ancestry(thread, comment);
    const flip = sentimentFlip(comments.map((c) => c.text));
    sharpest = Math.min(sharpest, flip);
    if (flip > HEURISTICS.maxSentimentFlip) continue;
    const usable = comments.filter((c) => withinCaps(c.text));
    if (usable.length < HEURISTICS.minTestimony) continue;
    const counts = new Map<string, number>();
    for (const c of comments) counts.set(c.by, (counts.get(c.by) ?? 0) + 1);
    const [witness, appearances] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const score = -flip * 2 + comments.length * 0.2 + appearances * 0.5 + usable.length * 0.3;
    if (!best || score > best.score) {
      best = { comments, usable, witness, flip, depth: comments.length, score };
    }
  }
  if (!best) {
    if (deepest < HEURISTICS.minReplyDepth) {
      throw new DramaError(`max reply depth ${deepest} < ${HEURISTICS.minReplyDepth}`);
    }
    throw new DramaError(
      `no chain with a sentiment flip <= ${HEURISTICS.maxSentimentFlip} and ${HEURISTICS.minTestimony}+ testimony-sized comments (sharpest flip ${sharpest.toFixed(2)})`,
    );
  }
  return best;
}

// ---------------------------------------------------------------------------
// Objection archetypes
// ---------------------------------------------------------------------------

type Archetype = Card & { keywords: readonly string[] };

const ARCHETYPES: readonly Archetype[] = [
  { id: "citation-needed", title: "CITATION NEEDED", effect: "Demands a primary source", power: 1, risk: 1, keywords: ["study", "studies", "research", "data", "proof", "evidence", "everyone", "always", "most", "source"] },
  { id: "benchmark-or-gtfo", title: "BENCHMARK OR GTFO", effect: "Forces witness to cite numbers", power: 2, risk: 1, keywords: ["fast", "faster", "slow", "performance", "speed", "latency", "throughput", "benchmark", "ms", "req"] },
  { id: "premature-optimization", title: "PREMATURE OPTIMIZATION", effect: "Classic Knuth critical hit", power: 2, risk: 2, keywords: ["optimize", "optimization", "optimizing", "scale", "scaling", "efficient", "efficiency", "microseconds"] },
  { id: "just-use-postgres", title: "JUST USE POSTGRES", effect: "Counters over-engineering claims", power: 2, risk: 1, keywords: ["database", "db", "postgres", "postgresql", "sql", "mongo", "nosql", "sqlite", "query", "orm"] },
  { id: "works-on-my-machine", title: "WORKS ON MY MACHINE", effect: "Deflects repro demands", power: 1, risk: 1, keywords: ["reproduce", "repro", "production", "prod", "local", "machine", "works", "environment"] },
  { id: "moving-goalposts", title: "MOVING GOALPOSTS", effect: "Catches a shifting claim", power: 2, risk: 1, keywords: ["actually", "anyway", "fine", "okay", "ok", "well", "point", "whatever"] },
  { id: "survivorship-bias", title: "SURVIVORSHIP BIAS", effect: "Failures never write blog posts", power: 1, risk: 1, keywords: ["google", "facebook", "meta", "netflix", "amazon", "successful", "companies", "startups", "unicorn"] },
  { id: "choose-boring-tech", title: "CHOOSE BORING TECH", effect: "Innovation tokens are finite", power: 1, risk: 1, keywords: ["new", "modern", "shiny", "hype", "framework", "rewrite", "migrate", "latest", "trendy"] },
  { id: "hiring-pool", title: "HIRING POOL REALITY", effect: "Who maintains it after you?", power: 2, risk: 1, keywords: ["hire", "hiring", "team", "engineers", "developers", "devs", "onboarding", "junior", "talent"] },
  { id: "yagni", title: "YAGNI", effect: "You aren't gonna need it", power: 1, risk: 1, keywords: ["future", "might", "someday", "eventually", "flexible", "extensible", "abstraction", "later"] },
  { id: "show-the-bill", title: "SHOW THE CLOUD BILL", effect: "Make the witness read the invoice", power: 2, risk: 1, keywords: ["cloud", "aws", "gcp", "azure", "cost", "costs", "bill", "pricing", "expensive", "kubernetes", "k8s", "serverless"] },
  { id: "resume-driven", title: "RESUME-DRIVEN DEV", effect: "Questions the real motive", power: 2, risk: 2, keywords: ["learn", "learning", "career", "resume", "cv", "fun", "interesting", "exciting"] },
  { id: "bus-factor", title: "BUS FACTOR OF ONE", effect: "Who's on call at 3am?", power: 2, risk: 1, keywords: ["only", "maintain", "maintainer", "nobody", "understand", "knows", "single", "solo"] },
  { id: "it-was-dns", title: "IT WAS DNS", effect: "It is always DNS", power: 1, risk: 2, keywords: ["outage", "down", "downtime", "incident", "network", "dns", "config", "configuration"] },
  { id: "types-arent-behavior", title: "TYPES AREN'T BEHAVIOR", effect: "A sound type can still be wrong", power: 2, risk: 1, keywords: ["type", "types", "typed", "compiler", "static", "typescript", "haskell", "safety"] },
  { id: "regression-log", title: "REGRESSION LOG", effect: "Same bug, third time", power: 2, risk: 1, keywords: ["test", "tests", "testing", "regression", "ci", "bug", "bugs", "broke"] },
  { id: "threat-model", title: "THREAT MODEL, PLEASE", effect: "Security needs specifics", power: 2, risk: 1, keywords: ["security", "secure", "vulnerability", "cve", "attack", "privacy", "encryption", "unsafe"] },
  { id: "total-cost", title: "TOTAL COST OF OWNING", effect: "Maintenance is the real price", power: 1, risk: 1, keywords: ["maintenance", "money", "price", "budget", "time", "hours", "weeks", "months"] },
  { id: "anecdote-not-data", title: "ANECDOTE, NOT DATA", effect: "One team is not a trend", power: 1, risk: 1, keywords: ["we", "our", "my", "personally", "experience", "anecdotally", "worked"] },
  { id: "false-dichotomy", title: "FALSE DICHOTOMY", effect: "There are more than two options", power: 2, risk: 1, keywords: ["either", "or", "instead", "versus", "vs", "choice", "choose", "alternative"] },
  { id: "strawman", title: "STRAWMAN", effect: "Nobody claimed that", power: 1, risk: 1, keywords: ["nobody", "anyone", "people", "claim", "claims", "saying", "said"] },
  { id: "appeal-to-authority", title: "APPEAL TO AUTHORITY", effect: "Credentials aren't arguments", power: 2, risk: 1, keywords: ["senior", "expert", "years", "decades", "since", "respect", "veteran"] },
  { id: "riir-again", title: "RIIR, AGAIN?", effect: "Mocks the rewrite reflex", power: 1, risk: 2, keywords: ["rust", "rewrite", "rewriting", "rewrote", "port", "ported"] },
  { id: "not-a-skill-issue", title: "NOT A SKILL ISSUE", effect: "Tools should fit the team", power: 1, risk: 1, keywords: ["skill", "dumb", "smart", "incompetent", "scared", "afraid", "lazy"] },
];

function keywordHits(card: Archetype, text: string): number {
  const words = new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  return card.keywords.reduce((n, keyword) => n + (words.has(keyword) ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Case assembly
// ---------------------------------------------------------------------------

const PALETTES = {
  hoodie: ["#2B2D31", "#3B4A3F", "#6B2D2D", "#2D3B6B", "#4A3B5C", "#5C4A2D"],
  hair: ["#141412", "#5A3A22", "#C9A227", "#8B3A1A", "#3A3A3A"],
  skin: ["#E8B48A", "#C98E6B", "#F0C9A0", "#8D5A3B", "#B07A55"],
} as const;

const pick = <T,>(list: readonly T[], hash: number, salt: number): T => list[(hash >>> salt) % list.length] as T;

interface CompileContext {
  number: number;
  date: string;
  keepHandles: boolean;
}

interface TurnNodes {
  turn: number;
  ids: string[];
}

export function assembleCase(thread: Thread, chain: Chain, ctx: CompileContext): CaseFile {
  const story = thread.story;
  const handleFor = (by: string) =>
    ctx.keepHandles ? by.slice(0, LIMITS.handleMax) : `anon_${(fnv1a(by) % 900) + 100}`;
  const witnessHandle = handleFor(chain.witness);
  const turns = Math.min(HEURISTICS.maxTurns, chain.usable.length);
  const used = new Set<number>();

  // Turn t gets the chain comment (A) and, when available, a sibling reply (B).
  type Raw = { id: string; turn: number; comment: ThreadComment };
  const raw: Raw[] = [];
  const byTurn: TurnNodes[] = [];
  for (let t = 1; t <= turns; t += 1) {
    const main = chain.usable[t - 1] as ThreadComment;
    used.add(main.id);
    const ids = [`t${t}-a`];
    raw.push({ id: `t${t}-a`, turn: t, comment: main });
    if (t > 1) {
      const parent = thread.comments.get(main.parent);
      const siblingIds = parent ? parent.kids : (story.kids ?? []);
      const sibling = siblingIds
        .map((id) => thread.comments.get(id))
        .find((c): c is ThreadComment => !!c && !used.has(c.id) && withinCaps(c.text));
      if (sibling) {
        used.add(sibling.id);
        ids.push(`t${t}-b`);
        raw.push({ id: `t${t}-b`, turn: t, comment: sibling });
      }
    }
    byTurn.push({ turn: t, ids });
  }

  const flipFor = (comment: ThreadComment) => {
    const parent = thread.comments.get(comment.parent);
    const value = parent ? sentiment(comment.text) - sentiment(parent.text) : sentiment(comment.text);
    return Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100;
  };

  // Deck: the 12 most relevant archetypes, ordered by the earliest turn they answer.
  const corpus = raw.map((r) => r.comment.text).join(" ");
  const ranked = ARCHETYPES.map((card, order) => {
    const firstTurn = raw.find((r) => keywordHits(card, r.comment.text) > 0)?.turn ?? 99;
    return { card, order, relevance: keywordHits(card, corpus), firstTurn };
  })
    .sort((a, b) => b.relevance - a.relevance || a.order - b.order)
    .slice(0, LIMITS.deckSize)
    .sort((a, b) => a.firstTurn - b.firstTurn || b.relevance - a.relevance || a.order - b.order);
  const deck: Archetype[] = ranked.map((r) => r.card);

  // Routing: critical hits push the main lane (A); sustained hits alternate
  // lanes; the "*" fallback stays in its own lane so lane A is always reachable.
  let edges: Edge[] = [];
  let lanes = raw;
  const nextIds = (turn: number) => byTurn.find((t) => t.turn === turn + 1)?.ids ?? ["v-rest"];
  for (const node of raw) {
    const [mainNext, altNext] = nextIds(node.turn) as [string, string | undefined];
    deck.forEach((card, index) => {
      const hits = keywordHits(card, node.comment.text);
      if (hits === 0) return;
      const ruling = hits >= 2 ? "critical" : "sustained";
      const to = ruling === "critical" || !altNext || index % 2 === 0 ? mainNext : altNext;
      edges.push({ from: node.id, to, cards: [card.id], ruling });
    });
    const sameLane = node.id.endsWith("-b") && altNext ? altNext : mainNext;
    edges.push({ from: node.id, to: sameLane, cards: "*", ruling: "overruled" });
  }

  // Prune alternate lanes nothing routes into (iterate: pruning can orphan the next one).
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of lanes) {
      if (node.turn === 1) continue;
      if (edges.some((e) => e.to === node.id)) continue;
      lanes = lanes.filter((n) => n.id !== node.id);
      edges = edges.filter((e) => e.from !== node.id);
      changed = true;
    }
  }

  // Every card must be routed somewhere; leftovers become closing arguments.
  const finalNode = `t${turns}-a`;
  const routed = (cardId: string) => edges.some((e) => e.cards !== "*" && e.cards.includes(cardId));
  for (const card of deck) {
    if (!routed(card.id)) edges.push({ from: finalNode, to: "v-rest", cards: [card.id], ruling: "sustained" });
  }

  const label = (text: string, max: number) => text.toUpperCase().replace(/[^A-Z0-9 '’,.!?/&:+#-]/g, "").slice(0, max).trim();
  const hash = fnv1a(chain.witness);
  const title = story.title && story.title.length > LIMITS.titleMax
    ? `${story.title.slice(0, LIMITS.titleMax - 1).replace(/\s+\S*$/, "")}…`
    : (story.title ?? `HN thread ${story.id}`);
  const time = new Date((story.time ?? Date.now() / 1000) * 1000);

  const draft: CaseFile = {
    schemaVersion: 1,
    id: `case-${String(ctx.number).padStart(3, "0")}`,
    number: ctx.number,
    date: ctx.date,
    title,
    source: {
      hnItemId: story.id,
      url: `https://news.ycombinator.com/item?id=${story.id}`,
      points: story.score ?? 0,
      commentCount: story.descendants ?? thread.comments.size,
      filedAt: `${String(time.getUTCHours()).padStart(2, "0")}:${String(time.getUTCMinutes()).padStart(2, "0")} UTC`,
      maxDepth: chain.depth,
      sentimentFlip: Math.round(chain.flip * 100) / 100,
    },
    witness: {
      handle: witnessHandle,
      palette: {
        hoodie: pick(PALETTES.hoodie, hash, 0),
        hair: pick(PALETTES.hair, hash, 8),
        skin: pick(PALETTES.skin, hash, 16),
        glasses: "#141412",
        accent: "#7EC8F2",
      },
    },
    rules: {
      maxTurns: turns,
      handSize: 4,
      startingCredibility: 3,
      maxCredibility: 5,
      startingComposure: 5,
      maxComposure: 5,
      turnSeconds: 120,
    },
    verdicts: {
      win: { label: label(deck[0]?.title ?? "OBJECTION SUSTAINED", LIMITS.verdictLabelMax) },
      lose: { label: "WITNESS STANDS FIRM" },
    },
    jury: { againstLabel: "RULED AGAINST WITNESS", witnessLabel: "SIDED WITH WITNESS" },
    deck: deck.map(({ keywords: _keywords, ...card }) => card),
    startNode: "t1-a",
    outcomes: { breakdown: "v-breakdown", contempt: "v-contempt", rest: "v-rest" },
    nodes: [
      ...lanes.map((r) => ({
        id: r.id,
        kind: "testimony" as const,
        turn: r.turn,
        author: handleFor(r.comment.by),
        text: r.comment.text,
        depth: r.comment.depth,
        hnCommentId: r.comment.id,
        sentimentFlip: flipFor(r.comment),
      })),
      {
        id: "v-breakdown",
        kind: "verdict" as const,
        outcome: "win" as const,
        author: "THE_COURT",
        stamp: "WITNESS BROKEN!",
        text: "The witness stops replying and the thread moves on. Counsel's objections carry the day.",
      },
      {
        id: "v-contempt",
        kind: "verdict" as const,
        outcome: "lose" as const,
        author: "THE_COURT",
        stamp: "CONTEMPT!",
        text: "Counsel has exhausted the court's patience. All objections are stricken from the record.",
      },
      {
        id: "v-rest",
        kind: "verdict" as const,
        outcome: "lose" as const,
        author: "THE_COURT",
        stamp: "CASE DISMISSED",
        text: "The witness survives cross-examination and the top comment stands unchallenged.",
      },
    ],
    edges,
  };

  return balance(draft);
}

/**
 * Upgrades overruled routes to sustained, earliest turns and earliest-drawn
 * cards first, until the solver finds at least two distinct winning routes.
 * Monotone (only adds damage), so it always terminates.
 */
function balance(draft: CaseFile): CaseFile {
  let current = draft;
  const testimony = current.nodes
    .filter((n): n is TestimonyNode => n.kind === "testimony")
    .sort((a, b) => a.turn - b.turn);
  for (let guard = 0; guard < 200; guard += 1) {
    const parsed = safeParseCase(current);
    if (!parsed.success) return current;
    if (solveCase(parsed.data).winningRoutes.length >= 2) return parsed.data;
    let upgraded = false;
    outer: for (const node of testimony) {
      for (const card of current.deck) {
        const routed = current.edges.some((e) => e.from === node.id && e.cards !== "*" && e.cards.includes(card.id));
        if (routed) continue;
        const wildcard = current.edges.find((e) => e.from === node.id && e.cards === "*");
        if (!wildcard) continue;
        const mainTarget = current.edges.find((e) => e.from === node.id && e.cards !== "*")?.to ?? wildcard.to;
        current = {
          ...current,
          edges: [...current.edges, { from: node.id, to: mainTarget, cards: [card.id], ruling: "sustained" }],
        };
        upgraded = true;
        break outer;
      }
    }
    if (!upgraded) return current;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function loadExisting(dir: string): { cases: CaseFile[]; problems: string[] } {
  const cases: CaseFile[] = [];
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { cases, problems };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const result = safeParseCase(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
      if (!result.success) {
        problems.push(`${file}:\n    - ${result.issues.join("\n    - ")}`);
        continue;
      }
      if (`${result.data.id}.json` !== file) problems.push(`${file}: file name must be ${result.data.id}.json`);
      cases.push(result.data);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  const seen = new Map<string, string>();
  for (const c of cases) {
    for (const key of [`number ${c.number}`, `date ${c.date}`]) {
      const other = seen.get(key);
      if (other) problems.push(`${c.id}: duplicate ${key} (also ${other})`);
      seen.set(key, c.id);
    }
  }
  return { cases, problems };
}

function validateAll(dir: string): number {
  const { cases, problems } = loadExisting(dir);
  for (const c of cases) {
    const report = solveCase(c);
    const status = report.verified ? "ok " : "BAD";
    console.log(
      `${status} ${c.id}  routes=${report.winningRoutes.length}  paths=${report.totalPaths}  wins=${report.winningPaths}  softlocks=${report.softlocks.length}  unreachable=${report.unreachableNodes.length}`,
    );
    if (!report.verified) {
      problems.push(
        `${c.id}: DAG not verified (routes=${report.winningRoutes.length}, softlocks=${report.softlocks.join("; ") || 0}, unreachable=${report.unreachableNodes.join(",") || 0})`,
      );
    }
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
    return EXIT_INVALID;
  }
  console.log(`\n${cases.length} case(s) valid.`);
  return EXIT_OK;
}

async function rankCandidates(budget: Budget, limit: number): Promise<HNItem[]> {
  const ids = await fetchJson<number[]>(`${HN_API}/topstories.json`, budget);
  const stories = await mapLimit(ids.slice(0, limit), 8, (id) => fetchItem(id, budget));
  return stories
    .filter((s): s is HNItem => !!s && s.type === "story" && !s.dead && !s.deleted)
    .filter((s) => (s.descendants ?? 0) >= HEURISTICS.minDescendants)
    .map((s) => ({ story: s, ratio: (s.descendants ?? 0) / Math.max(1, s.score ?? 0) }))
    .filter((s) => s.ratio >= HEURISTICS.minCommentRatio)
    .sort((a, b) => b.ratio - a.ratio)
    .map((s) => s.story);
}

async function compileStory(story: HNItem, budget: Budget, ctx: CompileContext): Promise<CaseFile> {
  const ratio = (story.descendants ?? 0) / Math.max(1, story.score ?? 0);
  if (ratio < HEURISTICS.minCommentRatio) {
    throw new DramaError(`comment/upvote ratio ${ratio.toFixed(2)} < ${HEURISTICS.minCommentRatio}`);
  }
  const thread = await fetchThread(story, budget);
  const chain = findDramaChain(thread);
  const compiled = assembleCase(thread, chain, ctx);
  const parsed = safeParseCase(compiled);
  if (!parsed.success) throw new DramaError(`schema rejected the compiled case:\n    - ${parsed.issues.join("\n    - ")}`);
  const report = solveCase(parsed.data);
  if (!report.verified) {
    throw new DramaError(
      `solver rejected the compiled case (routes=${report.winningRoutes.length}, softlocks=${report.softlocks.length}, unreachable=${report.unreachableNodes.length})`,
    );
  }
  return parsed.data;
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = readOptions(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return EXIT_INVALID;
  }
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (options.validate) return validateAll(options.out);

  const { cases, problems } = loadExisting(options.out);
  if (problems.length > 0) {
    console.error(`Existing cases are invalid; fix them first:\n  - ${problems.join("\n  - ")}`);
    return EXIT_INVALID;
  }
  if (!options.force && cases.some((c) => c.date === options.date)) {
    console.log(`A case is already docketed for ${options.date}; nothing to do.`);
    return EXIT_OK;
  }
  const ctx: CompileContext = {
    number: cases.reduce((max, c) => Math.max(max, c.number), 0) + 1,
    date: options.date,
    keepHandles: options.keepHandles,
  };

  const budget = new Budget(options.budgetMs);
  const failures: string[] = [];
  try {
    const candidates = options.story
      ? [await fetchItem(options.story, budget)].filter((s): s is HNItem => !!s)
      : await rankCandidates(budget, options.limit);
    if (candidates.length === 0) throw new CircuitOpenError("no candidate stories passed the ratio heuristic");

    let attempts = 0;
    for (const story of candidates) {
      if (attempts >= options.maxAttempts) break;
      if (cases.some((c) => c.source.hnItemId === story.id)) continue;
      attempts += 1;
      const label = `#${story.id} "${story.title ?? ""}"`;
      try {
        console.error(`[${attempts}/${options.maxAttempts}] compiling ${label}`);
        const compiled = await compileStory(story, budget, ctx);
        const json = `${JSON.stringify(compiled, null, 2)}\n`;
        if (options.dryRun) {
          process.stdout.write(json);
        } else {
          fs.mkdirSync(options.out, { recursive: true });
          const file = path.join(options.out, `${compiled.id}.json`);
          fs.writeFileSync(file, json, { flag: "wx" });
          console.log(`Wrote ${path.relative(process.cwd(), file)} from ${label}`);
        }
        return EXIT_OK;
      } catch (error) {
        if (error instanceof CircuitOpenError) throw error;
        failures.push(`${label}: ${(error as Error).message}`);
        console.error(`  rejected: ${(error as Error).message}`);
      }
    }
    throw new CircuitOpenError(`no case compiled after ${attempts} attempt(s)`);
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      console.error(`Circuit breaker open: ${error.message}.`);
      if (failures.length > 0) console.error(`  - ${failures.join("\n  - ")}`);
      console.error("Keeping the current docket (buffer case stays active).");
      return EXIT_BREAKER;
    }
    throw error;
  } finally {
    budget.dispose();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /compile-case\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(EXIT_INVALID);
    });
}
