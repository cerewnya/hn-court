# HN Court

A daily courtroom game built from the most heated Hacker News thread. Every day
one witness takes the stand and you cross-examine them with **objection cards**
until they break, or until you get held in contempt.

```
CASE #014 • DAILY TRIAL      CROSS-EXAMINATION 1 / 5   02:00      CHIPTUNE: ON   DAG VERIFIED
```

- **Next.js 16 (App Router) + TypeScript + React 19.** No UI kit; the palette and type follow the Paper design *HN Court — Case #014*.
- **Deterministic engine.** Each case is a JSON dialogue DAG. The game is a pure reducer over it, and a solver proves every case winnable before it ships.
- **Zero-asset audio.** The chiptune SFX are synthesised with Web Audio square, triangle and noise channels.
- **Live global jury.** Votes go to Upstash Redis, with an in-memory fallback for local development.

---

## Quick start

```bash
npm install
npm run dev                 # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run build` / `npm start` | Production build / serve |
| `npx tsc --noEmit` | Type check (also `npm run typecheck`) |
| `npx playwright test` | Full verification suite. Builds and serves the app on `127.0.0.1:3100` |
| `npm run validate-cases` | Schema + DAG solver over every file in `content/cases/` |
| `npm run compile-case -- --dry-run` | Compile today's case from the live HN API and print it |

The first time you run the tests, install the browser with `npx playwright install chromium`.

### Environment

All optional. Copy `.env.example` to `.env.local`.

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Persistent jury votes. Without them `/api/vote` uses an in-process store seeded at **914 vs 514**. |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for share links and Open Graph tags. Falls back to the Vercel URL, then localhost. |

---

## The game loop

1. **Testimony.** The witness's verbatim HN comment types out in the testimony box. A heated reply chain is at least 5 levels deep, and its depth is shown on the `HEATED THREAD • DEPTH n` tag.
2. **Pick an objection.** You hold 4 cards drawn in order from a 12-card deck. Select one with **[1]–[4]** or a click.
3. **Slam it.** **[SPACE]** or `SLAM OBJECTION` shows the `OBJECTION!` stamp and shakes the screen. The witness sweats and points back. The case's edges decide the ruling:

   | Ruling | Witness composure | Your credibility | Square |
   | --- | --- | --- | --- |
   | **Critical** | − card power | +1 | 🟩 |
   | **Sustained** | − card power | ±0 | 🟧 |
   | **Overruled** | +1 | − card risk | 🟥 |
   | **Timeout** (clock hits 0) | +1 | −1 | 🟥 |

   After a played card, the next card from the deck refills its slot. An overruled objection or a timeout also strikes a second card from your hand.
4. **Next testimony.** The DAG routes you to the witness's reply for the next cross-examination. Which reply you get depends on the card you played.
5. **Verdict.** Composure reaching **0** breaks the witness and you win. Credibility reaching **0** means contempt. Surviving all 5 turns means the case is dismissed. Both of those are losses.
6. **Share.** You get a spoiler-free summary for Slack or X:

   ```
   HN Court #14  🟧🟧🟩⬜⬜
   Verdict: JUST USE POSTGRES
   Objections: 3/3 • Top 4%
   https://hncourt.dev/14?r=SSC__&v=win
   ```

   The link opens a per-result Open Graph card rendered by `/api/og/[id]`. Finishing a trial also casts your vote in the **Live Global Jury**: winning votes against the witness, losing votes with them.

Keyboard: `1–4` select · `Space` slam · `M` mute · `R` new trial (after a verdict).
Progress is saved as a move log in `localStorage` and replayed through the engine on reload.
`prefers-reduced-motion` turns off the shakes and the typewriter effect.

---

## Architecture

