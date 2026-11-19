"use client";

import { useEffect, useRef, useState } from "react";
import type { Square, TrialState } from "@/engine/dagRunner";
import type { CaseFile } from "@/schemas/case";
import { CopyIcon } from "./icons";
import type { JuryState } from "./useJury";

interface DossierProps {
  caseFile: CaseFile;
  trial: TrialState;
  turnShown: number;
  jury: JuryState;
  share: {
    squares: Square[];
    verdictLabel: string;
    landed: number;
    played: number;
    topPct: number | null;
    displayLink: string;
    text: string;
  };
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to the legacy path (e.g. insecure origin) */
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy command was rejected");
}

function Meter({ label, value, max, tone, testId }: { label: string; value: number; max: number; tone: "good" | "bad"; testId: string }) {
  return (
    <div className="meter" data-testid={testId} data-value={value}>
      <div className="meter__head">
        <span className="meter__label">{label}</span>
        <span className="meter__value" data-tone={tone}>
          {value}/{max}
        </span>
      </div>
      <div
        className="meter__blocks"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className="meter__block" data-on={i < value} data-tone={tone} />
        ))}
      </div>
    </div>
  );
}

export function Dossier({ caseFile, trial, turnShown, jury, share }: DossierProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const finished = trial.status !== "in_session";
  const label = `CASE #${String(caseFile.number).padStart(3, "0")}`;
  const againstWidth = `clamp(56px, ${jury.againstPct}%, calc(100% - 56px))`;

  const copy = async () => {
    try {
      await writeClipboard(share.text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
  };

  return (
    <aside className="dossier" aria-label="Case dossier">
      <div className="case-header" data-bounds="case-header">
        <div className="case-header__row">
          <h1 className="case-number display">{label}</h1>
          <div className="session-stamp display" data-status={trial.status} data-testid="session-stamp">
            {finished ? "ADJOURNED" : "IN SESSION"}
          </div>
        </div>
        <p className="case-title" data-testid="case-title">
          {caseFile.title}
        </p>
        <div className="case-meta">
          item?id={caseFile.source.hnItemId} • filed {caseFile.source.filedAt} • docket {turnShown} of{" "}
          {caseFile.rules.maxTurns}
        </div>
      </div>

      <section className="panel" aria-labelledby="panel-status" data-bounds="panel">
        <div className="panel__header">
          <h2 className="panel__title" id="panel-status">
            01 — TRIAL STATUS
          </h2>
          <span className="panel__aside">
            TURN {turnShown} / {caseFile.rules.maxTurns}
          </span>
        </div>
        <Meter
          label="YOUR CREDIBILITY"
          value={trial.credibility}
          max={caseFile.rules.maxCredibility}
          tone="good"
          testId="meter-credibility"
        />
        <Meter
          label="WITNESS COMPOSURE"
          value={trial.composure}
          max={caseFile.rules.maxComposure}
          tone="bad"
          testId="meter-composure"
        />
      </section>

      <section className="panel" aria-labelledby="panel-jury" data-bounds="panel" data-testid="jury-panel">
        <div className="panel__header">
          <h2 className="panel__title" id="panel-jury">
            02 — LIVE GLOBAL JURY
          </h2>
          <span className="panel__aside">
            <span className="live-dot" />
            LIVE
          </span>
        </div>
        <div className="split" role="img" aria-label={`${jury.againstPct}% ${caseFile.jury.againstLabel}, ${jury.witnessPct}% ${caseFile.jury.witnessLabel}`}>
          <div className="split__seg split__seg--against" style={{ width: againstWidth }}>
            {jury.againstPct}%
          </div>
          <div className="split__seg split__seg--witness">{jury.witnessPct}%</div>
        </div>
        <div className="legend">
          <div className="legend__row">
            <span className="legend__swatch" style={{ background: "var(--accent-hn)" }} />
            <span className="legend__label">
              {caseFile.jury.againstLabel}
              {jury.yourVote === "against" && <span className="legend__you">YOU</span>}
            </span>
            <span className="legend__votes" data-testid="votes-against">
              {jury.against.toLocaleString("en-US")} votes
            </span>
          </div>
          <div className="legend__row">
            <span className="legend__swatch" style={{ background: "var(--ink-primary)" }} />
            <span className="legend__label">
              {caseFile.jury.witnessLabel}
              {jury.yourVote === "witness" && <span className="legend__you">YOU</span>}
            </span>
            <span className="legend__votes" data-testid="votes-witness">
              {jury.witness.toLocaleString("en-US")} votes
            </span>
          </div>
        </div>
        <div className="jury-note">
          Updates live every 30s • {jury.total.toLocaleString("en-US")} votes today
        </div>
      </section>

      <section className="panel panel--share" aria-labelledby="panel-share" data-bounds="panel" data-testid="share-panel">
        <div className="panel__header">
          <h2 className="panel__title" id="panel-share">
            03 — SHARE YOUR VERDICT
          </h2>
          <span className="panel__aside">{finished ? "READY" : "PREVIEW"}</span>
        </div>
        <div className="snippet" data-testid="share-snippet">
          <div className="snippet__head">
            <span className="snippet__title">HN Court #{caseFile.number}{"  "}|</span>
            <span className="squares" aria-label="Objection results">
              {share.squares.map((sq, i) => (
                <span key={i} className="square" data-kind={sq} />
              ))}
            </span>
          </div>
          <div className="snippet__line" data-testid="share-verdict">
            Verdict: <strong>{share.verdictLabel}</strong>
          </div>
          <div className="snippet__line">
            Objections: {share.landed}/{share.played} • Top {share.topPct === null ? "—" : `${share.topPct}%`}
          </div>
          <div className="snippet__link">{share.displayLink}</div>
        </div>
        <button
          type="button"
          className="copy-btn"
          onClick={copy}
          data-state={copyState}
          data-native-activate
          data-testid="copy-share"
        >
          <CopyIcon />
          {copyState === "copied" ? "COPIED — PASTE IT ANYWHERE" : copyState === "error" ? "COPY FAILED" : "COPY FOR SLACK / X"}
        </button>
        <span className="sr-only" aria-live="polite">
          {copyState === "copied" ? "Verdict copied to clipboard" : ""}
        </span>
      </section>
    </aside>
  );
}
