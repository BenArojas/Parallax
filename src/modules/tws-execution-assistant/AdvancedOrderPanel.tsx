import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { ApiError } from "@/lib/sidecarClient";
import { cn } from "@/lib/utils";
import { Hint } from "./ScaleOutLadderPanel";
import {
  twsApi,
  type ExecutionPlanSide,
  type InstrumentResult,
  type TwsOrderPackagePreview,
  type TwsOrderPackageRequest,
  type TwsOrderPackageSubmission,
} from "./api";
import { RECON_KEY } from "./TwsExecutionAssistantModule";

type AdvancedKind = "trailing_stop" | "gtd" | "moc" | "loc" | "price_condition";
type TrailOrderType = "TRAIL" | "TRAILLMT";
type GtdOrderType = "LMT" | "STP" | "STP LMT" | "TRAIL" | "TRAILLMT";
type PriceConditionOrderType = "MKT" | "LMT";

/** TWS requires "yyyymmdd hh:mm:ss" (seconds mandatory — a freeform text field
 * that let a user type "16:00" without seconds got a real order canceled by
 * TWS error 343). `<input type="datetime-local">` only collects minutes, so
 * seconds are always appended as ":00". No timezone is sent; TWS then assumes
 * the session's local time-zone. */
function formatGoodTillDate(datetimeLocal: string): string | null {
  const [datePart, timePart] = datetimeLocal.split("T");
  if (!datePart || !timePart) return null;
  const withSeconds = timePart.split(":").length === 3 ? timePart : `${timePart}:00`;
  return `${datePart.replace(/-/g, "")} ${withSeconds}`;
}

const KIND_LABEL: Record<AdvancedKind, string> = {
  trailing_stop: "Trailing Stop",
  gtd: "Good-Till-Date",
  moc: "Market-on-Close",
  loc: "Limit-on-Close",
  price_condition: "Price Condition",
};

function priceConditionSummary(preview: TwsOrderPackagePreview): string | null {
  const leg = preview.legs[0];
  if (!leg || leg.condition_price == null || leg.condition_is_above == null) return null;
  const direction = leg.condition_is_above ? "above" : "below";
  const orderDesc = leg.order_type === "LMT" && leg.limit_price != null
    ? `LMT at $${leg.limit_price.toFixed(2)}`
    : leg.order_type;
  return `Wait for ${preview.symbol} ${direction} $${leg.condition_price.toFixed(2)}, then submit ${leg.side} ${leg.quantity} ${orderDesc}.`;
}

function errorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const d = err.body.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const code = (d as Record<string, unknown>).error;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function validationErrors(err: unknown): string[] {
  if (err instanceof ApiError) {
    const d = err.body.detail;
    if (d && typeof d === "object" && !Array.isArray(d) && Array.isArray((d as Record<string, unknown>).errors)) {
      return (d as Record<string, unknown>).errors as string[];
    }
  }
  return [];
}

