import { Redis } from "@upstash/redis";

/**
 * Global jury tally. Uses Upstash Redis when UPSTASH_REDIS_REST_URL is set,
 * otherwise an in-process store seeded to 914 vs 514 (64% / 36%) so the app
 * runs locally with zero configuration.
 */

export type JurySide = "against" | "witness";

export interface JuryCounts {
  against: number;
  witness: number;
}

export interface JuryTally extends JuryCounts {
  caseId: string;
  total: number;
  againstPct: number;
  witnessPct: number;
  source: "redis" | "memory";
  updatedAt: string;
}

export const MEMORY_SEED: Readonly<JuryCounts> = Object.freeze({ against: 914, witness: 514 });

export interface JuryStore {
  readonly kind: "redis" | "memory";
  read(caseId: string): Promise<JuryCounts>;
  increment(caseId: string, side: JurySide): Promise<JuryCounts>;
}

export class MemoryJuryStore implements JuryStore {
  readonly kind = "memory" as const;
  private readonly counts = new Map<string, JuryCounts>();

  constructor(private readonly seed: Readonly<JuryCounts> = MEMORY_SEED) {}

  private entry(caseId: string): JuryCounts {
    let counts = this.counts.get(caseId);
    if (!counts) {
      counts = { ...this.seed };
      this.counts.set(caseId, counts);
    }
    return counts;
  }

  async read(caseId: string): Promise<JuryCounts> {
    return { ...this.entry(caseId) };
  }

  async increment(caseId: string, side: JurySide): Promise<JuryCounts> {
    const counts = this.entry(caseId);
    counts[side] += 1;
    return { ...counts };
  }
}

export class RedisJuryStore implements JuryStore {
  readonly kind = "redis" as const;

  constructor(private readonly redis: Redis) {}

  private key(caseId: string): string {
    return `hncourt:jury:${caseId}`;
  }

  private static parse(raw: Record<string, unknown> | null): JuryCounts {
    const num = (value: unknown) => {
      const n = Number(value ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    return { against: num(raw?.against), witness: num(raw?.witness) };
  }

  async read(caseId: string): Promise<JuryCounts> {
    return RedisJuryStore.parse(await this.redis.hgetall<Record<string, unknown>>(this.key(caseId)));
  }

  async increment(caseId: string, side: JurySide): Promise<JuryCounts> {
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(this.key(caseId), side, 1);
    pipeline.hgetall(this.key(caseId));
    const [, raw] = await pipeline.exec<[number, Record<string, unknown> | null]>();
    return RedisJuryStore.parse(raw);
  }
}

const globalStore = globalThis as typeof globalThis & {
  __hncourtJuryStore?: JuryStore;
  __hncourtMemoryFallback?: MemoryJuryStore;
};

/** Singleton that survives dev hot reloads. */
export function getJuryStore(): JuryStore {
  if (globalStore.__hncourtJuryStore) return globalStore.__hncourtJuryStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  let store: JuryStore;
  if (url && token) {
    store = new RedisJuryStore(new Redis({ url, token }));
  } else {
    if (url && !token) {
      console.warn("[hn-court] UPSTASH_REDIS_REST_URL is set without a token; using in-memory jury store.");
    }
    store = getMemoryFallback();
  }
  globalStore.__hncourtJuryStore = store;
  return store;
}

/** Shared in-memory store, also used when Redis is unreachable. */
export function getMemoryFallback(): MemoryJuryStore {
  globalStore.__hncourtMemoryFallback ??= new MemoryJuryStore();
  return globalStore.__hncourtMemoryFallback;
}

export function toTally(caseId: string, counts: JuryCounts, source: JuryTally["source"]): JuryTally {
  const total = counts.against + counts.witness;
  const againstPct = total === 0 ? 50 : Math.round((counts.against / total) * 100);
  return {
    caseId,
    against: counts.against,
    witness: counts.witness,
    total,
    againstPct,
    witnessPct: 100 - againstPct,
    source,
    updatedAt: new Date().toISOString(),
  };
}

/** Read with graceful degradation: a Redis outage must not take the court down. */
export async function readTally(caseId: string): Promise<JuryTally> {
  const store = getJuryStore();
  try {
    return toTally(caseId, await store.read(caseId), store.kind);
  } catch (error) {
    console.error("[hn-court] jury read failed, serving memory fallback:", error);
    return toTally(caseId, await getMemoryFallback().read(caseId), "memory");
  }
}

export async function castVote(caseId: string, side: JurySide): Promise<JuryTally> {
  const store = getJuryStore();
  try {
    return toTally(caseId, await store.increment(caseId, side), store.kind);
  } catch (error) {
    console.error("[hn-court] jury write failed, recording in memory fallback:", error);
    return toTally(caseId, await getMemoryFallback().increment(caseId, side), "memory");
  }
}
