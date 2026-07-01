import { useTwsStreamChannel } from "./useTwsStreamChannel";
import type { BarSnapshot, TwsTimeframe } from "./api";

export function useTwsLiveBars(conid: number, timeframe: TwsTimeframe): BarSnapshot | null {
  return useTwsStreamChannel("bars", conid, timeframe)?.bar ?? null;
}
