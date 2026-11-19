import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CourtSession } from "@/components/CourtSession";
import { findCase } from "@/lib/cases";
import { caseMetadata } from "@/lib/site";

export const dynamic = "force-dynamic";

interface CasePageProps {
  params: Promise<{ num: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function resolve(num: string) {
  return /^\d{1,4}$/.test(num) ? findCase(num) : null;
}

export async function generateMetadata({ params, searchParams }: CasePageProps): Promise<Metadata> {
  const [{ num }, search] = await Promise.all([params, searchParams]);
  const found = resolve(num);
  return found ? caseMetadata(found, { r: search.r, v: search.v }) : { title: "Case not found" };
}

export default async function CasePage({ params }: CasePageProps) {
  const { num } = await params;
  const found = resolve(num);
  if (!found) notFound();
  return <CourtSession caseFile={found} />;
}
