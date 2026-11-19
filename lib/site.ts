import type { Metadata } from "next";
import type { CaseFile } from "@/schemas/case";

/** Canonical origin for metadata and share links. */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function caseLabel(c: CaseFile): string {
  return `CASE #${String(c.number).padStart(3, "0")}`;
}

const RESULT_PATTERN = /^[CSOT_]{1,8}$/i;

/** Builds page metadata; `r`/`v` come from a shared result link and stay spoiler-free. */
export function caseMetadata(
  c: CaseFile,
  search: { r?: string | string[]; v?: string | string[] } = {},
): Metadata {
  const r = typeof search.r === "string" && RESULT_PATTERN.test(search.r) ? search.r.toUpperCase() : null;
  const v = search.v === "win" || search.v === "lose" ? search.v : null;
  const params = new URLSearchParams();
  if (r) params.set("r", r);
  if (v) params.set("v", v);
  const query = params.toString();
  const image = `/api/og/${c.id}${query ? `?${query}` : ""}`;
  const title = `${caseLabel(c)} — ${c.title}`;
  const description = v
    ? `A juror ${v === "win" ? "broke the witness" : "lost the cross-examination"} in today's HN Court. Can you do better?`
    : "Today's daily trial: cross-examine a heated Hacker News thread with objection cards.";
  return {
    title,
    description,
    alternates: { canonical: `/${c.number}` },
    openGraph: {
      type: "website",
      title,
      description,
      url: `/${c.number}`,
      siteName: "HN Court",
      images: [{ url: image, width: 1200, height: 630, alt: `HN Court ${caseLabel(c)} verdict card` }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
