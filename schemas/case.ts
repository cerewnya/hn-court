import { z } from "zod";

/**
 * HN Court case file schema.
 *
 * A case is a deterministic dialogue DAG: testimony nodes (verbatim HN
 * comments) connected by edges keyed on objection cards. The schema enforces
 * both shape and graph integrity so a case that parses is guaranteed to be
 * structurally playable; `engine/dagRunner.solveCase` then proves it is winnable.
 */

export const SCHEMA_VERSION = 1 as const;

/** Character caps. These double as layout guarantees for the UI (no clipping). */
export const LIMITS = {
  titleMax: 120,
  testimonyMin: 20,
  testimonyMax: 280,
  cardTitleMax: 22,
  cardEffectMax: 34,
  noteMax: 96,
  stampMax: 16,
  verdictLabelMax: 24,
  juryLabelMax: 28,
  handleMax: 20,
  deckSize: 12,
  handSize: 4,
} as const;

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case");
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "must be a #RRGGBB colour");
const handle = z
  .string()
  .min(2)
  .max(LIMITS.handleMax)
  .regex(/^[A-Za-z0-9_-]+$/, "must be a bare HN-style handle");
const upperLabel = (max: number) =>
  z
    .string()
    .min(2)
    .max(max)
    .regex(/^[A-Z0-9 '’,.!?/&:+#-]+$/, "must be uppercase");

export const RulingSchema = z.enum(["critical", "sustained", "overruled"]);

export const CardSchema = z
  .object({
    id: slug,
    title: upperLabel(LIMITS.cardTitleMax),
    effect: z.string().min(3).max(LIMITS.cardEffectMax),
    /** Composure damage dealt when the objection is sustained. */
    power: z.number().int().min(1).max(3),
    /** Credibility lost when the objection is overruled. */
    risk: z.number().int().min(1).max(3),
  })
  .strict();

export const TestimonyNodeSchema = z
  .object({
    id: slug,
    kind: z.literal("testimony"),
    turn: z.number().int().min(1).max(10),
    author: handle,
    /** Verbatim comment text (HTML stripped, entities decoded). */
    text: z.string().min(LIMITS.testimonyMin).max(LIMITS.testimonyMax),
    /** Reply depth of the source comment in the HN thread. */
    depth: z.number().int().min(0).max(64),
    hnCommentId: z.number().int().positive().optional(),
    sentimentFlip: z.number().min(-1).max(1).optional(),
  })
  .strict();

export const VerdictNodeSchema = z
  .object({
    id: slug,
    kind: z.literal("verdict"),
    outcome: z.enum(["win", "lose"]),
    author: z.string().min(2).max(LIMITS.handleMax),
    text: z.string().min(LIMITS.testimonyMin).max(LIMITS.testimonyMax),
    stamp: upperLabel(LIMITS.stampMax),
  })
  .strict();

export const NodeSchema = z.discriminatedUnion("kind", [TestimonyNodeSchema, VerdictNodeSchema]);

export const EdgeSchema = z
  .object({
    from: slug,
    to: slug,
    /** Card ids that take this edge, or "*" for the mandatory fallback edge. */
    cards: z.union([z.literal("*"), z.array(slug).min(1)]),
    ruling: RulingSchema,
    /** Optional remark from the bench, shown with the ruling. */
    note: z.string().min(3).max(LIMITS.noteMax).optional(),
  })
  .strict();

export const RulesSchema = z
  .object({
    maxTurns: z.number().int().min(3).max(8),
    handSize: z.literal(LIMITS.handSize),
    startingCredibility: z.number().int().min(1).max(5),
    maxCredibility: z.literal(5),
    startingComposure: z.number().int().min(1).max(5),
    maxComposure: z.literal(5),
    turnSeconds: z.number().int().min(15).max(600),
  })
  .strict();

export const SourceSchema = z
  .object({
    hnItemId: z.number().int().positive(),
    url: z.url(),
    points: z.number().int().min(0),
    commentCount: z.number().int().min(0),
    filedAt: z.string().regex(/^\d{2}:\d{2} UTC$/, "must look like 08:00 UTC"),
    /** Drama heuristic: the source chain must be at least 5 replies deep. */
    maxDepth: z.number().int().min(5, "drama heuristic: reply depth must be >= 5"),
    sentimentFlip: z.number().min(-1).max(1),
  })
  .strict();

export const WitnessSchema = z
  .object({
    handle,
    /** Optional pre-rendered scene. Without it the canvas draws a procedural witness. */
    sprite: z
      .object({
        src: z.string().regex(/^\/assets\/[a-z0-9-]+\.(png|webp)$/, "must live in /public/assets"),
        headX: z.number().min(0).max(1),
        headY: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    palette: z
      .object({
        hoodie: hex,
        hair: hex,
        skin: hex,
        glasses: hex,
        accent: hex,
      })
      .strict(),
  })
  .strict();

const CaseShape = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^case-\d{3}$/, "must look like case-014"),
    number: z.number().int().positive(),
    date: z.iso.date(),
    title: z.string().min(10).max(LIMITS.titleMax),
    source: SourceSchema,
    witness: WitnessSchema,
    rules: RulesSchema,
    verdicts: z
      .object({
        win: z.object({ label: upperLabel(LIMITS.verdictLabelMax) }).strict(),
        lose: z.object({ label: upperLabel(LIMITS.verdictLabelMax) }).strict(),
      })
      .strict(),
    jury: z
      .object({
        againstLabel: upperLabel(LIMITS.juryLabelMax),
        witnessLabel: upperLabel(LIMITS.juryLabelMax),
      })
      .strict(),
    deck: z.array(CardSchema).length(LIMITS.deckSize),
    startNode: slug,
    outcomes: z
      .object({
        /** Reached when witness composure hits 0. Must be a winning verdict. */
        breakdown: slug,
        /** Reached when counsel credibility hits 0. Must be a losing verdict. */
        contempt: slug,
        /** Reached when turns run out. Must be a losing verdict. */
        rest: slug,
      })
      .strict(),
    nodes: z.array(NodeSchema).min(4),
    edges: z.array(EdgeSchema).min(3),
  })
  .strict();

type CaseShapeT = z.infer<typeof CaseShape>;

function validateGraph(c: CaseShapeT, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: "custom", message, path });

  const expectedId = `case-${String(c.number).padStart(3, "0")}`;
  if (c.id !== expectedId) issue(`id must be ${expectedId} for number ${c.number}`, ["id"]);
  if (c.rules.startingCredibility > c.rules.maxCredibility) {
    issue("startingCredibility exceeds maxCredibility", ["rules", "startingCredibility"]);
  }
  if (c.rules.startingComposure > c.rules.maxComposure) {
    issue("startingComposure exceeds maxComposure", ["rules", "startingComposure"]);
  }

  // Unique ids.
  const cardIds = new Set<string>();
  c.deck.forEach((card, i) => {
    if (cardIds.has(card.id)) issue(`duplicate card id "${card.id}"`, ["deck", i, "id"]);
    cardIds.add(card.id);
  });
  const nodes = new Map<string, CaseShapeT["nodes"][number]>();
  c.nodes.forEach((node, i) => {
    if (nodes.has(node.id)) issue(`duplicate node id "${node.id}"`, ["nodes", i, "id"]);
    nodes.set(node.id, node);
    if (node.kind === "testimony" && node.turn > c.rules.maxTurns) {
      issue(`turn ${node.turn} exceeds maxTurns ${c.rules.maxTurns}`, ["nodes", i, "turn"]);
    }
  });

  // Start + outcome wiring.
  const start = nodes.get(c.startNode);
  if (!start) issue(`startNode "${c.startNode}" does not exist`, ["startNode"]);
  else if (start.kind !== "testimony" || start.turn !== 1) {
    issue("startNode must be a turn-1 testimony node", ["startNode"]);
  }
  const outcomeRules: Array<[keyof CaseShapeT["outcomes"], "win" | "lose"]> = [
    ["breakdown", "win"],
    ["contempt", "lose"],
    ["rest", "lose"],
  ];
  for (const [key, outcome] of outcomeRules) {
    const target = nodes.get(c.outcomes[key]);
    if (!target) issue(`outcome node "${c.outcomes[key]}" does not exist`, ["outcomes", key]);
    else if (target.kind !== "verdict" || target.outcome !== outcome) {
      issue(`outcomes.${key} must point at a "${outcome}" verdict node`, ["outcomes", key]);
    }
  }

  // Edges.
  const wildcardCount = new Map<string, number>();
  const cardsSeenPerNode = new Map<string, Set<string>>();
  const referencedCards = new Set<string>();
  const adjacency = new Map<string, string[]>();
  c.edges.forEach((edge, i) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from) issue(`edge source "${edge.from}" does not exist`, ["edges", i, "from"]);
    if (!to) issue(`edge target "${edge.to}" does not exist`, ["edges", i, "to"]);
    if (from && from.kind === "verdict") {
      issue(`verdict node "${from.id}" cannot have outgoing edges`, ["edges", i, "from"]);
    }
    if (from && from.kind === "testimony" && to) {
      if (to.kind === "testimony" && to.turn !== from.turn + 1) {
        issue(
          `edge ${from.id} → ${to.id} must advance exactly one turn (${from.turn} → ${to.turn})`,
          ["edges", i, "to"],
        );
      }
      if (to.kind === "testimony" && from.turn >= c.rules.maxTurns) {
        issue(`final-turn node "${from.id}" must lead to a verdict`, ["edges", i, "to"]);
      }
    }
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);

    if (edge.cards === "*") {
      wildcardCount.set(edge.from, (wildcardCount.get(edge.from) ?? 0) + 1);
    } else {
      const seen = cardsSeenPerNode.get(edge.from) ?? new Set<string>();
      edge.cards.forEach((cardId, j) => {
        if (!cardIds.has(cardId)) issue(`unknown card "${cardId}"`, ["edges", i, "cards", j]);
        if (seen.has(cardId)) {
          issue(`card "${cardId}" is routed twice from "${edge.from}"`, ["edges", i, "cards", j]);
        }
        seen.add(cardId);
        referencedCards.add(cardId);
      });
      cardsSeenPerNode.set(edge.from, seen);
    }
  });

  // Every testimony node needs exactly one fallback edge: this is what makes
  // softlocks impossible regardless of which cards are in hand.
  c.nodes.forEach((node, i) => {
    if (node.kind !== "testimony") return;
    const count = wildcardCount.get(node.id) ?? 0;
    if (count !== 1) {
      issue(`testimony node "${node.id}" needs exactly one "*" fallback edge (has ${count})`, [
        "nodes",
        i,
      ]);
    }
  });

  // Dead cards make the deck dishonest.
  c.deck.forEach((card, i) => {
    if (!referencedCards.has(card.id)) {
      issue(`card "${card.id}" is never routed by any edge`, ["deck", i, "id"]);
    }
  });

  // Reachability from the start node (outcome nodes are reachable implicitly
  // through stat thresholds and turn exhaustion).
  const reachable = new Set<string>([
    c.startNode,
    c.outcomes.breakdown,
    c.outcomes.contempt,
    c.outcomes.rest,
  ]);
  const queue = [c.startNode];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of adjacency.get(id) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  c.nodes.forEach((node, i) => {
    if (!reachable.has(node.id)) issue(`node "${node.id}" is unreachable`, ["nodes", i, "id"]);
  });
}

export const CaseSchema = CaseShape.superRefine(validateGraph);

export type CaseFile = z.infer<typeof CaseSchema>;
export type Card = z.infer<typeof CardSchema>;
export type CaseNode = z.infer<typeof NodeSchema>;
export type TestimonyNode = z.infer<typeof TestimonyNodeSchema>;
export type VerdictNode = z.infer<typeof VerdictNodeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Ruling = z.infer<typeof RulingSchema>;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export type CaseParseResult =
  | { success: true; data: CaseFile }
  | { success: false; issues: string[] };

export function safeParseCase(input: unknown): CaseParseResult {
  const result = CaseSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: formatIssues(result.error) };
}

export function parseCase(input: unknown, label = "case"): CaseFile {
  const result = safeParseCase(input);
  if (!result.success) {
    throw new Error(`${label} failed schema validation:\n  - ${result.issues.join("\n  - ")}`);
  }
  return result.data;
}
