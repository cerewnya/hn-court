import type { Card, CaseFile, CaseNode, Edge, Ruling, TestimonyNode, VerdictNode } from "../schemas/case";

/**
 * Deterministic branching-dialogue engine for HN Court.
 *
 * Everything here is pure: a trial is a `TrialState` value and every move
 * produces a new one. That makes the game replayable from a move log (used
 * for persistence), shareable without spoilers, and exhaustively solvable —
 * `solveCase` walks every reachable state to prove there are no softlocks.
 *
 * Turn resolution order:
 *   1. Route the move through the current node's edges (specific card match,
 *      else the mandatory "*" fallback edge).
 *   2. Apply the ruling's stat effect (see `rulingEffect`).
 *   3. Refill the hand from the deck in authored order; an overruled
 *      objection (or a timeout) also strikes one more exhibit from the record.
 *   4. Witness composure 0 → breakdown (win); counsel credibility 0 →
 *      contempt (lose); turns exhausted → rest (lose); else follow the edge.
 */

export type Move = { type: "play"; cardId: string } | { type: "timeout" };
export type TrialStatus = "in_session" | "won" | "lost";
export type TurnRuling = Ruling | "timeout";

export interface TurnRecord {
  turn: number;
  from: string;
  to: string;
  cardId: string | null;
  ruling: TurnRuling;
  composureDelta: number;
  credibilityDelta: number;
  /** Exhibit struck from the record (overruled objections and timeouts). */
  struckCardId: string | null;
  note: string | null;
}

export interface TrialState {
  caseId: string;
  nodeId: string;
  /** 1-based. While in session this is the turn being played. */
  turn: number;
  credibility: number;
  composure: number;
  /** Card ids in slot order; slots are refilled in place. */
  hand: string[];
  /** Index of the next card to draw; equals the number of cards drawn. */
  drawIndex: number;
  history: TurnRecord[];
  status: TrialStatus;
}

export class TrialError extends Error {
  override name = "TrialError";
}

interface CaseIndex {
  nodes: Map<string, CaseNode>;
  cards: Map<string, Card>;
  edgesFrom: Map<string, Edge[]>;
}

const indexCache = new WeakMap<CaseFile, CaseIndex>();

function indexCase(c: CaseFile): CaseIndex {
  const cached = indexCache.get(c);
  if (cached) return cached;
  const nodes = new Map(c.nodes.map((n) => [n.id, n] as const));
  const cards = new Map(c.deck.map((card) => [card.id, card] as const));
  const edgesFrom = new Map<string, Edge[]>();
  for (const edge of c.edges) {
    edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), edge]);
  }
  const index = { nodes, cards, edgesFrom };
  indexCache.set(c, index);
  return index;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function getNode(c: CaseFile, id: string): CaseNode {
  const node = indexCase(c).nodes.get(id);
  if (!node) throw new TrialError(`unknown node "${id}" in ${c.id}`);
  return node;
}

export function getCard(c: CaseFile, id: string): Card {
  const card = indexCase(c).cards.get(id);
  if (!card) throw new TrialError(`unknown card "${id}" in ${c.id}`);
  return card;
}

export function currentNode(c: CaseFile, s: TrialState): CaseNode {
  return getNode(c, s.nodeId);
}

export function createTrial(c: CaseFile): TrialState {
  const handSize = Math.min(c.rules.handSize, c.deck.length);
  return {
    caseId: c.id,
    nodeId: c.startNode,
    turn: 1,
    credibility: c.rules.startingCredibility,
    composure: c.rules.startingComposure,
    hand: c.deck.slice(0, handSize).map((card) => card.id),
    drawIndex: handSize,
    history: [],
    status: "in_session",
  };
}

/** Specific card edge first, then the node's "*" fallback. `null` = no card (timeout). */
export function resolveEdge(c: CaseFile, nodeId: string, cardId: string | null): Edge {
  const edges = indexCase(c).edgesFrom.get(nodeId) ?? [];
  const specific =
    cardId === null ? undefined : edges.find((e) => e.cards !== "*" && e.cards.includes(cardId));
  const edge = specific ?? edges.find((e) => e.cards === "*");
  if (!edge) throw new TrialError(`softlock: node "${nodeId}" has no route for ${cardId ?? "timeout"}`);
  return edge;
}

