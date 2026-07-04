export interface ScaleOutScenarioLot {
  quantity: number;
  targetPrice: number;
  stopPrice: number | null;
  trailAmount: number | null;
}

export type ScaleOutScenarioOutcome = "target" | "stop" | "fallback";

export interface ScaleOutScenarioAssumption {
  lotIndex: number;
  outcome: ScaleOutScenarioOutcome;
  fallbackPrice: number | null;
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

function selectedExitPrice(
  lot: ScaleOutScenarioLot,
  entryPrice: number,
  assumption: ScaleOutScenarioAssumption | undefined,
): number | null {
  const outcome = assumption?.outcome ?? "target";
  if (outcome === "target") return lot.targetPrice || null;
  if (outcome === "stop") return lotExitPrice(lot, entryPrice);
  return assumption?.fallbackPrice ?? null;
}

function selectedResultFor(
  lots: ScaleOutScenarioLot[],
  entryPrice: number,
  assumptions: ScaleOutScenarioAssumption[],
): Pick<ScaleOutScenarioResult, "selected" | "targetGain" | "remainingExit"> {
  if (!lots.every((lot) => lot.quantity > 0)) {
    return { selected: null, targetGain: 0, remainingExit: null };
  }

  let targetGain = 0;
  let remainingExit = 0;

  for (let index = 0; index < lots.length; index += 1) {
    const lot = lots[index];
    const assumption = assumptions.find((item) => item.lotIndex === index);
    const exitPrice = selectedExitPrice(lot, entryPrice, assumption);
    if (exitPrice == null) {
      return { selected: null, targetGain: 0, remainingExit: null };
    }

    const lotPnL = lot.quantity * (exitPrice - entryPrice);
    if ((assumption?.outcome ?? "target") === "target") {
      targetGain += lotPnL;
    } else {
      remainingExit += lotPnL;
    }
  }

  return {
    selected: targetGain + remainingExit,
    targetGain,
    remainingExit,
  };
}

export function calculateScaleOutScenario(input: {
  entryPrice: number | null;
  lots: ScaleOutScenarioLot[];
  assumptions: ScaleOutScenarioAssumption[];
}): ScaleOutScenarioResult {
  const { entryPrice, lots, assumptions } = input;

  if (entryPrice == null || lots.length === 0) {
    return { bestCase: null, worstCase: null, selected: null, targetGain: 0, remainingExit: null };
  }

  const selected = selectedResultFor(lots, entryPrice, assumptions);

  return {
    bestCase: bestCaseFor(lots, entryPrice),
    worstCase: worstCaseFor(lots, entryPrice),
    selected: selected.selected,
    targetGain: selected.targetGain,
    remainingExit: selected.remainingExit,
  };
}
