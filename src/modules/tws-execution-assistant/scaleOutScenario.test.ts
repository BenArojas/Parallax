import { describe, expect, it } from "vitest";
import { calculateScaleOutScenario } from "./scaleOutScenario";

describe("calculateScaleOutScenario", () => {
  it("uses per-lot target assumptions for the best-case path", () => {
    const lots = [
      { quantity: 5, targetPrice: 125, stopPrice: 115, trailAmount: null },
      { quantity: 5, targetPrice: 130, stopPrice: 115, trailAmount: null },
      { quantity: 10, targetPrice: 135, stopPrice: 112, trailAmount: null },
    ];

    expect(
      calculateScaleOutScenario({
        entryPrice: 120,
        lots,
        assumptions: [
          { lotIndex: 0, outcome: "target", fallbackPrice: null },
          { lotIndex: 1, outcome: "target", fallbackPrice: null },
          { lotIndex: 2, outcome: "target", fallbackPrice: null },
        ],
      }),
    ).toMatchObject({ bestCase: 225, worstCase: -130, selected: 225 });
  });

  it("mixes target and stop assumptions per lot", () => {
    const lots = [
      { quantity: 5, targetPrice: 125, stopPrice: 115, trailAmount: null },
      { quantity: 5, targetPrice: 130, stopPrice: 115, trailAmount: null },
      { quantity: 10, targetPrice: 135, stopPrice: 112, trailAmount: null },
    ];

    expect(
      calculateScaleOutScenario({
        entryPrice: 120,
        lots,
        assumptions: [
          { lotIndex: 0, outcome: "target", fallbackPrice: null },
          { lotIndex: 1, outcome: "stop", fallbackPrice: null },
          { lotIndex: 2, outcome: "stop", fallbackPrice: null },
        ],
      }),
    ).toMatchObject({ bestCase: 225, worstCase: -130, selected: -80, targetGain: 25, remainingExit: -105 });
  });

  it("returns null for a selected fallback without an assumed price", () => {
    const lots = [
      { quantity: 5, targetPrice: 125, stopPrice: 115, trailAmount: null },
      { quantity: 5, targetPrice: 130, stopPrice: 115, trailAmount: null },
    ];

    expect(
      calculateScaleOutScenario({
        entryPrice: 120,
        lots,
        assumptions: [
          { lotIndex: 0, outcome: "target", fallbackPrice: null },
          { lotIndex: 1, outcome: "fallback", fallbackPrice: null },
        ],
      }).selected,
    ).toBeNull();
  });
});
