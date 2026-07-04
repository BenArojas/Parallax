/**
 * TWS Execution Assistant sidecar contract.
 *
 * Owns the broker session mode endpoint and TWS-specific endpoint contracts.
 * Transport mechanics stay in "@/lib/sidecarClient".
 */

import { sidecarRequest } from "@/lib/sidecarClient";
import type { TwsOrderType } from "./orderCapabilities";

export type BrokerSessionMode = "none" | "client_portal" | "tws";

/** Accepted switch targets — "none" cannot be set explicitly. */
export type BrokerSessionSwitchTarget = "client_portal" | "tws";

export interface BrokerSessionModeResponse {
  mode: BrokerSessionMode;
  available_modules: string[];
}

export type TwsAdapterState =
  | "not_initialized"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface ReconciliationSummary {
  position_count: number;
  open_order_count: number;
  unmanaged_order_count: number;
}

export interface TwsStatusResponse {
  mode: BrokerSessionMode;
  connected: boolean;
  adapter_state: TwsAdapterState;
  kill_switch_active: boolean;
  reconciliation_summary: ReconciliationSummary;
  /** TCP-reachable even before Orbit's adapter connects. */
  api_server_available: boolean;
  day_pnl: number | null;
}

export interface PositionSnapshot {
  conid: number;
  symbol: string;
  position: number;
  avg_cost: number;
  market_price: number | null;
  market_value: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  daily_pnl: number | null;
}

export interface OrderSnapshot {
  order_id: number;
  conid: number;
  symbol: string;
  side: string;
  quantity: number;
  order_type: string;
  lmt_price: number | null;
  stop_price: number | null;
  status: string;
  is_unmanaged: boolean;
  parent_id: number | null;
  oca_group: string | null;
  order_ref: string | null;
}

export type TwsPackageWarningKind =
  | "malformed_order_ref"
  | "cross_lot_parent_id"
  | "cross_lot_oca_group"
  | "sell_exposure_exceeds_position"
  | "unknown_role";

export interface TwsPackageWarning {
  kind: TwsPackageWarningKind;
  severity: "warning";
  message: string;
  package_id: string | null;
  conid: number | null;
  symbol: string | null;
  order_ids: number[];
}

export interface ReconciliationSnapshot {
  position_count: number;
  open_order_count: number;
  unmanaged_order_count: number;
  positions: PositionSnapshot[];
  open_orders: OrderSnapshot[];
  package_warnings: TwsPackageWarning[];
}

export interface TwsConnectRequest {
  host: string;
  port: number;
  client_id: number;
}

export const TWS_CONNECT_DEFAULTS: TwsConnectRequest = {
  host: "127.0.0.1",
  port: 4002, // IB Gateway paper; TWS paper is 7497
  client_id: 1,
};

export type ExecutionPlanStatus = "draft" | "valid" | "invalid";
export type ExecutionPlanSide = "BUY" | "SELL";
export type ExecutionPlanOrderType = TwsOrderType;

export interface ExecutionPlanDraftRequest {
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: ExecutionPlanOrderType;
  limit_price: number | null;
  stop_price: number | null;
}

export interface ExecutionPlan {
  plan_id: string;
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: ExecutionPlanOrderType;
  limit_price: number | null;
  stop_price: number | null;
  status: ExecutionPlanStatus;
  validation_errors: string[];
  created_at: string;
}

export interface PaperOrderSubmission {
  order_id: number;
  status: string;
  plan_id: string;
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: ExecutionPlanOrderType;
  limit_price: number | null;
  stop_price: number | null;
  submitted_at: string;
}

export interface TwsLivePolicyStatus {
  connected_account_id: string | null;
  connected_host: string;
  connected_port: number | null;
  is_paper_port: boolean;
  allowlisted: boolean;
  armed: boolean;
  arm_expires_on: string[];
}

export interface TwsLiveAllowlistRequest {
  account_id: string;
  host: string;
  port: number;
}

export type TwsLiveArmRequest = TwsLiveAllowlistRequest;

export interface PaperOrderPreview {
  plan_id: string;
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: ExecutionPlanOrderType;
  limit_price: number | null;
  stop_price: number | null;
  tif: string;
  transmit: boolean;
  paper_only: boolean;
}

export interface InstrumentResult {
  conid: number;
  symbol: string;
  sec_type: string;
  exchange: string;
  primary_exchange: string;
  currency: string;
  local_symbol: string;
  company_name: string;
}