function buildRequest(input: {
  kind: AdvancedKind;
  conid: number;
  symbol: string;
  side: ExecutionPlanSide;
  quantity: string;
  trailOrderType: TrailOrderType;
  gtdOrderType: GtdOrderType;
  limitPrice: string;
  stopPrice: string;
  trailMode: "amount" | "percent";
  trailValue: string;
  limitOffset: string;
  goodTillDate: string;
  pcOrderType: PriceConditionOrderType;
  conditionIsAbove: boolean;
  conditionPrice: string;
}): TwsOrderPackageRequest | null {
  const { kind, conid, symbol, side, quantity } = input;
  if (!conid || !symbol) return null;
  const qty = Number(quantity);
  if (!qty) return null;

  const base = {
    conid,
    symbol,
    side,
    quantity: qty,
    limit_offset: null,
    stop_price: null,
    trail: null,
    good_till_date: null,
    target_price: null,
    lots: [],
    condition_price: null,
    condition_is_above: null,
  };

  if (kind === "moc") {
    return { ...base, kind, order_type: "MOC", limit_price: null };
  }

  if (kind === "loc") {
    const limit = Number(input.limitPrice);
    if (!limit) return null;
    return { ...base, kind, order_type: "LOC", limit_price: limit };
  }

  if (kind === "price_condition") {
    const conditionPrice = Number(input.conditionPrice);
    if (!conditionPrice) return null;
    let pcLimitPrice: number | null = null;
    if (input.pcOrderType === "LMT") {
      pcLimitPrice = Number(input.limitPrice);
      if (!pcLimitPrice) return null;
    }
    return {
      ...base,
      kind,
      order_type: input.pcOrderType,
      limit_price: pcLimitPrice,
      condition_price: conditionPrice,
      condition_is_above: input.conditionIsAbove,
    };
  }

  if (kind === "trailing_stop") {
    const value = Number(input.trailValue);
    if (!value) return null;
    if (input.trailOrderType === "TRAILLMT" && !Number(input.limitOffset)) return null;
    return {
      ...base,
      kind,
      order_type: input.trailOrderType,
      limit_price: null,
      trail: { mode: input.trailMode, value },
      limit_offset: input.trailOrderType === "TRAILLMT" ? Number(input.limitOffset) : null,
    };
  }

  // gtd
  const goodTillDate = formatGoodTillDate(input.goodTillDate);
  if (!goodTillDate) return null;
  const orderType = input.gtdOrderType;
  let limit_price: number | null = null;
  let stop_price: number | null = null;
  let trail: TwsOrderPackageRequest["trail"] = null;
  if (orderType === "LMT" || orderType === "STP LMT") {
    limit_price = Number(input.limitPrice);
    if (!limit_price) return null;
  }
  if (orderType === "STP" || orderType === "STP LMT") {
    stop_price = Number(input.stopPrice);
    if (!stop_price) return null;
  }
  if (orderType === "TRAIL" || orderType === "TRAILLMT") {
    const value = Number(input.trailValue);
    if (!value) return null;
    trail = { mode: input.trailMode, value };
    if (orderType === "TRAILLMT" && !Number(input.limitOffset)) return null;
  }
  return {
    ...base,
    kind,
    order_type: orderType,
    limit_price,
    stop_price,
    trail,
    limit_offset: orderType === "TRAILLMT" ? Number(input.limitOffset) : null,
    good_till_date: goodTillDate,
  };
}

