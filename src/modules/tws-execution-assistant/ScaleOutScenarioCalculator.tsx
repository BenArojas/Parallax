import { useState } from "react";
import { cn } from "@/lib/utils";
import { Hint } from "./ScaleOutLadderPanel";
import { calculateScaleOutScenario, type ScaleOutScenarioExitMode, type ScaleOutScenarioLot } from "./scaleOutScenario";

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
  const [targetsHit, setTargetsHit] = useState(0);
  const [exitMode, setExitMode] = useState<ScaleOutScenarioExitMode>("stops");
  const [closePrice, setClosePrice] = useState("");

  if (lots.length === 0) return null;

  const targetOptions = Array.from(new Set([0, 1, 2, lots.length])).filter((n) => n <= lots.length);
  const result = calculateScaleOutScenario({
    entryPrice,
    lots,
    targetsHit,
    exitMode,
    closePrice: closePrice ? Number(closePrice) : null,
  });

  const remainingCount = lots.length - Math.max(0, Math.min(targetsHit, lots.length));

  return (
    <div className="space-y-2.5 rounded border border-border/60 bg-[var(--bg-0)] p-3">
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--text-3)]">Targets hit</span>
          <div className="flex overflow-hidden rounded border border-border">
            {targetOptions.map((n) => (
              <button
                key={n}
                type="button"
                className={cn(
                  "h-6 px-2 text-[11px] font-medium transition-colors",
                  targetsHit === n
                    ? "bg-[var(--clr-purple)] text-[var(--bg-0)]"
                    : "bg-transparent text-[var(--text-2)] hover:bg-[var(--bg-1)]",
                )}
                onClick={() => setTargetsHit(n)}
              >
                {n === lots.length ? "All" : n}
              </button>
            ))}
          </div>
        </div>

        {remainingCount > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[var(--text-3)]">Remaining exit</span>
            <div className="flex overflow-hidden rounded border border-border">
              {(["stops", "close"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "h-6 px-2 text-[11px] font-medium transition-colors",
                    exitMode === mode
                      ? "bg-[var(--clr-purple)] text-[var(--bg-0)]"
                      : "bg-transparent text-[var(--text-2)] hover:bg-[var(--bg-1)]",
                  )}
                  onClick={() => setExitMode(mode)}
                >
                  {mode === "stops" ? "Stops" : "EOD close"}
                </button>
              ))}
            </div>
          </div>
        )}

        {remainingCount > 0 && exitMode === "close" && (
          <label className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-[11px] text-[var(--text-3)]">
              Assumed close <Hint text="A price you expect the remaining lots to close at, if neither their target nor stop is hit by end of day." />
            </span>
            <input
              type="number"
              step="0.01"
              className="h-6 w-20 rounded border border-border bg-[var(--bg-1)] px-2 font-data text-[11px] outline-none focus:border-[var(--clr-purple)]"
              value={closePrice}
              onChange={(e) => setClosePrice(e.target.value)}
            />
          </label>
        )}
      </div>

      <p className="text-[11px] text-[var(--text-3)]">
        {targetsHit} {targetsHit === 1 ? "target" : "targets"} hit ({formatMoney(result.targetGain)})
        {remainingCount > 0 && (
          <>
            {" "}
            + {remainingCount} {remainingCount === 1 ? "lot" : "lots"} via {exitMode === "stops" ? "stops" : "EOD close"} (
            {formatMoney(result.remainingExit)})
          </>
        )}
      </p>
    </div>
  );
}
