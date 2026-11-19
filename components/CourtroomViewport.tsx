"use client";

import { useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from "react";
import { CourtroomRenderer } from "@/engine/courtroomCanvas";
import type { TurnRuling } from "@/engine/dagRunner";
import type { CaseFile } from "@/schemas/case";

export interface ViewportHandle {
  objection(): void;
  holdIt(): void;
  notice(text: string): void;
}

export interface RulingBanner {
  key: number;
  ruling: TurnRuling;
  title: string;
  effects: string;
  note: string | null;
}

export interface VerdictCue {
  outcome: "win" | "lose";
  stamp: string;
  animate: boolean;
}

interface CourtroomViewportProps {
  ref?: Ref<ViewportHandle>;
  caseFile: CaseFile;
  composure: number;
  depth: number;
  turn: number;
  verdict: VerdictCue | null;
  banner: RulingBanner | null;
  reducedMotion: boolean;
  shakeTarget: RefObject<HTMLElement | null>;
}

export function CourtroomViewport({
  ref,
  caseFile,
  composure,
  depth,
  turn,
  verdict,
  banner,
  reducedMotion,
  shakeTarget,
}: CourtroomViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CourtroomRenderer | null>(null);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const { palette, sprite, handle } = caseFile.witness;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const displayFont = getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim();
    let renderer: CourtroomRenderer;
    try {
      renderer = new CourtroomRenderer(canvas, {
        palette,
        sprite: sprite ?? null,
        displayFont,
        reducedMotion: reducedRef.current,
        shakeElement: shakeTarget.current,
      });
    } catch (error) {
      console.error("[hn-court] canvas unavailable:", error);
      return;
    }
    rendererRef.current = renderer;
    renderer.start();
    if (displayFont && "fonts" in document) {
      void document.fonts.load(`800 48px ${displayFont}`).catch(() => undefined);
    }
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
    // The renderer is per case; palette/sprite are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseFile.id]);

  useEffect(() => {
    rendererRef.current?.setOptions({ reducedMotion });
  }, [reducedMotion]);

  useEffect(() => {
    rendererRef.current?.setStress(composure, caseFile.rules.maxComposure);
  }, [composure, caseFile.rules.maxComposure, caseFile.id]);

  const verdictOutcome = verdict?.outcome ?? null;
  const verdictStamp = verdict?.stamp ?? null;
  const verdictAnimate = verdict?.animate ?? false;
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (verdictOutcome && verdictStamp) renderer.verdict(verdictOutcome, verdictStamp, verdictAnimate);
    else renderer.reset();
  }, [verdictOutcome, verdictStamp, verdictAnimate, caseFile.id]);

  useImperativeHandle(
    ref,
    () => ({
      objection: () => rendererRef.current?.objection(),
      holdIt: () => rendererRef.current?.holdIt(),
      notice: (text: string) => rendererRef.current?.notice(text),
    }),
    [],
  );

  return (
    <div
      className="viewport"
      data-testid="courtroom-viewport"
      style={sprite ? { backgroundImage: `url(${sprite.src})` } : undefined}
    >
      <canvas
        ref={canvasRef}
        className="viewport__canvas"
        role="img"
        aria-label={`Pixel-art courtroom: witness @${handle} at the oak stand`}
      />
      <div className="heated-tag" data-testid="heated-tag">
        <span className="heated-tag__dot" />
        HEATED THREAD • DEPTH {depth}
      </div>
      <div className="holdit-tag" aria-hidden="true">
        <span className="holdit-tag__accent">HOLD IT!</span>
        <span>• TURN {turn}</span>
      </div>
      {banner && (
        <div className="ruling" key={banner.key} data-testid="ruling-banner" data-ruling={banner.ruling}>
          <div className="ruling__head">
            <span className="ruling__verdict" data-ruling={banner.ruling}>
              {banner.title}
            </span>
            {banner.effects && <span className="ruling__effects">{banner.effects}</span>}
          </div>
          {banner.note && <div className="ruling__note">{banner.note}</div>}
        </div>
      )}
    </div>
  );
}
