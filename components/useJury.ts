"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JurySide, JuryTally } from "@/lib/juryStore";

export interface JuryState extends JuryTally {
  yourVote: JurySide | null;
}

interface JuryResponse extends JuryTally {
  yourVote?: JurySide | null;
  accepted?: boolean;
}

const POLL_MS = 30_000;

function isTally(value: unknown): value is JuryResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.against === "number" && typeof v.witness === "number" && typeof v.total === "number";
}

/** Live global jury split: polls every 30s and casts this juror's single vote. */
export function useJury(caseId: string, initial: JuryTally) {
  const [state, setState] = useState<JuryState>({ ...initial, yourVote: null });
  const yourVoteRef = useRef<JurySide | null>(null);
  const inflight = useRef(false);

  const apply = useCallback((data: JuryResponse) => {
    const vote = data.yourVote === "against" || data.yourVote === "witness" ? data.yourVote : null;
    if (vote) yourVoteRef.current = vote;
    setState((prev) => ({ ...prev, ...data, yourVote: vote ?? prev.yourVote }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/vote?caseId=${encodeURIComponent(caseId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (isTally(data)) apply(data);
    } catch {
      /* offline: keep the last tally */
    }
  }, [apply, caseId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const castVote = useCallback(
    async (side: JurySide) => {
      if (yourVoteRef.current || inflight.current) return;
      inflight.current = true;
      try {
        const res = await fetch("/api/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseId, side }),
        });
        const data: unknown = await res.json();
        if (res.ok && isTally(data)) apply({ ...data, yourVote: data.yourVote ?? side });
      } catch {
        /* the next poll will reconcile */
      } finally {
        inflight.current = false;
      }
    },
    [apply, caseId],
  );

  return { jury: state, castVote, refresh };
}
