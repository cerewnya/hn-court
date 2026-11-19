import fs from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { findCase, getCaseReport } from "@/lib/cases";
import { readTally } from "@/lib/juryStore";
import { caseLabel } from "@/lib/site";
import { decodeResult, type Square } from "@/engine/dagRunner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const C = {
  newsprint: "#F6F6EF",
  archival: "#ECECE3",
  card: "#FFFFFF",
  ink: "#141412",
  muted: "#6B6B63",
  hn: "#FF6600",
  crimson: "#D92D20",
  green: "#157F3D",
  stage: "#1B2028",
} as const;

const SQUARE_FILL: Record<Square, string> = {
  critical: C.green,
  sustained: C.hn,
  overruled: C.crimson,
  timeout: C.crimson,
  empty: C.card,
};

type Fonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;

let fontCache: Promise<Fonts> | null = null;

function loadFonts(): Promise<Fonts> {
  fontCache ??= (async () => {
    const dir = path.join(process.cwd(), "assets", "fonts");
    const read = async (file: string) => {
      const buf = await fs.readFile(path.join(dir, file));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    };
    const [mono400, mono700, display800] = await Promise.all([
      read("ibm-plex-mono-latin-400-normal.woff"),
      read("ibm-plex-mono-latin-700-normal.woff"),
      read("barlow-condensed-latin-800-normal.woff"),
    ]);
    return [
      { name: "IBM Plex Mono", data: mono400, weight: 400, style: "normal" },
      { name: "IBM Plex Mono", data: mono700, weight: 700, style: "normal" },
      { name: "Barlow Condensed", data: display800, weight: 800, style: "normal" },
    ] satisfies Fonts;
  })().catch((error: unknown) => {
    fontCache = null;
    console.error("[hn-court] OG fonts unavailable, using defaults:", error);
    return [];
  });
  return fontCache;
}

const spriteCache = new Map<string, Promise<string | null>>();

function loadSprite(src: string): Promise<string | null> {
  let cached = spriteCache.get(src);
  if (!cached) {
    cached = fs
      .readFile(path.join(process.cwd(), "public", src))
      .then((buf) => `data:image/${src.endsWith(".webp") ? "webp" : "png"};base64,${buf.toString("base64")}`)
      .catch(() => null);
    spriteCache.set(src, cached);
  }
  return cached;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const c = findCase(id);
  if (!c) return new Response("Case not found", { status: 404 });

  const url = new URL(request.url);
  const resultParam = url.searchParams.get("r");
  const verdictParam = url.searchParams.get("v");
  const hasResult = resultParam !== null && /^[CSOT_]{1,8}$/i.test(resultParam);
  const squares = decodeResult(hasResult ? resultParam : "", c.rules.maxTurns);
  const outcome = verdictParam === "win" || verdictParam === "lose" ? verdictParam : null;

  const [fonts, sprite, tally] = await Promise.all([
    loadFonts(),
    c.witness.sprite ? loadSprite(c.witness.sprite.src) : Promise.resolve(null),
    readTally(c.id),
  ]);
  const verified = getCaseReport(c).verified;
  const label = caseLabel(c);
  const verdictText =
    outcome === "win" ? c.verdicts.win.label : outcome === "lose" ? c.verdicts.lose.label : "IN SESSION";
  const stampText = outcome === null ? "IN SESSION" : outcome === "win" ? "WITNESS BROKEN" : "OVERRULED";
  const stampColor = outcome === "win" ? C.green : C.crimson;
  const againstWidth = Math.min(88, Math.max(12, tally.againstPct));

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: "flex",
          flexDirection: "column",
          background: C.newsprint,
          color: C.ink,
          fontFamily: "IBM Plex Mono",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 76,
            padding: "0 48px",
            borderBottom: `3px solid ${C.ink}`,
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              height: 40,
              background: C.hn,
              border: `3px solid ${C.ink}`,
              fontSize: 17,
              fontWeight: 700,
            }}
          >
            HN
          </div>
          <div style={{ display: "flex", fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 40 }}>
            HN COURT
          </div>
          <div
            style={{
              display: "flex",
              border: `2px solid ${C.ink}`,
              padding: "4px 12px",
              fontSize: 18,
              letterSpacing: 1,
            }}
          >
            {`${label} • DAILY TRIAL`}
          </div>
          <div style={{ display: "flex", flexGrow: 1 }} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: verified ? C.green : C.crimson,
              color: C.card,
              borderRadius: 999,
              padding: "6px 16px",
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: 1.5,
            }}
          >
            {verified ? "DAG VERIFIED" : "DAG UNVERIFIED"}
          </div>
        </div>

        <div style={{ display: "flex", flexGrow: 1, padding: "36px 48px 28px", gap: 40 }}>
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexBasis: 0, gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div
                style={{
                  display: "flex",
                  fontFamily: "Barlow Condensed",
                  fontWeight: 800,
                  fontSize: 100,
                  lineHeight: 1,
                  letterSpacing: -1,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  display: "flex",
                  border: `3px solid ${stampColor}`,
                  color: stampColor,
                  padding: "2px 12px",
                  fontFamily: "Barlow Condensed",
                  fontWeight: 800,
                  fontSize: 30,
                  letterSpacing: 2,
                  transform: "rotate(-4deg)",
                }}
              >
                {stampText}
              </div>
            </div>
            <div style={{ display: "flex", fontSize: 26, lineHeight: 1.35 }}>{c.title}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              {squares.map((sq, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    width: 52,
                    height: 52,
                    background: SQUARE_FILL[sq],
                    border: `3px solid ${C.ink}`,
                  }}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 24 }}>
              <span>Verdict:</span>
              <span style={{ fontWeight: 700 }}>{verdictText}</span>
            </div>
          </div>

          {sprite ? (
            <div
              style={{
                display: "flex",
                width: 426,
                height: 242,
                border: `3px solid ${C.ink}`,
                boxShadow: `8px 8px 0 ${C.ink}`,
                background: C.stage,
                marginTop: 12,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sprite} width={420} height={236} alt="" style={{ objectFit: "cover" }} />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 426,
                height: 242,
                border: `3px solid ${C.ink}`,
                boxShadow: `8px 8px 0 ${C.ink}`,
                background: C.stage,
                marginTop: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  background: C.card,
                  border: `4px solid ${C.ink}`,
                  padding: "8px 22px",
                  color: C.crimson,
                  fontFamily: "Barlow Condensed",
                  fontWeight: 800,
                  fontSize: 64,
                  transform: "rotate(-6deg)",
                }}
              >
                OBJECTION!
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", padding: "0 48px 32px", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, letterSpacing: 1 }}>
            <span style={{ fontWeight: 700 }}>LIVE GLOBAL JURY</span>
            <span style={{ color: C.muted }}>{`${tally.total.toLocaleString("en-US")} VOTES`}</span>
          </div>
          <div style={{ display: "flex", height: 40, border: `3px solid ${C.ink}` }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                width: `${againstWidth}%`,
                background: C.hn,
                borderRight: `3px solid ${C.ink}`,
                padding: "0 16px",
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              {againstWidth >= 40 ? `${tally.againstPct}% ${c.jury.againstLabel}` : `${tally.againstPct}%`}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                flexGrow: 1,
                background: C.ink,
                color: C.newsprint,
                padding: "0 16px",
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              {`${tally.witnessPct}%`}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts,
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
      },
    },
  );
}
