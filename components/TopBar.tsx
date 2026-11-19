import type { TrialStatus } from "@/engine/dagRunner";
import { CheckIcon, MusicIcon, MutedIcon } from "./icons";

export interface TopBarProps {
  caseNumber: number;
  turnShown: number;
  maxTurns: number;
  turnsDone: number;
  status: TrialStatus;
  secondsLeft: number;
  clockRunning: boolean;
  muted: boolean;
  onToggleMute: () => void;
  juryTotal: number;
  verified: boolean;
  verifiedDetail: string;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function TopBar(props: TopBarProps) {
  const {
    caseNumber,
    turnShown,
    maxTurns,
    turnsDone,
    status,
    secondsLeft,
    clockRunning,
    muted,
    onToggleMute,
    juryTotal,
    verified,
    verifiedDetail,
  } = props;
  const adjourned = status !== "in_session";
  const label = `CASE #${String(caseNumber).padStart(3, "0")}`;

  return (
    <header className="topbar" data-bounds="topbar">
      <div className="topbar__brand">
        <div className="hn-badge" aria-hidden="true">
          HN
        </div>
        <div className="logo display">HN COURT</div>
        <div className="case-tag">{label} • DAILY TRIAL</div>
      </div>

      <div className="topbar__progress">
        <div className="step-tracker">
          <span className="step-label" data-testid="turn-indicator">
            CROSS-EXAMINATION{" "}
            <strong>
              {turnShown} / {maxTurns}
            </strong>
          </span>
          <div className="step-pips" aria-hidden="true">
            {Array.from({ length: maxTurns }, (_, i) => {
              const n = i + 1;
              const state = n <= turnsDone ? "done" : !adjourned && n === turnShown ? "current" : "todo";
              return <span key={n} className="step-pip" data-state={state} />;
            })}
          </div>
        </div>
        <div
          className="timer"
          role="timer"
          aria-live="off"
          aria-label={adjourned ? "Trial adjourned" : `${formatClock(secondsLeft)} left this turn`}
          data-testid="timer"
          data-urgent={!adjourned && clockRunning && secondsLeft <= 10}
          data-paused={!adjourned && !clockRunning}
          data-adjourned={adjourned}
        >
          <span className="timer__dot" />
          {adjourned ? "ADJOURNED" : formatClock(secondsLeft)}
        </div>
      </div>

      <div className="topbar__meta">
        <button
          type="button"
          className="chip-toggle"
          aria-pressed={!muted}
          aria-label={`Chiptune sound ${muted ? "off" : "on"}`}
          title="Toggle chiptune (M)"
          onClick={onToggleMute}
          data-native-activate
          data-testid="chiptune-toggle"
        >
          <span className="chip-toggle__icon">{muted ? <MutedIcon /> : <MusicIcon />}</span>
          <span className="chip-toggle__label">
            CHIPTUNE: <strong>{muted ? "OFF" : "ON"}</strong>
          </span>
        </button>
        <div className="jury-online" data-testid="jury-online">
          <span className="live-dot" />
          <span>
            <strong>{juryTotal.toLocaleString("en-US")}</strong> JURY ONLINE
          </span>
        </div>
        <div className="dag-pill" data-verified={verified} title={verifiedDetail} data-testid="dag-pill">
          <CheckIcon />
          {verified ? "DAG VERIFIED" : "DAG UNVERIFIED"}
        </div>
      </div>
    </header>
  );
}