```
app/
  page.tsx                 today's case (server component, dynamic)
  [num]/page.tsx           any released case: /14, /13, … (+ ?r=&v= share metadata)
  layout.tsx               local fonts: IBM Plex Mono + Barlow Condensed 800
  api/vote/route.ts        GET tally / POST vote (Zod-validated, one vote per juror cookie)
  api/og/[id]/route.tsx    next/og ImageResponse verdict card (1200×630)
  api/health/route.ts      { status: "ok", activeCase, casesLoaded }
components/                CourtroomApp (state machine), TopBar, CourtroomViewport,
                           Testimony, ObjectionHand, Dossier, useJury
engine/
  dagRunner.ts             pure rules engine, exhaustive solver, scoring, share encoding
  courtroomCanvas.ts       320×180 pixel-art renderer: sprite or procedural witness,
                           sweat drops, pointing pose, OBJECTION!/HOLD IT! stamps, shake
  chiptune.ts              Web Audio synth (blips, gavel, fanfares), mute persisted
schemas/case.ts            Zod schema + graph invariants for case files
content/cases/*.json       case-014 (active) + case-013, case-012 (buffer)
lib/                       case registry (mtime-cached), jury store (Redis | memory), site URLs
scripts/compile-case.ts    HN Firebase API → validated case JSON
tests/dag-solver.spec.ts   Playwright verification suite
public/assets/witness-014.png  witness art exported from the Paper design
```

**Data flow.** Server components load the active case and its solver report through `lib/cases.ts`. A case is released once its `date` is on or before today (UTC). The client gets the parsed case, then runs every move through `applyMove` locally. The server is only involved in jury votes and OG images. Because the engine is pure and deterministic, the same functions run in the browser, in the solver and in the tests.

**Rendering.** The viewport canvas draws at 320×180 and scales up with smoothing off. Case #014 uses the pixel-art sprite exported from Paper (`public/assets/witness-014.png`). Cases without a sprite use the procedural witness, coloured by the case's `witness.palette`, with poses for pointing, recoil, slump and smugness. Sweat drops scale with how much composure the witness has lost.

---

## Verification: Zod + solver + Playwright

Every case is checked at three levels. All three run in CI on every PR.

### 1. Schema (`schemas/case.ts`)

The schema is strict, so unknown keys are rejected. It enforces the content caps that keep the UI from clipping: testimony 20–280 chars, card titles ≤ 22, effects ≤ 34, stamps ≤ 16. A `superRefine` pass then checks the graph:

- ids are unique and `case-NNN` matches `number`. The start node is a turn-1 testimony.
- Each testimony → testimony edge advances exactly one turn. Final-turn nodes lead only to verdicts, and verdict nodes are terminal.
- Each testimony node has exactly one `"*"` fallback edge, and no card is routed twice from the same node.
- Every deck card is used by some edge, and every node is reachable from the start.
- Outcome mapping is fixed: `breakdown` → a win verdict, `contempt` and `rest` → lose verdicts.

### 2. DAG solver (`solveCase` in `engine/dagRunner.ts`)

The solver does a depth-first walk of the full state space: every card in every hand, plus the timeout move at every turn. It reports:

- **softlocks**: an in-session state with no legal move or an empty hand. Must be **0**.
- **unreachable nodes** and **cards never drawn**. Both must be empty.
- **winning routes**: distinct testimony paths that end in a win. Must be **≥ 2**, so there is never only one solution.
- the score histogram behind the "Top N%" figure on the share card.

The top bar's `DAG VERIFIED` pill comes from this report.

### 3. Playwright (`tests/dag-solver.spec.ts`)

| Suite | Checks |
| --- | --- |
| case content | schema per file; solver report; a second, independent DFS that re-proves terminal states and ≥ 2 winning routes; sample wins replayed through the engine |
| api | `/api/health` shape; vote validation (400/404); one vote per juror cookie; OG endpoint returns a real PNG |
| layout @ 1440×900 and 390×844 | **zero text or card clipping** for every case, before and after a verdict, using `scrollWidth`/`scrollHeight` checks plus `[data-bounds]` containment; no horizontal page scroll; the Paper frame geometry (48 px top bar, 68/32 columns, 16:9 viewport, fits in 900 px); intermediate widths 768–1280 |
| gameplay | keyboard and mouse flows checked against the engine; a solver-proven win played end to end; share text copied from the real clipboard; jury `YOU` marker; reload persistence; `R` replay; a losing line; every buffer case playable |

