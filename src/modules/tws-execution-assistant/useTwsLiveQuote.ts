import { useTwsStreamChannel } from "./useTwsStreamChannel";

export const useTwsLiveQuote = (conid: number) => useTwsStreamChannel("quote", conid);
