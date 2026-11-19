import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  applyMove,
  createTrial,
  legalMoves,
  solveCase,
  type Move,
  type TrialState,
} from "../engine/dagRunner";
import { safeParseCase, type CaseFile } from "../schemas/case";

/**
 * HN Court verification suite.
 *
 *  1. Content: every JSON in content/cases/ passes the Zod schema, and its
 *     dialogue DAG is walked exhaustively (every card choice and every timeout)
 *     to prove zero softlocks and at least two distinct winning routes.
 *  2. API: health, jury vote (validation + one vote per juror), OG image.
 *  3. Layout: desktop 1440×900 and mobile 390×844 render with zero text or
 *     card clipping, before and after a verdict.
 *  4. Gameplay: keyboard and mouse flows, a solver-proven win, a loss,
 *     share-to-clipboard, persistence and replay.
 */

const CASES_DIR = path.join(__dirname, "..", "content", "cases");
const caseFiles = fs
  .readdirSync(CASES_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort();

function readCase(file: string): CaseFile {
  const result = safeParseCase(JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8")));
  if (!result.success) throw new Error(`${file} is invalid:\n  - ${result.issues.join("\n  - ")}`);
  return result.data;
}

const allCases = () => caseFiles.map(readCase);
const activeCase = () => allCases().sort((a, b) => b.number - a.number)[0] as CaseFile;

/** First card-only path matching the wanted outcome, found by plain DFS. */
function findPath(c: CaseFile, outcome: "won" | "lost"): Move[] {
  const walk = (state: TrialState, moves: Move[]): Move[] | null => {
    if (state.status !== "in_session") return state.status === outcome ? moves : null;
    for (const cardId of state.hand) {
      const move: Move = { type: "play", cardId };
      const found = walk(applyMove(c, state, move).state, [...moves, move]);
      if (found) return found;
    }
    return null;
  };
  const path_ = walk(createTrial(c), []);
  if (!path_) throw new Error(`${c.id} has no ${outcome} path`);
  return path_;
}

// ---------------------------------------------------------------------------
// 1. Case content
// ---------------------------------------------------------------------------

test.describe("case content", () => {
  test("docket holds the active case plus at least two buffer cases", () => {
    expect(caseFiles.length).toBeGreaterThanOrEqual(3);
    expect(caseFiles).toContain("case-014.json");
  });

  test("case numbers, ids and dates are unique", () => {
    const cases = allCases();
    for (const key of ["id", "number", "date"] as const) {
      const values = cases.map((c) => c[key]);
      expect(new Set(values).size, `duplicate ${key}`).toBe(values.length);
    }
  });

  for (const file of caseFiles) {
    test.describe(file, () => {
      test("passes the strict Zod schema", () => {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8"));
        const result = safeParseCase(raw);
        expect(result.success ? [] : result.issues).toEqual([]);
        if (result.success) {
          expect(`${result.data.id}.json`).toBe(file);
          expect(result.data.deck).toHaveLength(12);
        }
      });

      test("DAG solver: zero softlocks, every node reachable, >= 2 winning routes", () => {
        const c = readCase(file);
        const report = solveCase(c);
        expect(report.softlocks).toEqual([]);
        expect(report.unreachableNodes).toEqual([]);
        expect(report.cardsNeverDrawn).toEqual([]);
        expect(report.winningRoutes.length).toBeGreaterThanOrEqual(2);
        expect(report.losingPaths, "a case nobody can lose is not a trial").toBeGreaterThan(0);
        expect(report.maxTurnsUsed).toBeLessThanOrEqual(c.rules.maxTurns);
        expect(report.verified).toBe(true);
        // Re-prove the solver's sample wins by replaying them through the engine.
        for (const win of report.sampleWins) {
          const end = win.moves.reduce((s, m) => applyMove(c, s, m).state, createTrial(c));
          expect(end.status).toBe("won");
        }
      });

      test("independent walk: every state terminates with a legal move available", () => {
        const c = readCase(file);
        let terminals = 0;
        let wins = 0;
        const routes = new Set<string>();
        const stack: Array<{ state: TrialState; route: string[] }> = [
          { state: createTrial(c), route: [c.startNode] },
        ];
        while (stack.length > 0) {
          const { state, route } = stack.pop() as { state: TrialState; route: string[] };
          if (state.status !== "in_session") {
            terminals += 1;
            if (state.status === "won") {
              wins += 1;
              routes.add(route.join(">"));
            }
            continue;
          }
          expect(state.history.length, `${route.join(">")} exceeded maxTurns`).toBeLessThan(c.rules.maxTurns);
          expect(state.hand.length, `empty hand at ${state.nodeId}`).toBeGreaterThan(0);
          const moves = legalMoves(c, state);
          expect(moves.length).toBeGreaterThan(0);
          for (const move of moves) {
            const next = applyMove(c, state, move).state;
            stack.push({ state: next, route: [...route, next.nodeId] });
          }
        }
        expect(terminals).toBeGreaterThan(0);
        expect(wins).toBeGreaterThan(0);
        expect(routes.size).toBeGreaterThanOrEqual(2);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. API
// ---------------------------------------------------------------------------

test.describe("api", () => {
  test("GET /api/health reports the active case", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      activeCase: activeCase().id,
      casesLoaded: caseFiles.length,
    });
  });

  test("GET /api/vote returns a consistent split", async ({ request }) => {
    const res = await request.get("/api/vote?caseId=case-014");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.against + body.witness).toBe(body.total);
    expect(body.againstPct + body.witnessPct).toBe(100);
    expect(["memory", "redis"]).toContain(body.source);
    if (body.source === "memory") {
      expect(body.against).toBeGreaterThanOrEqual(914);
      expect(body.witness).toBeGreaterThanOrEqual(514);
    }
  });

  test("POST /api/vote validates input and counts one vote per juror", async ({ playwright, baseURL }) => {
    const juror = await playwright.request.newContext({ baseURL });
    try {
      expect((await juror.post("/api/vote", { data: { caseId: "case-012", side: "maybe" } })).status()).toBe(400);
      expect((await juror.post("/api/vote", { data: { caseId: "case-999", side: "against" } })).status()).toBe(404);
      const before = await (await juror.get("/api/vote?caseId=case-012")).json();
      const first = await juror.post("/api/vote", { data: { caseId: "case-012", side: "witness" } });
      expect(first.status()).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.accepted).toBe(true);
      expect(firstBody.witness).toBeGreaterThanOrEqual(before.witness + 1);
      const second = await juror.post("/api/vote", { data: { caseId: "case-012", side: "witness" } });
      expect(second.status()).toBe(200);
      expect((await second.json()).accepted).toBe(false);
    } finally {
      await juror.dispose();
    }
  });

  test("GET /api/og/[id] renders a PNG verdict card", async ({ request }) => {
    const res = await request.get("/api/og/case-014?r=SSC__&v=win");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    const body = await res.body();
    expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(body.length).toBeGreaterThan(10_000);
    expect((await request.get("/api/og/case-999")).status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function openCourt(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("app")).toHaveAttribute("data-hydrated", "true");
}

/** Presses the keys for each move and waits until the UI reflects the engine. */
async function playMoves(page: Page, c: CaseFile, moves: Move[]): Promise<TrialState> {
  const app = page.getByTestId("app");
  let state = createTrial(c);
  for (const move of moves) {
    if (move.type !== "play") throw new Error("UI helper only plays cards");
    const slot = state.hand.indexOf(move.cardId);
    expect(slot, `${move.cardId} should be in hand`).toBeGreaterThanOrEqual(0);
    await page.keyboard.press(String(slot + 1));
    await expect(page.getByTestId(`card-${slot + 1}`)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    state = applyMove(c, state, move).state;
    await expect(app).toHaveAttribute("data-status", state.status);
    await expect(app).toHaveAttribute("data-phase", "idle");
    await expect(page.getByTestId("testimony")).toHaveAttribute("data-node-id", state.nodeId);
  }
  return state;
}

/** Runs in the page: reports clipped text, escaped elements and horizontal overflow. */
function collectClipping(): string[] {
  const problems: string[] = [];
  const root = document.querySelector('[data-testid="app"]');
  if (!root) return ["app root missing"];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
  }
  const label = (el: Element) => {
    const testId = el.getAttribute("data-testid");
    const cls = (el.getAttribute("class") ?? "").split(" ")[0];
    return `<${el.tagName.toLowerCase()}${testId ? ` data-testid=${testId}` : ""}${cls ? ` .${cls}` : ""}> "${(el.textContent ?? "").trim().slice(0, 48)}"`;
  };
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest(".sr-only") || el instanceof SVGElement || el.tagName === "CANVAS") continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.display === "inline" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    );
    const anyText = (el.textContent ?? "").trim().length > 0;
    if (anyText && el.scrollWidth > el.clientWidth + 1) {
      problems.push(`horizontal text overflow ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
    if (anyText && style.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 1) {
      problems.push(`vertical clipping ${label(el)} (${el.scrollHeight} > ${el.clientHeight})`);
    }
    if (rect.left < -1 || rect.right > vw + 1) problems.push(`off-screen ${label(el)}`);
    const container = el.parentElement?.closest("[data-bounds]");
    if (ownText && container) {
      const box = container.getBoundingClientRect();
      const slack = style.transform === "none" ? 1 : 4;
      if (
        rect.left < box.left - slack ||
        rect.right > box.right + slack ||
        rect.top < box.top - slack ||
        rect.bottom > box.bottom + slack
      ) {
        problems.push(`${label(el)} escapes [data-bounds=${container.getAttribute("data-bounds")}]`);
      }
    }
  }
  return problems;
}

/** Runs in the page: every hand card fully on screen, none overlapping. */
function collectCardProblems(): string[] {
  const problems: string[] = [];
  const vw = document.documentElement.clientWidth;
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="card-"]'));
  if (cards.length !== 4) problems.push(`expected 4 card slots, found ${cards.length}`);
  const rects = cards.map((card) => card.getBoundingClientRect());
  rects.forEach((r, i) => {
    if (r.width < 120 || r.height < 60) problems.push(`card ${i + 1} is too small (${r.width}×${r.height})`);
    if (r.left < 0 || r.right > vw || r.top + window.scrollY < 0) problems.push(`card ${i + 1} is off-screen`);
    const card = cards[i] as HTMLElement;
    if (card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1) {
      problems.push(`card ${i + 1} content is clipped`);
    }
    rects.forEach((other, j) => {
      if (j <= i) return;
      const overlapX = Math.min(r.right, other.right) - Math.max(r.left, other.left);
      const overlapY = Math.min(r.bottom, other.bottom) - Math.max(r.top, other.top);
      if (overlapX > 0.5 && overlapY > 0.5) problems.push(`cards ${i + 1} and ${j + 1} overlap`);
    });
  });
  return problems;
}

// ---------------------------------------------------------------------------
// 3. Layout
// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`layout @ ${vp.name} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce" });

    for (const file of caseFiles) {
      test(`${file}: zero text or card clipping`, async ({ page }) => {
        const c = readCase(file);
        await openCourt(page, `/${c.number}`);
        expect(await page.evaluate(collectClipping)).toEqual([]);
        expect(await page.evaluate(collectCardProblems)).toEqual([]);
        await expect(page.getByTestId("case-title")).toHaveText(c.title);
      });
    }

    test("zero clipping after a verdict, with the longest texts on screen", async ({ page }) => {
      const c = readCase("case-014.json");
      await openCourt(page, "/14");
      await playMoves(page, c, findPath(c, "won"));
      expect(await page.evaluate(collectClipping)).toEqual([]);
      expect(await page.evaluate(collectCardProblems)).toEqual([]);
    });

    if (vp.name === "desktop") {
      test("matches the Paper frame: 48px top bar, 68/32 columns, 16:9 viewport", async ({ page }) => {
        await openCourt(page, "/14");
        const metrics = await page.evaluate(() => {
          const box = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error(`missing ${selector}`);
            return el.getBoundingClientRect();
          };
          return {
            topbar: box(".topbar").height,
            trial: box(".trial").width,
            dossier: box(".dossier").width,
            viewport: box('[data-testid="courtroom-viewport"]'),
            pageHeight: document.documentElement.scrollHeight,
          };
        });
        expect(metrics.topbar).toBe(48);
        expect(metrics.trial / (metrics.trial + metrics.dossier)).toBeCloseTo(0.68, 2);
        expect(metrics.viewport.width / metrics.viewport.height).toBeCloseTo(16 / 9, 1);
        expect(metrics.pageHeight).toBeLessThanOrEqual(900);
      });

      test("intermediate widths never overflow", async ({ page }) => {
        await openCourt(page, "/14");
        for (const width of [1280, 1180, 1024, 900, 768]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(collectClipping), `at ${width}px`).toEqual([]);
          expect(await page.evaluate(collectCardProblems), `at ${width}px`).toEqual([]);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Gameplay
// ---------------------------------------------------------------------------

test.describe("gameplay", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("renders the docket chrome", async ({ page }) => {
    const c = readCase("case-014.json");
    await openCourt(page, "/14");
    await expect(page.getByTestId("turn-indicator")).toHaveText(`CROSS-EXAMINATION 1 / ${c.rules.maxTurns}`);
    await expect(page.getByTestId("timer")).toHaveText("02:00");
    await expect(page.getByTestId("dag-pill")).toHaveText("DAG VERIFIED");
    await expect(page.getByTestId("chiptune-toggle")).toContainText("CHIPTUNE: ON");
    await expect(page.getByTestId("heated-tag")).toContainText("HEATED THREAD • DEPTH");
    await expect(page.getByTestId("deck-counter")).toContainText("DECK: 4 / 12 CARDS DRAWN");
    await expect(page.getByTestId("card-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("card-1")).toContainText("JUST USE POSTGRES");
    await expect(page.getByTestId("jury-panel")).toContainText(c.jury.againstLabel);
    await expect(page.getByTestId("testimony-text")).toHaveText(`“${c.nodes[0]?.text}”`);
    await page.getByTestId("chiptune-toggle").click();
    await expect(page.getByTestId("chiptune-toggle")).toContainText("CHIPTUNE: OFF");
  });

  test("keyboard [1]-[4] selects and [SPACE] slams, matching the engine", async ({ page }) => {
    const c = readCase("case-014.json");
    await openCourt(page, "/14");
    const app = page.getByTestId("app");
    await page.keyboard.press("2");
    await expect(page.getByTestId("card-2")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("card-1")).toHaveAttribute("aria-pressed", "false");

    const start = createTrial(c);
    const cardId = start.hand[1] as string;
    const { state, record } = applyMove(c, start, { type: "play", cardId });
    await page.keyboard.press("Space");
    await expect(app).toHaveAttribute("data-turn", "2");
    await expect(page.getByTestId("testimony")).toHaveAttribute("data-node-id", state.nodeId);
    await expect(page.getByTestId("meter-credibility")).toHaveAttribute("data-value", String(state.credibility));
    await expect(page.getByTestId("meter-composure")).toHaveAttribute("data-value", String(state.composure));
    await expect(page.getByTestId("deck-counter")).toContainText(`${state.drawIndex} / 12`);
    await expect(page.getByTestId("ruling-banner")).toHaveAttribute("data-ruling", record.ruling);
    await expect(page.getByTestId("turn-indicator")).toHaveText(`CROSS-EXAMINATION 2 / ${c.rules.maxTurns}`);
  });

  test("mouse: clicking a card then pressing [SPACE] slams that card", async ({ page }) => {
    const c = readCase("case-014.json");
    await openCourt(page, "/14");
    const start = createTrial(c);
    await page.getByTestId("card-3").click();
    await expect(page.getByTestId("card-3")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    const { state } = applyMove(c, start, { type: "play", cardId: start.hand[2] as string });
    await expect(page.getByTestId("app")).toHaveAttribute("data-turn", "2");
    await expect(page.getByTestId("testimony")).toHaveAttribute("data-node-id", state.nodeId);

    const second = state.hand[3] as string;
    await page.getByTestId("card-4").click();
    await page.getByTestId("slam").click();
    const after = applyMove(c, state, { type: "play", cardId: second }).state;
    await expect(page.getByTestId("app")).toHaveAttribute("data-status", after.status);
    await expect(page.getByTestId("testimony")).toHaveAttribute("data-node-id", after.nodeId);
  });

  test("solver-proven win: verdict, jury vote, share to clipboard, persistence, replay", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const c = readCase("case-014.json");
    const report = solveCase(c);
    const win = report.sampleWins[0];
    expect(win).toBeDefined();
    await openCourt(page, "/14");
    const final = await playMoves(page, c, win?.moves ?? []);
    const app = page.getByTestId("app");
    expect(final.status).toBe("won");
    await expect(app).toHaveAttribute("data-status", "won");
    await expect(page.getByTestId("share-verdict")).toHaveText(`Verdict: ${c.verdicts.win.label}`);
    await expect(page.getByTestId("session-stamp")).toHaveText("ADJOURNED");
    await expect(page.getByTestId("timer")).toHaveText("ADJOURNED");
    await expect(page.getByTestId("jury-panel")).toContainText("YOU");

    await page.getByTestId("copy-share").click();
    await expect(page.getByTestId("copy-share")).toHaveAttribute("data-state", "copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(`HN Court #${c.number}`);
    expect(clip).toContain(`Verdict: ${c.verdicts.win.label}`);
    expect(clip).toMatch(/Objections: \d\/\d • Top \d{1,3}%/);
    expect(clip).toMatch(/(🟩|🟧|🟥|⬜){5}/u);
    expect(clip).toMatch(new RegExp(`/${c.number}\\?r=[CSOT_]{5}&v=win$`, "m"));

    await page.reload();
    await expect(app).toHaveAttribute("data-hydrated", "true");
    await expect(app).toHaveAttribute("data-status", "won");

    await page.keyboard.press("r");
    await expect(app).toHaveAttribute("data-status", "in_session");
    await expect(app).toHaveAttribute("data-turn", "1");
  });

  test("a losing line ends in a ruling for the witness", async ({ page }) => {
    const c = readCase("case-014.json");
    await openCourt(page, "/14");
    await playMoves(page, c, findPath(c, "lost"));
    await expect(page.getByTestId("app")).toHaveAttribute("data-status", "lost");
    await expect(page.getByTestId("share-verdict")).toHaveText(`Verdict: ${c.verdicts.lose.label}`);
    await expect(page.getByTestId("replay")).toBeVisible();
  });

  test("every buffer case is playable to a verdict", async ({ page }) => {
    for (const c of allCases().filter((x) => x.id !== "case-014")) {
      await openCourt(page, `/${c.number}`);
      await playMoves(page, c, solveCase(c).sampleWins[0]?.moves ?? []);
      await expect(page.getByTestId("app")).toHaveAttribute("data-status", "won");
    }
  });
});
