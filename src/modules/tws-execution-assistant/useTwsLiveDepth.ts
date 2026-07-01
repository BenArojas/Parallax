import { useTwsStreamChannel } from "./useTwsStreamChannel";

export const useTwsLiveDepth = (conid: number) => useTwsStreamChannel("depth", conid);
