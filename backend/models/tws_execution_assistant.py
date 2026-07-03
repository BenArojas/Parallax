from datetime import datetime
from typing import Literal, get_args

from pydantic import BaseModel

from models.broker_session import BrokerSessionMode
from models.tws_order_capabilities import TwsOrderType

# Ports recognized as IBKR paper environments. Unknown/live ports are read-only.
PAPER_PORTS: frozenset[int] = frozenset({4002, 7497})


class TwsConnectRequest(BaseModel):
    host: str = "127.0.0.1"
    port: int = 4002  # IB Gateway paper default; TWS paper is 7497
    client_id: int = 1


class TwsLiveAllowlistRequest(BaseModel):
    account_id: str
    host: str = "127.0.0.1"
    port: int


class TwsLiveArmRequest(BaseModel):
    account_id: str
    host: str = "127.0.0.1"
    port: int


class TwsLivePolicyStatus(BaseModel):
    connected_account_id: str | None = None
    connected_host: str = "127.0.0.1"
    connected_port: int | None = None
    is_paper_port: bool = False
    allowlisted: bool = False
    armed: bool = False
    arm_expires_on: list[str] = ["disconnect", "app_restart", "account_change"]

TwsAdapterState = Literal["not_initialized", "connecting", "connected", "disconnected", "error"]


class ReconciliationSummary(BaseModel):
    position_count: int = 0
    open_order_count: int = 0
    unmanaged_order_count: int = 0


class TwsStatusResponse(BaseModel):
    mode: BrokerSessionMode
    connected: bool
    adapter_state: TwsAdapterState
    kill_switch_active: bool
    reconciliation_summary: ReconciliationSummary
    api_server_available: bool = False  # TCP-reachable; True even before Orbit's adapter connects


class PositionSnapshot(BaseModel):
    conid: int
    symbol: str
    position: float
    avg_cost: float
    market_price: float | None = None
    market_value: float | None = None
    unrealized_pnl: float | None = None
    realized_pnl: float | None = None
    daily_pnl: float | None = None


class OrderSnapshot(BaseModel):
    order_id: int
    conid: int
    symbol: str
    side: str
    quantity: float
    order_type: str
    lmt_price: float | None = None
    stop_price: float | None = None
    status: str
    is_unmanaged: bool
    parent_id: int | None = None
    oca_group: str | None = None
    order_ref: str | None = None


TwsPackageWarningKind = Literal[
    "malformed_order_ref",
    "cross_lot_parent_id",
    "cross_lot_oca_group",
    "sell_exposure_exceeds_position",
    "unknown_role",
]


class TwsPackageWarning(BaseModel):
    kind: TwsPackageWarningKind
    severity: Literal["warning"] = "warning"
    message: str
    package_id: str | None = None
    conid: int | None = None
    symbol: str | None = None
    order_ids: list[int] = []


class ReconciliationSnapshot(BaseModel):
    position_count: int = 0
    open_order_count: int = 0
    unmanaged_order_count: int = 0
    positions: list[PositionSnapshot] = []
    open_orders: list[OrderSnapshot] = []
    package_warnings: list[TwsPackageWarning] = []


class InstrumentResult(BaseModel):
    conid: int
    symbol: str
    sec_type: str
    exchange: str
    primary_exchange: str
    currency: str
    local_symbol: str
    company_name: str


MarketDataType = Literal[
    "unknown",
    "live",
    "frozen",
    "delayed",
    "delayed_frozen",
    "partial",
    "unavailable",
]

TwsTimeframe = Literal["1m", "5m", "15m", "30m", "4h", "1D", "1W"]
TWS_TIMEFRAMES: tuple[TwsTimeframe, ...] = get_args(TwsTimeframe)


class PaperOrderPreview(BaseModel):
    plan_id: str
    conid: int
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: TwsOrderType
    limit_price: float | None
    stop_price: float | None
    tif: str  # "DAY" for MVP
    transmit: bool  # False — preview only, no placeOrder
    paper_only: bool = True


class PaperOrderSubmission(BaseModel):
    order_id: int
    status: str  # TWS-reported broker status (e.g. "PreSubmitted") or "sent_to_tws" if no callback yet
    plan_id: str
    conid: int
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: TwsOrderType
    limit_price: float | None
    stop_price: float | None
    submitted_at: datetime


class QuoteSnapshot(BaseModel):
    last: float | None = None
    close: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    bid: float | None = None
    ask: float | None = None
    market_data_type: MarketDataType = "unknown"
    is_delayed: bool = False
    unavailable_reason: str | None = None
    error_code: int | None = None


