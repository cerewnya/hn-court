import type { Metadata } from "next";
import { CourtSession, EmptyDocket } from "@/components/CourtSession";
import { getActiveCase } from "@/lib/cases";
import { caseMetadata } from "@/lib/site";

// The active case rolls over at 00:00 UTC without a redeploy.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const active = getActiveCase();
  return active ? caseMetadata(active) : { title: "No trial in session" };
}

export default function HomePage() {
  const active = getActiveCase();
  if (!active) return <EmptyDocket />;
  return <CourtSession caseFile={active} />;
}
