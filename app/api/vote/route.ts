import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { findCase, getActiveCase } from "@/lib/cases";
import { castVote, readTally } from "@/lib/juryStore";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const VOTE_COOKIE_MAX_AGE = 60 * 60 * 24 * 14;

const VoteBody = z
  .object({
    caseId: z.string().regex(/^case-\d{3}$/),
    side: z.enum(["against", "witness"]),
  })
  .strict();

const cookieName = (caseId: string) => `hnc_vote_${caseId.replace(/[^a-z0-9-]/g, "")}`;

function error(status: number, message: string) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

/** GET /api/vote?caseId=case-014 → current global jury split. */
export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get("caseId");
  const target = param ? findCase(param) : getActiveCase();
  if (!target) return error(404, "unknown case");
  const tally = await readTally(target.id);
  const voted = request.cookies.get(cookieName(target.id))?.value ?? null;
  return NextResponse.json({ ...tally, yourVote: voted }, { headers: NO_STORE });
}

/** POST /api/vote { caseId, side } → records one vote per juror per case. */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "body must be JSON");
  }
  const parsed = VoteBody.safeParse(body);
  if (!parsed.success) return error(400, "expected { caseId: 'case-NNN', side: 'against' | 'witness' }");

  const target = findCase(parsed.data.caseId);
  if (!target) return error(404, "unknown case");

  const name = cookieName(target.id);
  const previous = request.cookies.get(name)?.value;
  if (previous === "against" || previous === "witness") {
    const tally = await readTally(target.id);
    return NextResponse.json(
      { ...tally, accepted: false, reason: "already_voted", yourVote: previous },
      { headers: NO_STORE },
    );
  }

  const tally = await castVote(target.id, parsed.data.side);
  const response = NextResponse.json(
    { ...tally, accepted: true, yourVote: parsed.data.side },
    { status: 201, headers: NO_STORE },
  );
  response.cookies.set(name, parsed.data.side, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: VOTE_COOKIE_MAX_AGE,
  });
  return response;
}
