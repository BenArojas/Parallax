import { useCallback, useEffect, useState } from "react";

import { TWS_STREAM_URL } from "@/config/endpoints";

import type { TwsTimeframe } from "./api";

export type TwsLiveStreamStatus = "disconnected" | "connecting" | "connected";
export type TwsStreamChannel = "quote" | "bars" | "depth";

export interface TwsStreamSubscribeRequest {
  action: "subscribe" | "unsubscribe";
  channel: TwsStreamChannel;
  conid: number;
  timeframe?: TwsTimeframe;
}

export interface TwsStreamStatusEvent {
  type: "tws_stream_status";
  connected: boolean;
}

export interface TwsStreamErrorEvent {
  type: "tws_stream_error";
  message: string;
}

export type TwsLiveStreamMessage =
  | TwsStreamStatusEvent
  | TwsStreamErrorEvent
  | ({ type: string } & Record<string, unknown>);

type MessageHandler = (msg: TwsLiveStreamMessage) => void;
type StatusListener = (status: TwsLiveStreamStatus) => void;
type ConnectedListener = (connected: boolean) => void;

const MAX_RECONNECT_DELAY = 30_000;
const TEARDOWN_GRACE_MS = 10_000;

const handlers = new Set<MessageHandler>();
const statusListeners = new Set<StatusListener>();
const connectedListeners = new Set<ConnectedListener>();
const subscriptions = new Map<string, { request: Omit<TwsStreamSubscribeRequest, "action">; refCount: number }>();

let ws: WebSocket | null = null;
let currentStatus: TwsLiveStreamStatus = "disconnected";
let currentConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let refCount = 0;

function setStatus(status: TwsLiveStreamStatus) {
  currentStatus = status;
  for (const listener of statusListeners) listener(status);
}

function setConnected(connected: boolean) {
  currentConnected = connected;
  for (const listener of connectedListeners) listener(connected);
}

function subscriptionKey(channel: TwsStreamChannel, conid: number, timeframe?: TwsTimeframe) {
  return `${channel}|${conid}|${timeframe ?? ""}`;
}

function send(data: TwsStreamSubscribeRequest | Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  setStatus("connecting");
  const sock = new WebSocket(TWS_STREAM_URL);
  ws = sock;

  sock.onopen = () => {
    reconnectAttempt = 0;
    setStatus("connected");
    for (const { request } of subscriptions.values()) {
      sock.send(JSON.stringify({ action: "subscribe", ...request }));
    }
  };

  sock.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as TwsLiveStreamMessage;
      if (msg.type === "tws_stream_status" && typeof msg.connected === "boolean") {
        setConnected(msg.connected);
      }
      for (const handler of handlers) handler(msg);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("[useTwsLiveStream] malformed message dropped:", event.data, error);
      }
    }
  };

  sock.onclose = () => {
    const wasActive = ws === sock;
    ws = null;
    setStatus("disconnected");
    setConnected(false);
    if (!wasActive) return;

    const attempt = reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (refCount > 0) connect();
    }, delay);
  };

  sock.onerror = () => {
    // onclose handles reconnect
  };
}

function closeSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  subscriptions.clear();
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* no-op */
    }
    ws = null;
  }
  setStatus("disconnected");
  setConnected(false);
}

function acquire() {
  refCount += 1;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  if (!ws && currentStatus !== "connecting") connect();
}

function release() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    if (teardownTimer) clearTimeout(teardownTimer);
    teardownTimer = setTimeout(() => {
      teardownTimer = null;
      if (refCount === 0) closeSocket();
    }, TEARDOWN_GRACE_MS);
  }
}

export function useTwsLiveStream() {
  const [status, setLocalStatus] = useState<TwsLiveStreamStatus>(currentStatus);
  const [streamConnected, setLocalConnected] = useState<boolean>(currentConnected);

  useEffect(() => {
    acquire();
    statusListeners.add(setLocalStatus);
    connectedListeners.add(setLocalConnected);
    setLocalStatus(currentStatus);
    setLocalConnected(currentConnected);
    return () => {
      statusListeners.delete(setLocalStatus);
      connectedListeners.delete(setLocalConnected);
      release();
    };
  }, []);

  const subscribe = useCallback((channel: TwsStreamChannel, conid: number, timeframe?: TwsTimeframe) => {
    const key = subscriptionKey(channel, conid, timeframe);
    const active = subscriptions.get(key);
    if (active) {
      active.refCount += 1;
      return;
    }
    const request = { channel, conid, timeframe };
    subscriptions.set(key, { request, refCount: 1 });
    send({ action: "subscribe", ...request });
  }, []);

  const unsubscribe = useCallback((channel: TwsStreamChannel, conid: number, timeframe?: TwsTimeframe) => {
    const key = subscriptionKey(channel, conid, timeframe);
    const active = subscriptions.get(key);
    if (!active) return;
    if (active.refCount > 1) {
      active.refCount -= 1;
      return;
    }
    subscriptions.delete(key);
    send({ action: "unsubscribe", channel, conid, timeframe });
  }, []);

  const addHandler = useCallback((handler: MessageHandler) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }, []);

  const sendMessage = useCallback((msg: Record<string, unknown>) => send(msg), []);

  return {
    status,
    streamConnected,
    subscribe,
    unsubscribe,
    send: sendMessage,
    addHandler,
  };
}