export function rulingEffect(
  card: Card | null,
  ruling: TurnRuling,
): { composure: number; credibility: number } {
  switch (ruling) {
    case "critical":
      return { composure: -(card?.power ?? 1), credibility: 1 };
    case "sustained":
      return { composure: -(card?.power ?? 1), credibility: 0 };
    case "overruled":
      return { composure: 1, credibility: -(card?.risk ?? 1) };
    case "timeout":
      return { composure: 1, credibility: -1 };
  }
}

export function legalMoves(c: CaseFile, s: TrialState): Move[] {
  if (s.status !== "in_session") return [];
  const node = currentNode(c, s);
  if (node.kind !== "testimony") return [];
  return [...s.hand.map((cardId): Move => ({ type: "play", cardId })), { type: "timeout" }];
}

export function applyMove(
  c: CaseFile,
  s: TrialState,
  move: Move,
): { state: TrialState; record: TurnRecord } {
  if (s.caseId !== c.id) throw new TrialError(`state belongs to ${s.caseId}, not ${c.id}`);
  if (s.status !== "in_session") throw new TrialError("the trial is adjourned");
  const node = currentNode(c, s);
  if (node.kind !== "testimony") throw new TrialError(`node "${node.id}" is not testimony`);

  const cardId = move.type === "play" ? move.cardId : null;
  const slot = cardId === null ? -1 : s.hand.indexOf(cardId);
  if (cardId !== null && slot === -1) throw new TrialError(`card "${cardId}" is not in hand`);

  const card = cardId === null ? null : getCard(c, cardId);
  const edge = resolveEdge(c, node.id, cardId);
  const ruling: TurnRuling = move.type === "timeout" ? "timeout" : edge.ruling;
  const effect = rulingEffect(card, ruling);

  const composure = clamp(s.composure + effect.composure, 0, c.rules.maxComposure);
  const credibility = clamp(s.credibility + effect.credibility, 0, c.rules.maxCredibility);

  // Hand bookkeeping: refill in place, strike on bad objections.
  const hand = [...s.hand];
  let drawIndex = s.drawIndex;
  const refill = (index: number) => {
    if (drawIndex < c.deck.length) {
      hand[index] = (c.deck[drawIndex] as Card).id;
      drawIndex += 1;
    } else {
      hand.splice(index, 1);
    }
  };
  if (slot !== -1) refill(slot);
  let struckCardId: string | null = null;
  if ((ruling === "overruled" || ruling === "timeout") && drawIndex < c.deck.length && hand.length > 1) {
    const strikeIndex = slot === -1 ? 0 : (slot + 1) % hand.length;
    struckCardId = hand[strikeIndex] ?? null;
    refill(strikeIndex);
  }

  let to: string;
  if (composure <= 0) to = c.outcomes.breakdown;
  else if (credibility <= 0) to = c.outcomes.contempt;
  else {
    to = edge.to;
    const target = getNode(c, to);
    if (target.kind === "testimony" && s.turn >= c.rules.maxTurns) to = c.outcomes.rest;
  }
  const target = getNode(c, to);
  const status: TrialStatus =
    target.kind === "verdict" ? (target.outcome === "win" ? "won" : "lost") : "in_session";

  const record: TurnRecord = {
    turn: s.turn,
    from: node.id,
    to,
    cardId,
    ruling,
    composureDelta: composure - s.composure,
    credibilityDelta: credibility - s.credibility,
    struckCardId,
    note: edge.note ?? null,
  };

  return {
    record,
    state: {
      caseId: s.caseId,
      nodeId: to,
      turn: status === "in_session" ? s.turn + 1 : s.turn,
      credibility,
      composure,
      hand,
      drawIndex,
      history: [...s.history, record],
      status,
    },
  };
}

/** Rebuild a trial from a move log. Throws `TrialError` if the log is not legal. */
export function replay(c: CaseFile, moves: readonly Move[]): TrialState {
  return moves.reduce((state, move) => applyMove(c, state, move).state, createTrial(c));
}

export function movesOf(s: TrialState): Move[] {
  return s.history.map((r) => (r.cardId === null ? { type: "timeout" } : { type: "play", cardId: r.cardId }));
}

export function verdictNode(c: CaseFile, s: TrialState): VerdictNode | null {
  const node = currentNode(c, s);
  return node.kind === "verdict" ? node : null;
}

export function testimonyNode(c: CaseFile, s: TrialState): TestimonyNode | null {
  const node = currentNode(c, s);
  return node.kind === "testimony" ? node : null;
}

