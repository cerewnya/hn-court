"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chiptune } from "@/engine/chiptune";
import type { CaseFile, CaseNode } from "@/schemas/case";

const CHAR_MS = 20;

interface TestimonyProps {
  caseFile: CaseFile;
  node: CaseNode;
  reducedMotion: boolean;
}

function sourceLine(caseFile: CaseFile, node: CaseNode): string {
  const sep = "  •  ";
  if (node.kind === "verdict") {
    return node.author === "THE_COURT"
      ? `THE COURT${sep}final ruling${sep}${caseFile.source.commentCount} comments`
      : `@${node.author}${sep}final statement${sep}depth ${caseFile.source.maxDepth}`;
  }
  const flip = (node.sentimentFlip ?? caseFile.source.sentimentFlip).toFixed(2);
  return `@${node.author}${sep}${caseFile.source.commentCount} comments / ${caseFile.source.points} pts${sep}sentiment flip: ${flip}`;
}

/** Verbatim testimony with a typewriter reveal and chiptune blips. */
export function Testimony({ caseFile, node, reducedMotion }: TestimonyProps) {
  const text = node.text;
  const [shown, setShown] = useState(text.length);
  const lastNode = useRef(node.id);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    // The first testimony renders in full (it is server-rendered); only
    // subsequent testimony types out.
    if (lastNode.current === node.id) return;
    lastNode.current = node.id;
    stop();
    if (reducedMotion) {
      setShown(text.length);
      return;
    }
    const pitch = node.kind === "verdict" && node.author === "THE_COURT" ? 0.7 : 1;
    let i = 0;
    setShown(0);
    timer.current = window.setInterval(() => {
      i += 1;
      setShown(i);
      const ch = text[i - 1];
      if (ch && ch.trim() && i % 2 === 0) chiptune.blip(pitch);
      if (i >= text.length) stop();
    }, CHAR_MS);
    return stop;
  }, [node, text, reducedMotion, stop]);

  const typing = shown < text.length;
  const skip = () => {
    if (!typing) return;
    stop();
    setShown(text.length);
  };

  const label =
    node.kind === "verdict" ? (node.outcome === "win" ? "WITNESS BROKEN" : "RULING") : "VERBATIM TESTIMONY";
  const labelKind = node.kind === "verdict" ? node.outcome : "testimony";

  return (
    <section
      className="testimony"
      aria-label="Witness testimony"
      data-typing={typing}
      data-node-id={node.id}
      data-testid="testimony"
      data-bounds="testimony"
      onClick={skip}
    >
      <div className="testimony__meta">
        <div className="testimony__source" data-testid="testimony-source">
          {sourceLine(caseFile, node)}
        </div>
        <div className="testimony__label" data-kind={labelKind}>
          {label}
        </div>
      </div>
      <blockquote className="testimony__quote">
        <span aria-hidden="true">
          “{text.slice(0, shown)}
          {typing ? "" : "”"}
        </span>
        {typing && <span className="testimony__caret" aria-hidden="true" />}
        {typing && (
          <span className="testimony__ghost" aria-hidden="true">
            {text.slice(shown)}”
          </span>
        )}
        <span className="sr-only" data-testid="testimony-text">
          “{text}”
        </span>
      </blockquote>
    </section>
  );
}