export function AdvancedOrderPanel({
  canDraft,
  isLiveSession,
  connected,
  onInstrumentResolved,
}: {
  canDraft: boolean;
  isLiveSession: boolean;
  connected: boolean;
  onInstrumentResolved: (instrument: InstrumentResult) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<AdvancedKind>("trailing_stop");
  const [conid, setConid] = useState(0);
  const [symbol, setSymbol] = useState("");
  const [searchResults, setSearchResults] = useState<InstrumentResult[]>([]);
  const [side, setSide] = useState<ExecutionPlanSide>("SELL");
  const [quantity, setQuantity] = useState("");
  const [trailOrderType, setTrailOrderType] = useState<TrailOrderType>("TRAIL");
  const [gtdOrderType, setGtdOrderType] = useState<GtdOrderType>("LMT");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [trailMode, setTrailMode] = useState<"amount" | "percent">("amount");
  const [trailValue, setTrailValue] = useState("");
  const [limitOffset, setLimitOffset] = useState("");
  const [goodTillDate, setGoodTillDate] = useState("");
  const [pcOrderType, setPcOrderType] = useState<PriceConditionOrderType>("MKT");
  const [conditionIsAbove, setConditionIsAbove] = useState(true);
  const [conditionPrice, setConditionPrice] = useState("");
  const [preview, setPreview] = useState<TwsOrderPackagePreview | null>(null);
  const [submission, setSubmission] = useState<TwsOrderPackageSubmission | null>(null);

  const searchMutation = useMutation({
    mutationFn: (sym: string) => twsApi.searchInstruments(sym),
    onSuccess: (results) => {
      setSearchResults(results);
      const stk = results.filter(
        (r) => r.sec_type === "STK" && r.exchange === "SMART" && r.currency === "USD",
      );
      if (stk.length === 1) {
        setSymbol(stk[0].symbol);
        setConid(stk[0].conid);
        onInstrumentResolved(stk[0]);
        setSearchResults([]);
      }
    },
  });

  function runSearch() {
    if (symbol && connected) searchMutation.mutate(symbol);
  }

  function handleSymbolChange(value: string) {
    setSymbol(value.toUpperCase());
    setConid(0);
    setSearchResults([]);
  }

  function resolveInstrument(r: InstrumentResult) {
    setSymbol(r.symbol);
    setConid(r.conid);
    onInstrumentResolved(r);
    setSearchResults([]);
  }

  const previewMutation = useMutation({
    mutationFn: (req: TwsOrderPackageRequest) => twsApi.previewOrderPackage(req),
    onSuccess: (result) => {
      setPreview(result);
      setSubmission(null);
    },
  });

  const submitMutation = useMutation({
    mutationFn: (req: TwsOrderPackageRequest) =>
      isLiveSession ? twsApi.placeLiveOrderPackage(req) : twsApi.placePaperOrderPackage(req),
    onSuccess: (result) => {
      setSubmission(result);
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
    },
  });

  const req = buildRequest({
    kind, conid, symbol, side, quantity, trailOrderType, gtdOrderType,
    limitPrice, stopPrice, trailMode, trailValue, limitOffset, goodTillDate,
    pcOrderType, conditionIsAbove, conditionPrice,
  });

  if (preview) {
    return (
      <div className={cn("flex h-full flex-col", !canDraft && "opacity-45")}>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pb-2">
          <div className="flex items-center justify-between rounded border border-border/60 bg-[var(--bg-0)] px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">
              Package {preview.package_id.slice(0, 8)}
            </span>
            <span className={cn("text-[10px] font-semibold", isLiveSession ? "text-[var(--clr-red)]" : "text-[var(--clr-green)]")}>
              {isLiveSession ? "LIVE" : "PAPER"}
            </span>
          </div>
          {preview.kind === "price_condition" && priceConditionSummary(preview) && (
            <div className="rounded border border-[var(--clr-blue)]/25 bg-[var(--glow-blue)] px-3 py-2 text-xs text-[var(--text-2)]">
              {priceConditionSummary(preview)}
            </div>
          )}
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-[var(--text-3)]">
                <th className="pb-1 pr-2 font-medium">Role</th>
                <th className="pb-1 pr-2 font-medium">Side</th>
                <th className="pb-1 pr-2 font-medium">Qty</th>
                <th className="pb-1 pr-2 font-medium">Type</th>
                <th className="pb-1 pr-2 font-medium">Price</th>
                <th className="pb-1 pr-2 font-medium">TIF</th>
                <th className="pb-1 font-medium">Transmit</th>
              </tr>
            </thead>
            <tbody>
              {preview.legs.map((leg, i) => (
                <tr key={i} className="border-t border-border/60">
                  <td className="py-1 pr-2 font-medium">{leg.role}</td>
                  <td className={cn("pr-2", leg.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]")}>{leg.side}</td>
                  <td className="pr-2 font-data">{leg.quantity}</td>
                  <td className="pr-2 font-data text-[var(--text-2)]">{leg.order_type}</td>
                  <td className="pr-2 font-data text-[var(--text-2)]">
                    {leg.trail != null
                      ? `trail ${leg.trail.value}${leg.trail.mode === "percent" ? "%" : ""}${leg.limit_offset != null ? ` +${leg.limit_offset}` : ""}`
                      : (leg.limit_price ?? leg.stop_price ?? "—")}
                  </td>
                  <td className="pr-2 text-[var(--text-3)]">
                    {leg.tif}{leg.good_till_date ? ` · ${leg.good_till_date}` : ""}
                  </td>
                  <td className="font-data text-[var(--text-3)]">{leg.transmit ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {submission && (
            <div className="rounded border border-[var(--clr-green)]/30 bg-[var(--glow-green)] p-3 text-[11px]">
              <p className="font-semibold text-[var(--clr-green)]">
                Sent — {submission.order_ids.length} order(s), status {submission.status}.
              </p>
            </div>
          )}
        </div>

        <div className="shrink-0 flex flex-col gap-2 pt-2">
          {submitMutation.isError && (
            <p className="text-xs text-[var(--clr-red)]">
              {errorCode(submitMutation.error) === "live_session_not_armed" || errorCode(submitMutation.error) === "live_session_not_allowlisted"
                ? "Live trading is not armed — arm it above before submitting."
                : "Submit failed — check TWS connection and try again."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {submission ? (
              <button
                type="button"
                className="h-9 rounded-md border border-[var(--clr-blue)] px-5 text-sm font-semibold text-[var(--clr-blue)] transition-colors hover:bg-[var(--clr-blue)]/10 active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New order
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE order" : "Place PAPER order"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--bg-0)] hover:text-[var(--text-1)]"
                  onClick={() => setPreview(null)}
                >
                  Edit order
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col", !canDraft && "opacity-45")}>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 pb-2">
        <div className="flex overflow-hidden rounded border border-border text-[11px] font-semibold">
          {(["trailing_stop", "gtd", "moc", "loc", "price_condition"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={cn(
                "flex-1 px-2 py-1.5 transition-colors",
                kind === k ? "bg-[var(--clr-blue)] text-[var(--bg-0)]" : "text-[var(--text-2)] hover:bg-[var(--bg-0)]",
              )}
              disabled={!canDraft}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[var(--text-2)]">Symbol</span>
            <div className="relative">
              <input
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 pr-9 text-sm uppercase outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                placeholder="e.g. INTC"
                value={symbol}
                disabled={!canDraft}
                onChange={(e) => handleSymbolChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
              />
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-[var(--text-3)] hover:text-[var(--clr-blue)] disabled:cursor-not-allowed"
                disabled={!canDraft || !symbol || searchMutation.isPending}
                onClick={runSearch}
                tabIndex={-1}
              >
                <Search className="h-4 w-4" strokeWidth={1.7} />
              </button>
            </div>
            {searchResults.length > 1 && (
              <ul className="mt-0.5 rounded border border-border bg-[var(--bg-0)] shadow-md">
                {searchResults.map((r) => (
                  <li key={r.conid}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] hover:bg-[var(--bg-1)]"
                      onClick={() => resolveInstrument(r)}
                    >
                      <span className="font-medium">{r.symbol}</span>
                      <span className="text-[var(--text-3)]">
                        {r.sec_type} · {r.primary_exchange || r.exchange} · {r.currency}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {conid > 0 && searchResults.length === 0 && (
              <span className="text-[10px] text-[var(--text-3)]">conid {conid}</span>
            )}
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-2)]">Side</span>
            <select
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
              value={side}
              disabled={!canDraft}
              onChange={(e) => setSide(e.target.value as ExecutionPlanSide)}
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-2)]">Quantity</span>
            <input
              type="number"
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
              value={quantity}
              disabled={!canDraft}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
        </div>

        {kind === "trailing_stop" && (
          <>
            <div className="rounded border border-[var(--clr-blue)]/25 bg-[var(--glow-blue)] px-4 py-3 text-xs leading-5 text-[var(--text-2)]">
              A trailing stop's trigger price follows the market in your favor, then locks in and
              fires once price reverses by your trail amount. Selling: it trails below the highs
              and fires if price drops back down. Buying a stock you don't own yet: it trails above
              the lows as price keeps falling, then fires once price bounces back up — a way to
              catch a reversal without having to guess the exact bottom.
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Order type</span>
                <select
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={trailOrderType}
                  disabled={!canDraft}
                  onChange={(e) => setTrailOrderType(e.target.value as TrailOrderType)}
                >
                  <option value="TRAIL">TRAIL</option>
                  <option value="TRAILLMT">TRAILLMT</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Trail</span>
                <select
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={trailMode}
                  disabled={!canDraft}
                  onChange={(e) => setTrailMode(e.target.value as "amount" | "percent")}
                >
                  <option value="amount">Amount $</option>
                  <option value="percent">Percent %</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Value</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={trailValue}
                  disabled={!canDraft}
                  onChange={(e) => setTrailValue(e.target.value)}
                />
              </label>
              {trailOrderType === "TRAILLMT" && (
                <label className="space-y-1.5">
                  <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-2)]">
                    Limit offset <Hint text="How far below (sell) or above (buy) the trail's trigger price the limit is set once it fires." />
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                    value={limitOffset}
                    disabled={!canDraft}
                    onChange={(e) => setLimitOffset(e.target.value)}
                  />
                </label>
              )}
            </div>
          </>
        )}

        {kind === "gtd" && (
          <div className="grid gap-3 md:grid-cols-4">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-2)]">Order type</span>
              <select
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                value={gtdOrderType}
                disabled={!canDraft}
                onChange={(e) => setGtdOrderType(e.target.value as GtdOrderType)}
              >
                <option value="LMT">LMT</option>
                <option value="STP">STP</option>
                <option value="STP LMT">STP LMT</option>
                <option value="TRAIL">TRAIL</option>
                <option value="TRAILLMT">TRAILLMT</option>
              </select>
            </label>
            {(gtdOrderType === "LMT" || gtdOrderType === "STP LMT") && (
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Limit</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={limitPrice}
                  disabled={!canDraft}
                  onChange={(e) => setLimitPrice(e.target.value)}
                />
              </label>
            )}
            {(gtdOrderType === "STP" || gtdOrderType === "STP LMT") && (
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Stop</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={stopPrice}
                  disabled={!canDraft}
                  onChange={(e) => setStopPrice(e.target.value)}
                />
              </label>
            )}
            {(gtdOrderType === "TRAIL" || gtdOrderType === "TRAILLMT") && (
              <>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-[var(--text-2)]">Trail</span>
                  <select
                    className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                    value={trailMode}
                    disabled={!canDraft}
                    onChange={(e) => setTrailMode(e.target.value as "amount" | "percent")}
                  >
                    <option value="amount">Amount $</option>
                    <option value="percent">Percent %</option>
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-[var(--text-2)]">Value</span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                    value={trailValue}
                    disabled={!canDraft}
                    onChange={(e) => setTrailValue(e.target.value)}
                  />
                </label>
              </>
            )}
            {gtdOrderType === "TRAILLMT" && (
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Limit offset</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={limitOffset}
                  disabled={!canDraft}
                  onChange={(e) => setLimitOffset(e.target.value)}
                />
              </label>
            )}
            <label className="space-y-1.5 md:col-span-2">
              <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-2)]">
                Good till <Hint text="The order stays working until this date and time, in your local time zone." />
              </span>
              <input
                type="datetime-local"
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                value={goodTillDate}
                disabled={!canDraft}
                onChange={(e) => setGoodTillDate(e.target.value)}
              />
            </label>
          </div>
        )}

        {kind === "loc" && (
          <div className="grid gap-3 md:grid-cols-4">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-2)]">Limit</span>
              <input
                type="number"
                step="0.01"
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                value={limitPrice}
                disabled={!canDraft}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
            </label>
          </div>
        )}

        {kind === "price_condition" && (
          <>
            <div className="rounded border border-[var(--clr-blue)]/25 bg-[var(--glow-blue)] px-4 py-3 text-xs leading-5 text-[var(--text-2)]">
              Waits and watches — the order only submits once the last trade trades above or
              below the price you set. One condition only, no autonomous market watching beyond
              this single check.
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Condition</span>
                <select
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={conditionIsAbove ? "above" : "below"}
                  disabled={!canDraft}
                  onChange={(e) => setConditionIsAbove(e.target.value === "above")}
                >
                  <option value="above">Trades above</option>
                  <option value="below">Trades below</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Condition price</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={conditionPrice}
                  disabled={!canDraft}
                  onChange={(e) => setConditionPrice(e.target.value)}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Order type</span>
                <select
                  className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                  value={pcOrderType}
                  disabled={!canDraft}
                  onChange={(e) => setPcOrderType(e.target.value as PriceConditionOrderType)}
                >
                  <option value="MKT">MKT</option>
                  <option value="LMT">LMT</option>
                </select>
              </label>
              {pcOrderType === "LMT" && (
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-[var(--text-2)]">Limit</span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-blue)] disabled:cursor-not-allowed"
                    value={limitPrice}
                    disabled={!canDraft}
                    onChange={(e) => setLimitPrice(e.target.value)}
                  />
                </label>
              )}
            </div>
          </>
        )}
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          className="h-9 rounded-md border border-[var(--clr-blue)] px-4 text-sm font-semibold text-[var(--clr-blue)] transition-colors hover:bg-[var(--clr-blue)]/10 active:scale-[0.96] disabled:opacity-50"
          disabled={!canDraft || !req || previewMutation.isPending}
          onClick={() => req && previewMutation.mutate(req)}
        >
          {previewMutation.isPending ? "Previewing..." : `Preview ${KIND_LABEL[kind].toLowerCase()}`}
        </button>
        {!req && (
          <span className="text-[11px] text-[var(--text-3)]">
            {!symbol
              ? "Enter a symbol to search."
              : !conid
                ? "Search and resolve the symbol first — click the search icon or press Enter."
                : "Fill quantity and this order type's required fields."}
          </span>
        )}
        {previewMutation.isError && (
          <div className="w-full space-y-1">
            {validationErrors(previewMutation.error).length > 0 ? (
              validationErrors(previewMutation.error).map((e, i) => (
                <p key={i} className="text-xs text-[var(--clr-red)]">- {e}</p>
              ))
            ) : (
              <p className="text-xs text-[var(--clr-red)]">Preview failed — check inputs and TWS connection.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