// ---------------------------------------------------------------------------
// Scoring & sharing
// ---------------------------------------------------------------------------

export type Square = "critical" | "sustained" | "overruled" | "timeout" | "empty";

export const SQUARE_EMOJI: Record<Square, string> = {
  critical: "🟩",
  sustained: "🟧",
  overruled: "🟥",
  timeout: "🟥",
  empty: "⬜",
};

const SQUARE_CODE: Record<Square, string> = {
  critical: "C",
  sustained: "S",
  overruled: "O",
  timeout: "T",
  empty: "_",
};

export function verdictSquares(c: CaseFile, s: TrialState): Square[] {
  const squares: Square[] = s.history.map((r) => r.ruling);
  while (squares.length < c.rules.maxTurns) squares.push("empty");
  return squares;
}

/** Compact, spoiler-free result string for share URLs, e.g. "SSC__". */
export function encodeResult(c: CaseFile, s: TrialState): string {
  return verdictSquares(c, s)
    .map((sq) => SQUARE_CODE[sq])
    .join("");
}

export function decodeResult(code: string, maxTurns: number): Square[] {
  const byCode = new Map(Object.entries(SQUARE_CODE).map(([sq, ch]) => [ch, sq as Square]));
  const squares = code
    .slice(0, maxTurns)
    .split("")
    .map((ch) => byCode.get(ch.toUpperCase()) ?? "empty");
  while (squares.length < maxTurns) squares.push("empty");
  return squares;
}

export function objectionTally(s: TrialState): { landed: number; played: number } {
  const played = s.history.filter((r) => r.cardId !== null).length;
  const landed = s.history.filter((r) => r.ruling === "critical" || r.ruling === "sustained").length;
  return { landed, played };
}

/** Higher is better. Wins dominate; faster, cleaner wins beat slower ones. */
export function scoreTrial(c: CaseFile, s: TrialState): number {
  const damage = c.rules.startingComposure - s.composure;
  const criticals = s.history.filter((r) => r.ruling === "critical").length;
  const unused = c.rules.maxTurns - s.history.length;
  const base = s.status === "won" ? 1000 + unused * 40 : 0;
  return base + damage * 100 + s.credibility * 10 + criticals * 5;
}

/** "Top N%" — share of all possible card-play trials that scored at least as well. */
export function topPercent(histogram: ReadonlyArray<readonly [number, number]>, score: number): number {
  let total = 0;
  let atLeast = 0;
  for (const [value, count] of histogram) {
    total += count;
    if (value >= score) atLeast += count;
  }
  if (total === 0) return 100;
  return clamp(Math.ceil((atLeast / total) * 100), 1, 100);
}

export interface ShareInput {
  url: string;
  topPct: number | null;
  verdictLabel: string;
}

