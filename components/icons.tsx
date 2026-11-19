export function MusicIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M3 1h6v6.2" fill="none" stroke="var(--ink-primary)" strokeWidth="1.5" />
      <rect x="0.5" y="6" width="3" height="3" fill="var(--ink-primary)" />
      <rect x="6.5" y="5.5" width="3" height="3" fill="var(--ink-primary)" />
      <path d="M3 1v6" fill="none" stroke="var(--ink-primary)" strokeWidth="1.5" />
    </svg>
  );
}

export function MutedIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect x="0.5" y="3" width="3" height="4" fill="var(--ink-muted)" />
      <path d="M3.5 3L6.5 0.75V9.25L3.5 7" fill="var(--ink-muted)" />
      <path d="M8 3.5L9.75 6.5M9.75 3.5L8 6.5" stroke="var(--ink-primary)" strokeWidth="1.2" />
    </svg>
  );
}

export function CheckIcon({ color = "#FFFFFF" }: { color?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M1.5 5.2L4 7.5L8.5 2.5" fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="3.75" y="3.75" width="7.5" height="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.25 0.75H0.75V8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
