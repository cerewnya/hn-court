"use client";

import { useMemo } from "react";
import type { Card, CaseFile } from "@/schemas/case";

interface ObjectionHandProps {
  caseFile: CaseFile;
  hand: readonly string[];
  selected: number;
  locked: boolean;
  finished: boolean;
  drawn: number;
  slamPressed: boolean;
  onSelect: (slot: number) => void;
  onSlam: () => void;
  onReset: () => void;
}

export function ObjectionHand({
  caseFile,
  hand,
  selected,
  locked,
  finished,
  drawn,
  slamPressed,
  onSelect,
  onSlam,
  onReset,
}: ObjectionHandProps) {
  const lookup = useMemo(() => {
    const map = new Map<string, { card: Card; index: number }>();
    caseFile.deck.forEach((card, index) => map.set(card.id, { card, index }));
    return map;
  }, [caseFile]);
  const slots = Array.from({ length: caseFile.rules.handSize }, (_, i) => hand[i] ?? null);
  const deckSize = caseFile.deck.length;

  return (
    <>
      <div className="hand" role="group" aria-label="Objection cards" data-testid="hand" data-bounds="hand">
        {slots.map((cardId, slot) => {
          const entry = cardId ? lookup.get(cardId) : undefined;
          if (!entry) {
            return (
              <div key={`empty-${slot}`} className="card card--empty" data-testid={`card-${slot + 1}`}>
                NO EXHIBIT
              </div>
            );
          }
          const { card, index } = entry;
          const isSelected = selected === slot && !finished;
          return (
            <button
              key={card.id}
              type="button"
              className="card"
              aria-pressed={isSelected}
              aria-keyshortcuts={String(slot + 1)}
              aria-label={`${card.title}: ${card.effect}. Power ${card.power}, risk ${card.risk}. Key ${slot + 1}.`}
              disabled={finished}
              data-locked={locked}
              data-testid={`card-${slot + 1}`}
              data-card-id={card.id}
              data-bounds="card"
              onClick={() => onSelect(slot)}
            >
              <div className="card__head">
                <span className="keybind">{slot + 1}</span>
                <span className="card__exhibit">
                  {isSelected ? "SELECTED" : `EXHIBIT ${String.fromCharCode(65 + index)}`}
                </span>
              </div>
              <div className="card__body">
                <div className="card__title">{card.title}</div>
                <div className="card__effect">
                  {card.effect}
                  {isSelected ? ` (-${card.power} composure)` : ""}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="actions" data-bounds="actions">
        <div className="deck" data-testid="deck-counter">
          <div className="deck__pips" aria-hidden="true">
            {Array.from({ length: deckSize }, (_, i) => (
              <span key={i} className="deck__pip" data-drawn={i < drawn} />
            ))}
          </div>
          <span className="deck__label">
            DECK:{" "}
            <strong>
              {Math.min(drawn, deckSize)} / {deckSize}
            </strong>{" "}
            CARDS DRAWN
          </span>
        </div>
        {finished ? (
          <button
            type="button"
            className="slam slam--secondary"
            onClick={onReset}
            data-native-activate
            data-testid="replay"
          >
            NEW TRIAL
            <span className="keycap">R</span>
          </button>
        ) : (
          <button
            type="button"
            className="slam"
            onClick={onSlam}
            disabled={hand.length === 0}
            aria-disabled={locked}
            data-pressed={slamPressed}
            data-native-activate
            data-testid="slam"
          >
            SLAM OBJECTION
            <span className="keycap">SPACE</span>
          </button>
        )}
      </div>
    </>
  );
}
