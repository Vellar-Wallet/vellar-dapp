"use client";

import { useId, useState } from "react";

export interface WeeklyDownloads {
  weekLabel: string;
  total: number;
  partial?: boolean;
}

/**
 * Weekly npm download bar chart for vellar-sdk — single series, so no legend
 * box (the title names it). Forest fill: lime was checked against the paper
 * surface with the dataviz skill's validator and failed contrast (L 0.897,
 * 1.28:1) — it stays reserved for the headline total number instead, exactly
 * the "one loud claim per slide" rule the deck's own design brief states.
 * Hover tooltip + a visually-hidden data table give the same numbers two
 * other ways, per the skill's interaction + accessibility passes.
 */
export function DownloadsChart({ weeks, total }: { weeks: WeeklyDownloads[]; total: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const titleId = useId();
  const max = Math.max(...weeks.map((w) => w.total));

  return (
    <div role="group" aria-labelledby={titleId} className="dl-chart">
      <p id={titleId} className="dl-chart-title">
        vellar-sdk weekly npm downloads
      </p>

      <div className="dl-chart-plot">
        {weeks.map((w, i) => {
          const heightPct = max > 0 ? (w.total / max) * 100 : 0;
          const isHovered = hovered === i;
          return (
            <div
              key={w.weekLabel}
              className="dl-bar-col"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered((h) => (h === i ? null : h))}
              tabIndex={0}
              role="img"
              aria-label={`${w.weekLabel}: ${w.total} downloads${w.partial ? " (partial week)" : ""}`}
            >
              {isHovered && (
                <div className="dl-tooltip">
                  <b>{w.total}</b> downloads
                  <span>
                    {w.weekLabel}
                    {w.partial ? " · partial" : ""}
                  </span>
                </div>
              )}
              <div
                className={`dl-bar${w.partial ? " is-partial" : ""}${isHovered ? " is-hovered" : ""}`}
                style={{ height: `${Math.max(heightPct, 3)}%` }}
              >
                <span className="dl-bar-value">{w.total}</span>
              </div>
              <span className="dl-bar-label">{w.weekLabel}</span>
            </div>
          );
        })}
      </div>

      <p className="dl-chart-foot">
        <span className="dl-chart-total">{total.toLocaleString()}</span> total downloads since first
        publish — zero paid marketing, zero ad spend.
      </p>

      {/* Accessible data table, visually hidden, same numbers as the bars. */}
      <table className="sr-only-table">
        <caption>vellar-sdk weekly npm downloads</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Downloads</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekLabel}>
              <td>
                {w.weekLabel}
                {w.partial ? " (partial)" : ""}
              </td>
              <td>{w.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