---

## Daily case pipeline (Devin bot, data-only PRs)

A new case reaches production only as a **data-only pull request**:

```
 ┌───────────── Devin bot (daily, 00:05 UTC) ─────────────┐
 │ git checkout -b case/2026-11-20                        │
 │ npm ci                                                  │
 │ npx tsx scripts/compile-case.ts --date 2026-11-20      │──┐ exit 75 → stop, open nothing
 │ git add content/cases/case-015.json                    │  │ (buffer case stays live)
 │ open PR "case: #015 (2026-11-20)"                       │  │
 └─────────────────────────────────────────────────────────┘  │
                         │                                    │
                         ▼                                    │
 .github/workflows/daily-case.yml                             │
   1. path-lock guard  → fail if anything outside content/cases/*.json changed
   2. npx tsc --noEmit
   3. npx playwright test   (schema, solver, layout, gameplay on the new case)
                         │
                         ▼
               merge → deploy → case #015 goes live on its date
```

**What the compiler does** (`scripts/compile-case.ts`):

1. **Find candidates.** Fetches `topstories` from the HN Firebase API (`https://hacker-news.firebaseio.com/v0`). Keeps stories with ≥ 40 comments and a **skewed comment-to-upvote ratio** (descendants ÷ points ≥ 1.5), most controversial first.
2. **Walk the thread.** Breadth-first, bounded to 450 comments and depth 12. HTML is stripped and entities decoded.
3. **Find the drama.** Looks for the root-to-leaf reply chain with **reply depth ≥ 5** and a **sharp sentiment flip** (≤ −0.5 between consecutive replies, using a negation- and intensifier-aware lexicon). It also needs at least 3 comments that fit the **character caps** (20–280). Comments are quoted verbatim and never truncated.
4. **Compile.** The chain becomes turns 1–5, with sibling replies as alternate branches. The 12 best-matching cards are picked from a 24-card archetype library by keyword relevance, and keyword hits decide each ruling. Handles are anonymised (`anon_NNN`) unless you pass `--keep-handles`.
5. **Balance.** Adds sustained routes until the solver finds at least 2 winning routes.
6. **Validate.** Runs the Zod schema and the solver. A case that fails either is rejected and never written.

**Circuit breaker.** The compiler tries at most **3 candidate stories** (`--max-attempts`) within a **5-minute wall-clock budget** (`--budget-ms 300000`). Every HTTP call shares one abort signal. If no case passes, or time runs out, it exits **75** (`EX_TEMPFAIL`) and writes nothing. The bot then stops without opening a PR, and yesterday's case stays live because the server always serves the newest *released* case. Keeping 2 buffer cases in `content/cases/` means a bad day never leaves the site without a case.

**Path lock.** On any `case/*` branch the first CI job diffs against the merge base and fails if any file outside `content/cases/*.json` changed. A bot PR therefore cannot touch code, tests, the workflow or the schema, and has to pass the same checks as a human-written case.

Exit codes: `0` written (or a case already exists for that date) · `1` invalid input or existing cases fail validation · `75` circuit breaker open.

Other flags: `--story <id>`, `--date YYYY-MM-DD`, `--limit <n>`, `--out <dir>`, `--force`, `--dry-run`, `--validate`.

> The bundled cases (#012–#014) are hand-authored fixtures in the same format. Their item ids, scores and handles are illustrative and do not refer to real HN threads.

---

## Deploying

The app is a standard Next.js app and works on Vercel without extra config. `next.config.ts` includes `content/cases/**`, `assets/fonts/**` and `public/assets/**` in the serverless file trace, so the API routes can read them at runtime. Add the Upstash variables to keep votes across instances.
