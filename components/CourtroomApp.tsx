"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chiptune } from "@/engine/chiptune";
import {
  applyMove,
  buildShareText,
  createTrial,
  currentNode,
  encodeResult,
  getCard,
  movesOf,
  objectionTally,
  replay,
  scoreTrial,
  topPercent,
  verdictSquares,
  type Move,
  type TrialState,
  type TurnRecord,
} from "@/engine/dagRunner";
import type { CaseReportSummary } from "@/lib/cases";
import type { JuryTally } from "@/lib/juryStore";
import type { CaseFile } from "@/schemas/case";
import { CourtroomViewport, type RulingBanner, type VerdictCue, type ViewportHandle } from "./CourtroomViewport";
import { Dossier } from "./Dossier";
import { ObjectionHand } from "./ObjectionHand";
import { Testimony } from "./Testimony";
import { TopBar } from "./TopBar";
import { useJury } from "./useJury";

const STORAGE_PREFIX = "hncourt:v1:trial:";
const OBJECTION_MS = 1100;
const REDUCED_OBJECTION_MS = 140;
const BANNER_MS = 3800;

type Phase = "idle" | "objecting";

interface CourtroomAppProps {
  caseFile: CaseFile;
  report: CaseReportSummary;
  initialTally: JuryTally;
  siteOrigin: string | null;
}

const MINUS = "−";
const signed = (n: number) => (n > 0 ? `+${n}` : `${MINUS}${Math.abs(n)}`);

function makeBanner(c: CaseFile, record: TurnRecord, key: number): RulingBanner {
  const title =
    record.ruling === "critical"
      ? "SUSTAINED — CRITICAL HIT"
      : record.ruling === "sustained"
        ? "SUSTAINED"
        : record.ruling === "overruled"
          ? "OVERRULED"
          : "TIME! OBJECTION WAIVED";
  const effects: string[] = [];
  if (record.composureDelta !== 0) effects.push(`${signed(record.composureDelta)} COMPOSURE`);
  if (record.credibilityDelta !== 0) effects.push(`${signed(record.credibilityDelta)} CREDIBILITY`);
  let note = record.note;
  if (record.struckCardId) {
    const struck = `Exhibit struck from the record: ${getCard(c, record.struckCardId).title}.`;
    note = note ? `${note} ${struck}` : struck;
  }
  return { key, ruling: record.ruling, title, effects: effects.join(" · "), note };
}

function storageKey(c: CaseFile) {
  return `${STORAGE_PREFIX}${c.id}`;
}

function loadSaved(c: CaseFile): TrialState | null {
  try {
    const raw = window.localStorage.getItem(storageKey(c));
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    const moves = (saved as { moves?: unknown }).moves;
    if (!Array.isArray(moves)) return null;
    return replay(c, moves as Move[]);
  } catch {
    // Corrupt or stale (the case changed): start fresh.
    return null;
  }
}

