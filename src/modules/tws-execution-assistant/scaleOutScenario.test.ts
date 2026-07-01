import { describe, expect, it } from "vitest";
import { calculateScaleOutScenario } from "./scaleOutScenario";

describe("calculateScaleOutScenario", () => {
  it("calculates best, worst, and partial target outcomes", () => {
    const lots = [
      { quantity: 5, targetPrice: 125, stopPrice: 115, trailAmount: null },
      { quantity: 5, targetPrice: 130, stopPrice: 115, trailAmount: null },
      { quantity: 10, targetPrice: 135, stopPrice: 112, trailAmount: null },
    ];

    expect(calculateScaleOutScenario({
      entryPrice: 120,
      lots,
      targetsHit: 1,
      exitMode: "stops",
      closePrice: null,
    })).toMatchObject({ bestCase: 225, worstCase: -130, selected: -80 });

    expect(calculateScaleOutScenario({
      entryPrice: 120,
      lots,
      targetsHit: 2,
      exitMode: "stops",
      closePrice: null,
    }).selected).toBe(-5);
  });
});
