import fs from "node:fs";
import path from "node:path";
import { safeParseCase, type CaseFile } from "@/schemas/case";
import { solveCase } from "@/engine/dagRunner";

/**
 * Server-side case registry. Cases are discovered from `content/cases/*.json`
 * at runtime so the daily data-only PR never has to touch code.
 */

export const CASES_DIR = path.join(process.cwd(), "content", "cases");

export interface CaseLoadError {
  file: string;
  issues: string[];
}

interface Registry {
  cases: CaseFile[];
  errors: CaseLoadError[];
  signature: string;
}

let registry: Registry | null = null;

function directorySignature(files: string[]): string {
  return files
    .map((file) => `${file}:${fs.statSync(path.join(CASES_DIR, file)).mtimeMs}`)
    .join("|");
}

function loadRegistry(): Registry {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(CASES_DIR)
      .filter((file) => /^case-\d{3}\.json$/.test(file))
      .sort();
  } catch (error) {
    return {
      cases: [],
      errors: [{ file: CASES_DIR, issues: [(error as Error).message] }],
      signature: "missing",
    };
  }

  const signature = directorySignature(files);
  if (registry && registry.signature === signature) return registry;

  const cases: CaseFile[] = [];
  const errors: CaseLoadError[] = [];
  for (const file of files) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), "utf8"));
      const result = safeParseCase(raw);
      if (!result.success) {
        errors.push({ file, issues: result.issues });
        continue;
      }
      if (`${result.data.id}.json` !== file) {
        errors.push({ file, issues: [`file name must match id (${result.data.id}.json)`] });
        continue;
      }
      cases.push(result.data);
    } catch (error) {
      errors.push({ file, issues: [(error as Error).message] });
    }
  }
  for (const error of errors) {
    console.error(`[hn-court] skipped ${error.file}:\n  - ${error.issues.join("\n  - ")}`);
  }

  cases.sort((a, b) => b.number - a.number);
  registry = { cases, errors, signature };
  return registry;
}

/** All valid cases, newest first. */
export function listCases(): CaseFile[] {
  return loadRegistry().cases;
}

export function caseLoadErrors(): CaseLoadError[] {
  return loadRegistry().errors;
}

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

/** A case is released once its docket date has arrived (UTC). */
export function isReleased(c: CaseFile, now = new Date()): boolean {
  return c.date <= todayUtc(now);
}

/**
 * Today's trial: the newest released case. If every case is future-dated
 * (e.g. a clock-skewed preview), fall back to the earliest one so the site
 * always has something in session.
 */
export function getActiveCase(now = new Date()): CaseFile | null {
  const cases = listCases();
  const released = cases.filter((c) => isReleased(c, now));
  if (released.length > 0) return released[0] ?? null;
  return cases[cases.length - 1] ?? null;
}

/** Accepts "case-014", "014" or "14". Unreleased cases are never served. */
export function findCase(param: string, now = new Date()): CaseFile | null {
  const match = /^(?:case-)?(\d{1,4})$/.exec(param.trim().toLowerCase());
  if (!match) return null;
  const number = Number(match[1]);
  const found = listCases().find((c) => c.number === number) ?? null;
  if (!found) return null;
  const active = getActiveCase(now);
  return isReleased(found, now) || found.id === active?.id ? found : null;
}

export interface CaseReportSummary {
  verified: boolean;
  winningRoutes: number;
  totalPaths: number;
  softlocks: number;
  scoreHistogram: Array<[number, number]>;
}

const reportCache = new Map<string, { signature: string; report: CaseReportSummary }>();

/** Solver summary used for the DAG VERIFIED pill and the share percentile. */
export function getCaseReport(c: CaseFile): CaseReportSummary {
  const signature = `${c.id}:${c.nodes.length}:${c.edges.length}:${loadRegistry().signature}`;
  const cached = reportCache.get(c.id);
  if (cached && cached.signature === signature) return cached.report;
  const report = solveCase(c);
  const summary: CaseReportSummary = {
    verified: report.verified,
    winningRoutes: report.winningRoutes.length,
    totalPaths: report.totalPaths,
    softlocks: report.softlocks.length,
    scoreHistogram: report.scoreHistogram,
  };
  reportCache.set(c.id, { signature, report: summary });
  return summary;
}