export type MarketDataType =
  | "unknown"
  | "live"
  | "frozen"
  | "delayed"
  | "delayed_frozen"
  | "partial"
  | "unavailable";

export interface QuoteSnapshot {
  last: number | null;
  close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  bid: number | null;
  ask: number | null;
  market_data_type: MarketDataType;
  is_delayed: boolean;
  unavailable_reason: string | null;
  error_code: number | null;
}

export interface TwsQuoteStreamEvent {
  type: "tws_quote";
  conid: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  entitlement: MarketDataType;
  unavailable_reason: string | null;
}

export const TWS_TIMEFRAMES = ["1m", "5m", "15m", "30m", "4h", "1D", "1W"] as const;
export type TwsTimeframe = (typeof TWS_TIMEFRAMES)[number];

export interface BarSnapshot {
  time: number; // Unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarsResponse {
  conid: number;
  timeframe: string;
  bars: BarSnapshot[];
}

export interface TwsBarUpdateEvent {
  type: "tws_bar_update";
  conid: number;
  timeframe: TwsTimeframe;
  bar: BarSnapshot;
}

export interface TwsDepthLevel {
  price: number;
  size: number;
  market_maker: string | null;
}

export interface TwsDepthUpdateEvent {
  type: "tws_depth_update";
  conid: number;
  bids: TwsDepthLevel[];
  asks: TwsDepthLevel[];
  entitlement: MarketDataType;
  unavailable_reason: string | null;
}

export interface TwsOrderActionResult {
  order_id: number;
  status: string;
  action: "cancel" | "modify" | "override";
  message: string | null;
}

export interface TwsModifyOrderRequest {
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
}

export interface TwsFlattenResult {
  conid: number;
  canceled_order_ids: number[];
  close_order_id: number | null;
  closed_quantity: number;
  side: "BUY" | "SELL" | null;
  status: string;
  message: string | null;
}

export interface TwsAdvancedReject {
  order_id: number | null;
  reason: string;
  override_codes: string[];
  raw: unknown;
}

export interface TwsOverrideRequest {
  intent: "place" | "modify";
  order_id: number | null;
  plan_id: string | null;
  modify: TwsModifyOrderRequest | null;
  override_codes: string[];
}

// ── Advanced order packages (Mission 2) ──────────────────────────────────────
// All seven kinds have cockpit UI: scale_out_ladder and bracket each have their
// own builder panel; trailing_stop/gtd/moc/loc/price_condition share AdvancedOrderPanel.
export type TwsAdvancedOrderKind =
  | "scale_out_ladder"
  | "bracket"
  | "trailing_stop"
  | "gtd"
  | "moc"
  | "loc"
  | "price_condition";

export interface TwsTrailSpec {
  mode: "amount" | "percent";
  value: number;
}

export interface TwsScaleOutLotDraft {
  quantity: number;
  target_price: number;
  stop_price: number | null;
  trail: TwsTrailSpec | null;
  close_fallback: "MOC";
}

export interface TwsOrderPackageRequest {
  kind: TwsAdvancedOrderKind;
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: string;
  limit_price: number | null;
  limit_offset: number | null;
  stop_price: number | null;
  trail: TwsTrailSpec | null;
  good_till_date: string | null;
  target_price: number | null;
  lots: TwsScaleOutLotDraft[];
  condition_price: number | null;
  condition_is_above: boolean | null;
}

export interface TwsOrderLegPreview {
  role: string;
  side: ExecutionPlanSide;
  quantity: number;
  order_type: string;
  limit_price: number | null;
  limit_offset: number | null;
  stop_price: number | null;
  trail: TwsTrailSpec | null;
  tif: string;
  good_till_date: string | null;
  parent_ref: string | null;
  oca_group: string | null;
  transmit: boolean;
  condition_price: number | null;
  condition_is_above: boolean | null;
}

export interface TwsOrderPackagePreview {
  package_id: string;
  kind: TwsAdvancedOrderKind;
  conid: number;
  symbol: string;
  warnings: string[];
  legs: TwsOrderLegPreview[];
}

export interface TwsOrderPackageLegSubmission {
  role: string;
  order_id: number;
  status: string;
}

export interface TwsOrderPackageSubmission {
  package_id: string;
  status: string;
  order_ids: number[];
  legs: TwsOrderPackageLegSubmission[];
}