export function buildShareText(c: CaseFile, s: TrialState, input: ShareInput): string {
  const squares = verdictSquares(c, s)
    .map((sq) => SQUARE_EMOJI[sq])
    .join("");
  const { landed, played } = objectionTally(s);
  const rank = input.topPct === null ? "" : ` • Top ${input.topPct}%`;
  return [
    `HN Court #${c.number}  ${squares}`,
    `Verdict: ${input.verdictLabel}`,
    `Objections: ${landed}/${played}${rank}`,
    input.url,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export interface SolvedPath {
  moves: Move[];
  route: string[];
  status: Exclude<TrialStatus, "in_session">;
  score: number;
}

export interface SolveReport {
  caseId: string;
  /** Terminal paths explored, including timeouts. */
  totalPaths: number;
  /** Card-only terminal paths (the population used for percentiles). */
  cardPaths: number;
  winningPaths: number;
  losingPaths: number;
  /** Distinct node routes that end in a win. */
  winningRoutes: string[][];
  /** A few concrete winning move sequences (card plays only). */
  sampleWins: SolvedPath[];
  softlocks: string[];
  unreachableNodes: string[];
  cardsNeverDrawn: string[];
  maxTurnsUsed: number;
  /** [score, count] pairs over card-only paths, score descending. */
  scoreHistogram: Array<[number, number]>;
  verified: boolean;
}

export interface SolveOptions {
  /** Hard cap on explored terminal paths, guards against pathological content. */
  maxPaths?: number;
  sampleWins?: number;
}

export function solveCase(c: CaseFile, options: SolveOptions = {}): SolveReport {
  const maxPaths = options.maxPaths ?? 250_000;
  const sampleLimit = options.sampleWins ?? 8;
  const softlocks: string[] = [];
  const visitedNodes = new Set<string>();
  const drawnCards = new Set<string>();
  const winningRoutes = new Map<string, string[]>();
  const sampleWins: SolvedPath[] = [];
  const histogram = new Map<number, number>();
  let totalPaths = 0;
  let cardPaths = 0;
  let winningPaths = 0;
  let losingPaths = 0;
  let maxTurnsUsed = 0;

  const walk = (state: TrialState, moves: Move[], route: string[], cardOnly: boolean): void => {
    if (totalPaths >= maxPaths) {
      if (!softlocks.includes("path budget exhausted")) softlocks.push("path budget exhausted");
      return;
    }
    visitedNodes.add(state.nodeId);
    state.hand.forEach((id) => drawnCards.add(id));

    if (state.status !== "in_session") {
      totalPaths += 1;
      maxTurnsUsed = Math.max(maxTurnsUsed, state.history.length);
      const won = state.status === "won";
      if (won) winningPaths += 1;
      else losingPaths += 1;
      if (cardOnly) {
        cardPaths += 1;
        const score = scoreTrial(c, state);
        histogram.set(score, (histogram.get(score) ?? 0) + 1);
        if (won) {
          const key = route.join(">");
          if (!winningRoutes.has(key)) winningRoutes.set(key, route);
          if (sampleWins.length < sampleLimit) {
            sampleWins.push({ moves, route, status: state.status, score });
          }
        }
      }
      return;
    }

    if (state.turn > c.rules.maxTurns) {
      softlocks.push(`turn overflow at ${state.nodeId} (turn ${state.turn})`);
      return;
    }
    if (state.hand.length === 0) {
      softlocks.push(`empty hand at ${state.nodeId} (turn ${state.turn}) — only the clock can move`);
    }
    const moves_ = legalMoves(c, state);
    if (moves_.length === 0) {
      softlocks.push(`no legal moves at ${state.nodeId} (turn ${state.turn})`);
      return;
    }
    for (const move of moves_) {
      let next: TrialState;
      try {
        next = applyMove(c, state, move).state;
      } catch (error) {
        softlocks.push(
          `${state.nodeId}: ${move.type === "play" ? move.cardId : "timeout"} → ${(error as Error).message}`,
        );
        continue;
      }
      walk(next, [...moves, move], [...route, next.nodeId], cardOnly && move.type === "play");
    }
  };

  walk(createTrial(c), [], [c.startNode], true);

  const unreachableNodes = c.nodes.map((n) => n.id).filter((id) => !visitedNodes.has(id));
  const cardsNeverDrawn = c.deck.map((card) => card.id).filter((id) => !drawnCards.has(id));
  const routes = [...winningRoutes.values()];

  return {
    caseId: c.id,
    totalPaths,
    cardPaths,
    winningPaths,
    losingPaths,
    winningRoutes: routes,
    sampleWins,
    softlocks,
    unreachableNodes,
    cardsNeverDrawn,
    maxTurnsUsed,
    scoreHistogram: [...histogram.entries()].sort((a, b) => b[0] - a[0]),
    verified: softlocks.length === 0 && routes.length >= 2 && unreachableNodes.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

/** Stateful facade over the pure functions, handy for scripts and tests. */
export class DagRunner {
  private current: TrialState;

  constructor(
    readonly caseFile: CaseFile,
    state?: TrialState,
  ) {
    this.current = state ?? createTrial(caseFile);
  }

  get state(): TrialState {
    return this.current;
  }

  get node(): CaseNode {
    return currentNode(this.caseFile, this.current);
  }

  get hand(): Card[] {
    return this.current.hand.map((id) => getCard(this.caseFile, id));
  }

  get done(): boolean {
    return this.current.status !== "in_session";
  }

  play(cardId: string): TurnRecord {
    return this.apply({ type: "play", cardId });
  }

  timeout(): TurnRecord {
    return this.apply({ type: "timeout" });
  }

  apply(move: Move): TurnRecord {
    const { state, record } = applyMove(this.caseFile, this.current, move);
    this.current = state;
    return record;
  }

  reset(): void {
    this.current = createTrial(this.caseFile);
  }

  static solve(c: CaseFile, options?: SolveOptions): SolveReport {
    return solveCase(c, options);
  }
}
