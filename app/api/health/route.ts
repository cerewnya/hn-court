import { NextResponse } from "next/server";
import { getActiveCase, listCases } from "@/lib/cases";

export const dynamic = "force-dynamic";

export function GET() {
  const casesLoaded = listCases().length;
  const activeCase = getActiveCase()?.id ?? null;
  const healthy = activeCase !== null;
  return NextResponse.json(
    { status: healthy ? "ok" : "error", activeCase, casesLoaded },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
