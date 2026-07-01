export type ScaleOutScenarioExitMode = "stops" | "close";

export interface ScaleOutScenarioLot {
  quantity: number;
  targetPrice: number;
  stopPrice: number | null;
  trailAmount: number | null;
}

export interface ScaleOutScenarioResult {
  bestCase: number | null;
  worstCase: number | null;
  selected: number | null;
  targetGain: number;
  remainingExit: number | null;
}

/** A fixed stop uses stopPrice directly; a trailing stop estimates its worst case as entry minus the trail amount. */
function lotExitPrice(lot: ScaleOutScenarioLot, entryPrice: number): number | null {
  if (lot.trailAmount) return entryPrice - lot.trailAmount;
  if (lot.stopPrice) return lot.stopPrice;
  return null;
}

function bestCaseFor(lots: ScaleOutScenarioLot[], entryPrice: number): number | null {
  if (!lots.every((l) => l.quantity && l.targetPrice)) return null;
  return lots.reduce((sum, l) => sum + l.quantity * (l.targetPrice - entryPrice), 0);
}

function worstCaseFor(lots: ScaleOutScenarioLot[], entryPrice: number): number | null {
  const exits = lots.map((l) => lotExitPrice(l, entryPrice));
  if (!lots.every((l, i) => l.quantity && exits[i] != null)) return null;
  return lots.reduce((sum, l, i) => sum + l.quantity * (exits[i]! - entryPrice), 0);
}

function targetGainFor(hitLots: ScaleOutScenarioLot[], entryPrice: number): number {
  return hitLots.reduce(
    (sum, l) => sum + (l.quantity && l.targetPrice ? l.quantity * (l.targetPrice - entryPrice) : 0),
    0,
  );
}

function remainingExitFor(
  remainingLots: ScaleOutScenarioLot[],
  entryPrice: number,
  exitMode: ScaleOutScenarioExitMode,
  closePrice: number | null,
): number | null {
  if (remainingLots.length === 0) return 0;
  if (!remainingLots.every((l) => l.quantity)) return null;

  if (exitMode === "close") {
    if (closePrice == null) return null;
    return remainingLots.reduce((sum, l) => sum + l.quantity * (closePrice - entryPrice), 0);
  }

  const exits = remainingLots.map((l) => lotExitPrice(l, entryPrice));
  if (!exits.every((e) => e != null)) return null;
  return remainingLots.reduce((sum, l, i) => sum + l.quantity * (exits[i]! - entryPrice), 0);
}

export function calculateScaleOutScenario(input: {
  entryPrice: number | null;
  lots: ScaleOutScenarioLot[];
  targetsHit: number;
  exitMode: ScaleOutScenarioExitMode;
  closePrice: number | null;
}): ScaleOutScenarioResult {
  const { entryPrice, lots, targetsHit, exitMode, closePrice } = input;

  if (entryPrice == null || lots.length === 0) {
    return { bestCase: null, worstCase: null, selected: null, targetGain: 0, remainingExit: null };
  }

  const hitCount = Math.max(0, Math.min(targetsHit, lots.length));
  const hitLots = lots.slice(0, hitCount);
  const remainingLots = lots.slice(hitCount);

  const targetGain = targetGainFor(hitLots, entryPrice);
  const remainingExit = remainingExitFor(remainingLots, entryPrice, exitMode, closePrice);

  return {
    bestCase: bestCaseFor(lots, entryPrice),
    worstCase: worstCaseFor(lots, entryPrice),
    selected: remainingExit == null ? null : targetGain + remainingExit,
    targetGain,
    remainingExit,
  };
}
