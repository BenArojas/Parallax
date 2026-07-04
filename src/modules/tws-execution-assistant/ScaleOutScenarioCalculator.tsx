import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Hint } from "./ScaleOutLadderPanel";
import {
  calculateScaleOutScenario,
  type ScaleOutScenarioAssumption,
  type ScaleOutScenarioLot,
  type ScaleOutScenarioOutcome,
} from "./scaleOutScenario";

function formatMoney(n: number | null): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const formatted = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(2);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${formatted}`;
}

export function ScaleOutScenarioCalculator({
  entryPrice,
  lots,
}: {
  entryPrice: number | null;
  lots: ScaleOutScenarioLot[];
}) {
  const [assumptions, setAssumptions] = useState<ScaleOutScenarioAssumption[]>(() =>
    lots.map((_, lotIndex) => ({ lotIndex, outcome: "target", fallbackPrice: null })),
  );

  if (lots.length === 0) return null;

  useEffect(() => {
    setAssumptions((previous) =>
      lots.map((_, lotIndex) => previous.find((item) => item.lotIndex === lotIndex) ?? {
        lotIndex,
        outcome: "target",
        fallbackPrice: null,
      }),
    );
  }, [lots]);

  const result = calculateScaleOutScenario({ entryPrice, lots, assumptions });
  const outcomeCounts = useMemo(() => (
    assumptions.reduce(
      (counts, assumption) => {
        counts[assumption.outcome] += 1;
        return counts;
      },
      { target: 0, stop: 0, fallback: 0 } as Record<ScaleOutScenarioOutcome, number>,
    )
  ), [assumptions]);
  const preset = outcomeCounts.target === lots.length
    ? "all_targets"
    : outcomeCounts.stop === lots.length
      ? "all_stops"
      : "mixed";

  function setPreset(next: "all_targets" | "mixed" | "all_stops") {
    setAssumptions((previous) =>
      lots.map((_, lotIndex) => {
        const current = previous.find((item) => item.lotIndex === lotIndex);
        if (next === "all_targets") {
          return { lotIndex, outcome: "target", fallbackPrice: current?.fallbackPrice ?? null };
        }
        if (next === "all_stops") {
          return { lotIndex, outcome: "stop", fallbackPrice: current?.fallbackPrice ?? null };
        }
        return {
          lotIndex,
          outcome: lotIndex === 0 ? "target" : "stop",
          fallbackPrice: current?.fallbackPrice ?? null,
        };
      }),
    );
  }

  function updateAssumption(lotIndex: number, outcome: ScaleOutScenarioOutcome) {
    setAssumptions((previous) =>
      previous.map((assumption) => (
        assumption.lotIndex === lotIndex
          ? { ...assumption, outcome }
          : assumption
      )),
    );
  }

  function updateFallbackPrice(lotIndex: number, value: string) {
    setAssumptions((previous) =>
      previous.map((assumption) => (
        assumption.lotIndex === lotIndex
          ? { ...assumption, fallbackPrice: value ? Number(value) : null }
          : assumption
      )),
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--clr-purple)]/20 bg-[var(--bg-0)] p-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Best case</p>
          <p className="font-data text-sm font-semibold text-[var(--clr-green)]">{formatMoney(result.bestCase)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Worst stop case</p>
          <p className="font-data text-sm font-semibold text-[var(--clr-red)]">{formatMoney(result.worstCase)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Selected</p>
          <p className="font-data text-sm font-semibold text-[var(--text-1)]">{formatMoney(result.selected)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[
          { key: "all_targets", label: "All targets" },
          { key: "mixed", label: "Mixed" },
          { key: "all_stops", label: "All stops" },
        ].map((option) => (
          <button
            key={option.key}
            type="button"
            className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition-transform active:scale-[0.96]",
              preset === option.key
                ? "border-[var(--clr-purple)] bg-[var(--clr-purple)] text-white"
                : "border-border/80 bg-[var(--bg-1)] text-[var(--text-3)] hover:text-[var(--text-2)]",
            )}
            onClick={() => setPreset(option.key as "all_targets" | "mixed" | "all_stops")}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {lots.map((lot, lotIndex) => {
          const assumption = assumptions.find((item) => item.lotIndex === lotIndex) ?? {
            lotIndex,
            outcome: "target" as const,
            fallbackPrice: null,
          };
          return (
            <div key={lotIndex} className="rounded-lg border border-border/70 bg-[var(--bg-1)] px-3 py-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="font-data text-[11px] text-[var(--text-1)]">
                    Lot {lotIndex + 1} · {lot.quantity || 0} @ {formatMoney(lot.targetPrice || null)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--text-3)]">
                    Stop {formatMoney(lot.stopPrice)} • Trail {formatMoney(lot.trailAmount)}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {(["target", "stop", "fallback"] as const).map((outcome) => (
                    <button
                      key={outcome}
                      type="button"
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition-transform active:scale-[0.96]",
                        assumption.outcome === outcome
                          ? "border-[var(--clr-purple)] bg-[var(--clr-purple)] text-white"
                          : "border-border/80 bg-[var(--bg-0)] text-[var(--text-3)] hover:text-[var(--text-2)]",
                      )}
                      onClick={() => updateAssumption(lotIndex, outcome)}
                    >
                      {outcome === "fallback" ? "EOD" : outcome}
                    </button>
                  ))}
                </div>
              </div>
              {assumption.outcome === "fallback" && (
                <label className="mt-2 flex items-center gap-2">
                  <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--text-3)]">
                    EOD price
                    <Hint text="Preview-only close assumption for this lot. It does not change the real target, stop, trail, or broker payload." />
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-7 w-24 rounded-full border border-border/80 bg-[var(--bg-0)] px-2 font-data text-[11px] outline-none focus:border-[var(--clr-purple)]"
                    value={assumption.fallbackPrice ?? ""}
                    onChange={(event) => updateFallbackPrice(lotIndex, event.target.value)}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-[var(--text-3)]">
        {outcomeCounts.target} target • {outcomeCounts.stop} stop • {outcomeCounts.fallback} EOD
        <span className="font-data text-[var(--text-2)]"> · target {formatMoney(result.targetGain)} · other {formatMoney(result.remainingExit)}</span>
      </p>
    </div>
  );
}
