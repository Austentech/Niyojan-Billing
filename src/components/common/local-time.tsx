"use client";

import { useSyncExternalStore } from "react";

/**
 * Renders a UTC timestamp in the READER'S LOCAL timezone.
 *
 * Timestamps are stored in UTC in the database. The first paint shows a
 * deterministic UTC string (identical on server and client — no hydration
 * mismatch); useSyncExternalStore's server snapshot then yields to the
 * localized browser rendering on the client. The UTC value stays available
 * as a tooltip.
 */

const noOpSubscribe = () => () => {};

function utcFallback(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function localString(value: string, withZone: boolean): string | null {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const parts = d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (!withZone) return parts;
    const zone = timeZoneAbbreviation(d);
    return zone ? `${parts} (${zone})` : parts;
  } catch {
    return null;
  }
}

/** The reader's timezone abbreviation only (e.g. "UTC", "IST", "GMT+5:30"). */
function timeZoneAbbreviation(d: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" });
    return (
      formatter
        .formatToParts(d)
        .find((part) => part.type === "timeZoneName")
        ?.value.trim() ?? ""
    );
  } catch {
    return "";
  }
}

export function LocalTime({
  value,
  withZone = false,
  className,
}: {
  value: string | null | undefined;
  /** Append the reader's timezone abbreviation (e.g. "IST"). */
  withZone?: boolean;
  className?: string;
}) {
  // Client-only snapshot: the localized rendering (null on the server).
  const local = useSyncExternalStore(
    noOpSubscribe,
    () => (value ? localString(value, withZone) : null),
    () => null,
  );

  if (!value) return <span className={className}>—</span>;
  const invalid = Number.isNaN(new Date(value).getTime());
  if (invalid) return <span className={className}>—</span>;

  return (
    <span className={className} title={utcFallback(value)} suppressHydrationWarning>
      {local ?? utcFallback(value)}
    </span>
  );
}