function persist(c: CaseFile, s: TrialState | null) {
  try {
    if (s === null || s.history.length === 0) window.localStorage.removeItem(storageKey(c));
    else window.localStorage.setItem(storageKey(c), JSON.stringify({ moves: movesOf(s), savedAt: new Date().toISOString() }));
  } catch {
    /* private mode: progress lasts for this tab only */
  }
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

export function CourtroomApp({ caseFile, report, initialTally, siteOrigin }: CourtroomAppProps) {
  const [trial, setTrialState] = useState<TrialState>(() => createTrial(caseFile));
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [selected, setSelectedState] = useState(0);
  const [banner, setBanner] = useState<RulingBanner | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(caseFile.rules.turnSeconds);
  const [clockStarted, setClockStarted] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [verdictAnimate, setVerdictAnimate] = useState(true);
  const [slamPressed, setSlamPressed] = useState(false);
  const [origin, setOrigin] = useState(siteOrigin ?? "https://hncourt.dev");

  const reducedMotion = useReducedMotion();
  const muted = useSyncExternalStore(chiptune.subscribe, chiptune.isMuted, () => false);
  const { jury, castVote } = useJury(caseFile.id, initialTally);

  const trialRef = useRef(trial);
  const phaseRef = useRef<Phase>("idle");
  const selectedRef = useRef(0);
  const timers = useRef<number[]>([]);
  const bannerKey = useRef(0);
  const viewportRef = useRef<ViewportHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const setTrial = useCallback((next: TrialState) => {
    trialRef.current = next;
    setTrialState(next);
  }, []);
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setSelected = useCallback((slot: number) => {
    selectedRef.current = slot;
    setSelectedState(slot);
  }, []);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  // Restore a trial in progress (or a finished one) for this case.
  useEffect(() => {
    const saved = loadSaved(caseFile);
    if (saved) {
      setVerdictAnimate(false);
      setTrial(saved);
      setSelected(0);
    }
    if (!siteOrigin) setOrigin(window.location.origin);
    setHydrated(true);
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, [caseFile, setTrial, setSelected, siteOrigin]);

  // Pause the clock when the tab is hidden; start it on the first gesture.
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    const onFirstGesture = () => {
      setClockStarted(true);
      chiptune.unlock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onFirstGesture, { once: true });
    window.addEventListener("keydown", onFirstGesture, { once: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
    };
  }, []);

  const commit = useCallback(
    (move: Move) => {
      const current = trialRef.current;
      if (phaseRef.current !== "idle" || current.status !== "in_session") return;
      let result: ReturnType<typeof applyMove>;
      try {
        result = applyMove(caseFile, current, move);
      } catch (error) {
        console.error("[hn-court] illegal move:", error);
        return;
      }
      setPhase("objecting");
      setBanner(null);
      setClockStarted(true);
      chiptune.unlock();
      if (move.type === "play") {
        chiptune.gavel();
        viewportRef.current?.objection();
        setSlamPressed(true);
        later(() => setSlamPressed(false), 140);
      } else {
        chiptune.overruled();
        viewportRef.current?.notice("TIME!");
      }

      later(
        () => {
          const { state: next, record } = result;
          setVerdictAnimate(true);
          setTrial(next);
          persist(caseFile, next);
          bannerKey.current += 1;
          setBanner(makeBanner(caseFile, record, bannerKey.current));
          if (record.ruling === "critical" || record.ruling === "sustained") {
            chiptune.sustained(record.ruling === "critical");
          }
          if (next.status === "in_session") {
            viewportRef.current?.holdIt();
            later(() => chiptune.holdIt(), 260);
          } else {
            later(() => (next.status === "won" ? chiptune.victory() : chiptune.defeat()), 320);
          }
          setSelected(Math.min(selectedRef.current, Math.max(0, next.hand.length - 1)));
          setSecondsLeft(caseFile.rules.turnSeconds);
          setPhase("idle");
        },
        reducedMotion ? REDUCED_OBJECTION_MS : OBJECTION_MS,
      );
    },
    [caseFile, later, reducedMotion, setPhase, setSelected, setTrial],
  );

  const selectSlot = useCallback(
    (slot: number) => {
      const current = trialRef.current;
      if (current.status !== "in_session" || phaseRef.current !== "idle") return;
      if (slot < 0 || slot >= current.hand.length) return;
      setClockStarted(true);
      if (slot !== selectedRef.current) chiptune.select();
      setSelected(slot);
    },
    [setSelected],
  );

  const slam = useCallback(() => {
    const cardId = trialRef.current.hand[selectedRef.current];
    if (cardId) commit({ type: "play", cardId });
  }, [commit]);

  const resetTrial = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    persist(caseFile, null);
    setTrial(createTrial(caseFile));
    setPhase("idle");
    setSelected(0);
    setBanner(null);
    setSecondsLeft(caseFile.rules.turnSeconds);
    setVerdictAnimate(true);
  }, [caseFile, setPhase, setSelected, setTrial]);

  // Keyboard: [1]-[4] select, [SPACE] slam, [M] mute, [R] new trial.
  useEffect(() => {
    const isTyping = (el: Element | null) =>
      el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const nativeButton = (el: Element | null) => el instanceof HTMLElement && el.closest("[data-native-activate]") !== null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as Element | null;
      if (isTyping(target)) return;
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        selectSlot(Number(event.key) - 1);
        return;
      }
      if (event.key === " " || event.code === "Space") {
        if (nativeButton(target)) return;
        event.preventDefault();
        if (!event.repeat) slam();
        return;
      }
      if (event.key === "Enter" && (target === document.body || target === null)) {
        event.preventDefault();
        slam();
        return;
      }
      if (event.key === "m" || event.key === "M") {
        chiptune.toggle();
        return;
      }
      if ((event.key === "r" || event.key === "R") && trialRef.current.status !== "in_session") {
        resetTrial();
      }
    };
    // Stop a focused card from also "clicking" when Space is released.
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.key === " " || event.code === "Space") && !nativeButton(event.target as Element | null)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [resetTrial, selectSlot, slam]);

  // Turn clock.
  const inSession = trial.status === "in_session";
  const clockRunning = hydrated && clockStarted && pageVisible && phase === "idle" && inSession;
  useEffect(() => {
    if (!clockRunning) return;
    const id = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [clockRunning]);
  useEffect(() => {
    if (!clockRunning) return;
    if (secondsLeft <= 0) commit({ type: "timeout" });
    else if (secondsLeft <= 10) chiptune.tick();
  }, [clockRunning, commit, secondsLeft]);

  // Banner auto-dismiss.
  useEffect(() => {
    if (!banner) return;
    const id = window.setTimeout(() => setBanner(null), BANNER_MS);
    return () => window.clearTimeout(id);
  }, [banner]);

  // A finished trial is this juror's vote in the global jury.
  useEffect(() => {
    if (!hydrated || trial.status === "in_session") return;
    void castVote(trial.status === "won" ? "against" : "witness");
  }, [castVote, hydrated, trial.status]);

  const node = currentNode(caseFile, trial);
  const turnsDone = trial.history.length;
  const turnShown = inSession ? trial.turn : Math.max(1, turnsDone);
  const depth = node.kind === "testimony" ? node.depth : caseFile.source.maxDepth;

  const verdict: VerdictCue | null = useMemo(() => {
    if (node.kind !== "verdict") return null;
    return { outcome: node.outcome, stamp: node.stamp, animate: verdictAnimate };
  }, [node, verdictAnimate]);

  const share = useMemo(() => {
    const finished = trial.status !== "in_session";
    const verdictLabel =
      trial.status === "won"
        ? caseFile.verdicts.win.label
        : trial.status === "lost"
          ? caseFile.verdicts.lose.label
          : "IN SESSION";
    const topPct = finished ? topPercent(report.scoreHistogram, scoreTrial(caseFile, trial)) : null;
    const base = `${origin}/${caseFile.number}`;
    const url = finished
      ? `${base}?r=${encodeResult(caseFile, trial)}&v=${trial.status === "won" ? "win" : "lose"}`
      : base;
    const { landed, played } = objectionTally(trial);
    return {
      squares: verdictSquares(caseFile, trial),
      verdictLabel,
      landed,
      played,
      topPct,
      displayLink: base.replace(/^https?:\/\//, ""),
      text: buildShareText(caseFile, trial, { url, topPct, verdictLabel }),
    };
  }, [caseFile, origin, report.scoreHistogram, trial]);

  const verifiedDetail = `${report.winningRoutes} winning routes • ${report.totalPaths.toLocaleString("en-US")} paths solved • ${report.softlocks} softlocks`;

  return (
    <div
      className="app"
      data-testid="app"
      data-phase={phase}
      data-status={trial.status}
      data-turn={turnShown}
      data-hydrated={hydrated}
    >
      <TopBar
        caseNumber={caseFile.number}
        turnShown={turnShown}
        maxTurns={caseFile.rules.maxTurns}
        turnsDone={turnsDone}
        status={trial.status}
        secondsLeft={secondsLeft}
        clockRunning={clockRunning}
        muted={muted}
        onToggleMute={() => chiptune.toggle()}
        juryTotal={jury.total}
        verified={report.verified}
        verifiedDetail={verifiedDetail}
      />
      <main className="main">
        <div className="trial">
          <div className="stage" ref={stageRef}>
            <CourtroomViewport
              ref={viewportRef}
              caseFile={caseFile}
              composure={trial.composure}
              depth={depth}
              turn={turnShown}
              verdict={verdict}
              banner={banner}
              reducedMotion={reducedMotion}
              shakeTarget={stageRef}
            />
            <Testimony caseFile={caseFile} node={node} reducedMotion={reducedMotion} />
          </div>
          <ObjectionHand
            caseFile={caseFile}
            hand={trial.hand}
            selected={selected}
            locked={phase !== "idle"}
            finished={!inSession}
            drawn={trial.drawIndex}
            slamPressed={slamPressed}
            onSelect={selectSlot}
            onSlam={slam}
            onReset={resetTrial}
          />
        </div>
        <Dossier caseFile={caseFile} trial={trial} turnShown={turnShown} jury={jury} share={share} />
      </main>
      <div className="sr-only" aria-live="polite" data-testid="announcer">
        {banner ? `${banner.title}. ${banner.effects}. ${banner.note ?? ""}` : ""}
      </div>
    </div>
  );
}
