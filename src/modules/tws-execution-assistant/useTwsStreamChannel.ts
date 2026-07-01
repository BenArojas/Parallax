import { useEffect, useState } from "react";

import { useTwsLiveStream, type TwsLiveStreamMessage, type TwsStreamChannel } from "./useTwsLiveStream";
import type { TwsBarUpdateEvent, TwsQuoteStreamEvent, TwsTimeframe } from "./api";

type TwsStreamChannelEventMap = {
  quote: TwsQuoteStreamEvent;
  bars: TwsBarUpdateEvent;
  depth: TwsLiveStreamMessage;
};

const STREAM_EVENT_TYPES: Record<TwsStreamChannel, string> = {
  quote: "tws_quote",
  bars: "tws_bar_update",
  depth: "tws_depth",
};

function hasConid(msg: TwsLiveStreamMessage): msg is TwsLiveStreamMessage & { conid: number; timeframe?: TwsTimeframe } {
  return typeof (msg as { conid?: unknown }).conid === "number";
}

export function useTwsStreamChannel<TChannel extends TwsStreamChannel>(
  channel: TChannel,
  conid: number,
  timeframe?: TwsTimeframe,
): TwsStreamChannelEventMap[TChannel] | null {
  const { subscribe, unsubscribe, addHandler } = useTwsLiveStream();
  const [event, setEvent] = useState<TwsStreamChannelEventMap[TChannel] | null>(null);

  useEffect(() => {
    if (conid <= 0) {
      setEvent(null);
      return;
    }

    subscribe(channel, conid, timeframe);
    const removeHandler = addHandler((msg) => {
      if (msg.type !== STREAM_EVENT_TYPES[channel]) return;
      if (!hasConid(msg)) return;
      if (msg.conid !== conid) return;
      if (channel === "bars" && timeframe && msg.timeframe !== timeframe) return;
      setEvent(msg as TwsStreamChannelEventMap[TChannel]);
    });

    return () => {
      removeHandler();
      unsubscribe(channel, conid, timeframe);
    };
  }, [addHandler, channel, conid, subscribe, timeframe, unsubscribe]);

  return event;
}
