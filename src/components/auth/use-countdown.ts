"use client";

import { useEffect, useState } from "react";

/**
 * Ticks once per second and returns whole seconds remaining until the target.
 * Accepts an ISO timestamp, an epoch-ms number, or null (returns 0).
 * Display-only: the authoritative deadlines always live on the server.
 */
export function useCountdown(target: string | number | null): number {
  const [now, setNow] = useState(() => Date.now());

  const targetMs =
    target === null ? 0 : typeof target === "number" ? target : Date.parse(target) || 0;

  useEffect(() => {
    if (target === null) return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= targetMs) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [target, targetMs]);

  const ms = targetMs - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** Format seconds as HH:MM:SS (or MM:SS below one hour). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