class BarSnapshot(BaseModel):
    time: int  # Unix seconds UTC
    open: float
    high: float
    low: float
    close: float
    volume: float


class BarsResponse(BaseModel):
    conid: int
    timeframe: str
    bars: list[BarSnapshot] = []


TwsStreamAction = Literal["subscribe", "unsubscribe"]
TwsStreamChannel = Literal["quote", "bars", "depth"]


class TwsStreamSubscribeRequest(BaseModel):
    action: TwsStreamAction
    channel: TwsStreamChannel
    conid: int
    timeframe: TwsTimeframe | None = None


class TwsStreamStatusEvent(BaseModel):
    type: Literal["tws_stream_status"] = "tws_stream_status"
    connected: bool


class TwsReconChangedEvent(BaseModel):
    type: Literal["tws_recon_changed"] = "tws_recon_changed"


class TwsQuoteStreamEvent(BaseModel):
    type: Literal["tws_quote"] = "tws_quote"
    conid: int
    last: float | None = None
    bid: float | None = None
    ask: float | None = None
    bid_size: float | None = None
    ask_size: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    entitlement: MarketDataType = "unknown"
    unavailable_reason: str | None = None


class TwsStreamErrorEvent(BaseModel):
    type: Literal["tws_stream_error"] = "tws_stream_error"
    message: str


class TwsBarUpdateEvent(BaseModel):
    type: Literal["tws_bar_update"] = "tws_bar_update"
    conid: int
    timeframe: TwsTimeframe
    bar: BarSnapshot


class TwsDepthLevel(BaseModel):
    price: float
    size: float
    market_maker: str | None = None


class TwsDepthUpdateEvent(BaseModel):
    type: Literal["tws_depth_update"] = "tws_depth_update"
    conid: int
    bids: list[TwsDepthLevel] = []
    asks: list[TwsDepthLevel] = []
    entitlement: MarketDataType = "unknown"
    unavailable_reason: str | None = None


class TwsOrderActionResult(BaseModel):
    order_id: int
    status: str
    action: Literal["cancel", "modify", "override"]
    message: str | None = None


class TwsModifyOrderRequest(BaseModel):
    quantity: float
    limit_price: float | None = None
    stop_price: float | None = None


class TwsAdvancedReject(BaseModel):
    order_id: int | None = None
    reason: str
    override_codes: list[str] = []
    raw: dict[str, object] | str


class TwsOverrideRequest(BaseModel):
    intent: Literal["place", "modify"]
    order_id: int | None = None
    plan_id: str | None = None
    modify: TwsModifyOrderRequest | None = None
    override_codes: list[str]


# ── Advanced order packages (Mission 2) ──────────────────────────────────────

TwsAdvancedOrderKind = Literal[
    "scale_out_ladder", "bracket", "trailing_stop", "gtd", "moc", "loc", "price_condition"
]


class TwsTrailSpec(BaseModel):
    mode: Literal["amount", "percent"]
    value: float


class TwsScaleOutLotDraft(BaseModel):
    quantity: float
    target_price: float
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    close_fallback: Literal["MOC"] = "MOC"


class TwsOrderPackageRequest(BaseModel):
    kind: TwsAdvancedOrderKind
    conid: int
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: str
    limit_price: float | None = None
    limit_offset: float | None = None
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    good_till_date: str | None = None
    target_price: float | None = None
    lots: list[TwsScaleOutLotDraft] = []
    condition_price: float | None = None
    condition_is_above: bool | None = None


class TwsOrderLegPreview(BaseModel):
    role: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: str
    limit_price: float | None = None
    limit_offset: float | None = None
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    tif: str = "DAY"
    good_till_date: str | None = None
    parent_ref: str | None = None
    oca_group: str | None = None
    transmit: bool = False
    condition_price: float | None = None
    condition_is_above: bool | None = None


class TwsOrderPackagePreview(BaseModel):
    package_id: str
    kind: TwsAdvancedOrderKind
    conid: int
    symbol: str
    warnings: list[str] = []
    legs: list[TwsOrderLegPreview]


class TwsOrderPackageLegSubmission(BaseModel):
    role: str
    order_id: int
    status: str


class TwsOrderPackageSubmission(BaseModel):
    package_id: str
    status: str
    order_ids: list[int]
    legs: list[TwsOrderPackageLegSubmission]