export const twsApi = {
  getMode: () =>
    sidecarRequest<BrokerSessionModeResponse>("GET", "/orbit/session/mode"),
  setMode: (target: BrokerSessionSwitchTarget) =>
    sidecarRequest<BrokerSessionModeResponse>("POST", "/orbit/session/mode", { target }),
  getStatus: () =>
    sidecarRequest<TwsStatusResponse>("GET", "/execution-assistant/status"),
  connect: (req: TwsConnectRequest) =>
    sidecarRequest<TwsStatusResponse>("POST", "/execution-assistant/connect", req),
  disconnect: () =>
    sidecarRequest<TwsStatusResponse>("POST", "/execution-assistant/disconnect"),
  getReconciliation: () =>
    sidecarRequest<ReconciliationSnapshot>("GET", "/execution-assistant/reconciliation"),
  createPlanDraft: (req: ExecutionPlanDraftRequest) =>
    sidecarRequest<ExecutionPlan>("POST", "/execution-assistant/plans/draft", req),
  validatePlan: (plan_id: string) =>
    sidecarRequest<ExecutionPlan>("POST", `/execution-assistant/plans/${plan_id}/validate`),
  getPlan: (plan_id: string) =>
    sidecarRequest<ExecutionPlan>("GET", `/execution-assistant/plans/${plan_id}`),
  searchInstruments: (symbol: string) =>
    sidecarRequest<InstrumentResult[]>(
      "GET",
      `/execution-assistant/instruments/search?symbol=${encodeURIComponent(symbol)}`,
    ),
  getQuote: (conid: number) =>
    sidecarRequest<QuoteSnapshot>("GET", `/execution-assistant/instruments/${conid}/quote`),
  previewPaperOrder: (plan_id: string) =>
    sidecarRequest<PaperOrderPreview>("POST", `/execution-assistant/plans/${plan_id}/preview-paper`),
  placePaperOrder: (plan_id: string) =>
    sidecarRequest<PaperOrderSubmission>("POST", `/execution-assistant/plans/${plan_id}/place-paper`),
  getBars: (conid: number, timeframe: TwsTimeframe) =>
    sidecarRequest<BarsResponse>("GET", `/execution-assistant/instruments/${conid}/bars?timeframe=${timeframe}`),
  cancelOrder: (order_id: number) =>
    sidecarRequest<TwsOrderActionResult>("DELETE", `/execution-assistant/orders/${order_id}`),
  modifyOrder: (order_id: number, req: TwsModifyOrderRequest) =>
    sidecarRequest<TwsOrderActionResult>("PATCH", `/execution-assistant/orders/${order_id}`, req),
  overrideOrder: (req: TwsOverrideRequest) =>
    sidecarRequest<TwsOrderActionResult>("POST", "/execution-assistant/orders/override", req),
  getLiveStatus: () =>
    sidecarRequest<TwsLivePolicyStatus>("GET", "/execution-assistant/live/status"),
  allowLive: (req: TwsLiveAllowlistRequest) =>
    sidecarRequest<TwsLivePolicyStatus>("POST", "/execution-assistant/live/allow", req),
  armLive: (req: TwsLiveArmRequest) =>
    sidecarRequest<TwsLivePolicyStatus>("POST", "/execution-assistant/live/arm", req),
  disarmLive: () =>
    sidecarRequest<TwsLivePolicyStatus>("POST", "/execution-assistant/live/disarm"),
  previewLiveOrder: (plan_id: string) =>
    sidecarRequest<PaperOrderPreview>("POST", `/execution-assistant/plans/${plan_id}/preview-live`),
  placeLiveOrder: (plan_id: string) =>
    sidecarRequest<PaperOrderSubmission>("POST", `/execution-assistant/plans/${plan_id}/place-live`),
  previewOrderPackage: (req: TwsOrderPackageRequest) =>
    sidecarRequest<TwsOrderPackagePreview>("POST", "/execution-assistant/order-packages/preview", req),
  placePaperOrderPackage: (req: TwsOrderPackageRequest) =>
    sidecarRequest<TwsOrderPackageSubmission>("POST", "/execution-assistant/order-packages/place-paper", req),
  placeLiveOrderPackage: (req: TwsOrderPackageRequest) =>
    sidecarRequest<TwsOrderPackageSubmission>("POST", "/execution-assistant/order-packages/place-live", req),
  flattenPaper: (conid: number) =>
    sidecarRequest<TwsFlattenResult>("POST", `/execution-assistant/positions/${conid}/flatten-paper`),
  flattenLive: (conid: number) =>
    sidecarRequest<TwsFlattenResult>("POST", `/execution-assistant/positions/${conid}/flatten-live`),
} as const;
