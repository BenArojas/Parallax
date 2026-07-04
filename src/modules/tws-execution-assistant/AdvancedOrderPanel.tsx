import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/sidecarClient";
import { cn } from "@/lib/utils";
import {
  twsApi,
  type ExecutionPlanSide,
  type InstrumentResult,
  type TwsOrderPackagePreview,
  type TwsOrderPackageRequest,
  type TwsOrderPackageSubmission,
} from "./api";
import { RECON_KEY } from "./TwsExecutionAssistantModule";
import {
  FlowActionButton,
  FlowField,
  FlowGuidance,
  FlowRow,
  FlowSegmented,
  FlowSheet,
  FlowSummary,
  FlowSymbolSearchRow,
  FlowValueInput,
} from "./ExecutionPlanFlowSheet";

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

const KIND_ROWS: readonly (readonly AdvancedKind[])[] = [
  ["trailing_stop", "gtd", "moc"],
  ["loc", "price_condition"],
] as const;

function priceConditionSummary(preview: TwsOrderPackagePreview): string | null {
  const leg = preview.legs[0];
  if (!leg || leg.condition_price == null || leg.condition_is_above == null) return null;
  const direction = leg.condition_is_above ? "above" : "below";
  const orderDesc = leg.order_type === "LMT" && leg.limit_price != null
    ? `LMT at $${leg.limit_price.toFixed(2)}`
    : leg.order_type;
  return `Wait for ${preview.symbol} ${direction} $${leg.condition_price.toFixed(2)}, then submit ${leg.side} ${leg.quantity} ${orderDesc}.`;
}

function quantityInput(value: string): string {
  const n = Number(value);
  return n > 0 ? String(n) : "missing";
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
  onReviewLocked,
  initialConid,
  initialSymbol,
}: {
  canDraft: boolean;
  isLiveSession: boolean;
  connected: boolean;
  onInstrumentResolved: (instrument: InstrumentResult) => void;
  onReviewLocked?: (locked: boolean) => void;
  initialConid?: number;
  initialSymbol?: string;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<AdvancedKind>("trailing_stop");
  const [conid, setConid] = useState(initialConid ?? 0);
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentResult | null>(null);
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

  // Preview/submission is a review-in-progress the module can't see — publish
  // it so the module can lock mode switching instead of silently unmounting
  // this panel mid-review (same bug class as standardReviewLocked).
  useEffect(() => {
    onReviewLocked?.(preview != null || submission != null);
  }, [onReviewLocked, preview, submission]);
  useEffect(() => () => onReviewLocked?.(false), [onReviewLocked]);

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
    setSelectedInstrument(null);
    setSearchResults([]);
  }

  function resolveInstrument(r: InstrumentResult) {
    setSymbol(r.symbol);
    setConid(r.conid);
    setSelectedInstrument(r);
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
  (() => {
    if (!symbol) return "Enter a symbol.";
    if (!conid) return "Resolve symbol to get ConID.";
    if (!Number(quantity)) return "Enter quantity.";
    if (kind === "loc" && !Number(limitPrice)) return "Enter limit price.";
    if (kind === "price_condition") {
      if (!Number(conditionPrice)) return "Enter condition price.";
      if (pcOrderType === "LMT" && !Number(limitPrice)) return "Enter limit price.";
      return null;
    }
    if (kind === "trailing_stop") {
      if (!Number(trailValue)) return "Enter trail value.";
      if (trailOrderType === "TRAILLMT" && !Number(limitOffset)) return "Enter limit offset.";
      return null;
    }
    if (kind === "gtd") {
      if (!formatGoodTillDate(goodTillDate)) return "Enter good-till date.";
      if ((gtdOrderType === "LMT" || gtdOrderType === "STP LMT") && !Number(limitPrice)) return "Enter limit price.";
      if ((gtdOrderType === "STP" || gtdOrderType === "STP LMT") && !Number(stopPrice)) return "Enter stop price.";
      if ((gtdOrderType === "TRAIL" || gtdOrderType === "TRAILLMT") && !Number(trailValue)) return "Enter trail value.";
      if (gtdOrderType === "TRAILLMT" && !Number(limitOffset)) return "Enter limit offset.";
    }
    return null;
  })();
  const guidance = `Plan: ${side === "BUY" ? "Buy" : "Sell"} ${quantityInput(quantity)} ${symbol || "symbol"} with an attached rule. Review shows the exact broker effect.`;
  const estimatedNotional =
    Number(quantity) > 0 && Number(limitPrice) > 0
      ? Number(quantity) * Number(limitPrice)
      : null;

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
                className="h-9 rounded-md border border-[var(--clr-blue)] px-5 text-sm font-semibold text-[var(--clr-blue)] transition-[background-color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--clr-blue)]/10 hover:shadow-sm active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New order
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-[opacity,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:opacity-90 hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE order" : "Place PAPER order"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-[background-color,color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-0)] hover:text-[var(--text-1)] hover:shadow-sm active:scale-[0.96]"
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
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        <FlowSheet mode="advanced">
          <FlowRow id="advanced-rule" className="space-y-4">
            <FlowField label="Rule type">
              <div className="space-y-2">
                {KIND_ROWS.map((row, index) => (
                  <div key={index} className="flex justify-center">
                    <FlowSegmented
                      value={kind}
                      options={row}
                      onChange={setKind}
                      getLabel={(value) => KIND_LABEL[value]}
                      className="justify-center"
                    />
                  </div>
                ))}
              </div>
            </FlowField>
          </FlowRow>
          <FlowRow id="advanced-symbol">
            <FlowSymbolSearchRow
              mode="advanced"
              symbol={symbol}
              placeholder="INTC"
              conid={conid}
              companyName={selectedInstrument?.company_name}
              exchange={selectedInstrument?.primary_exchange || selectedInstrument?.exchange}
              currency={selectedInstrument?.currency}
              disabled={!canDraft}
              searchPending={searchMutation.isPending}
              onSymbolChange={handleSymbolChange}
              onSearch={runSearch}
              searchResults={searchResults}
              onResolve={resolveInstrument}
            />
          </FlowRow>
          <FlowRow className="grid gap-4 md:grid-cols-2">
            <div id="advanced-size">
              <FlowField label="Side">
                <FlowSegmented value={side} options={["BUY", "SELL"] as const} onChange={(value) => setSide(value as ExecutionPlanSide)} compact />
              </FlowField>
            </div>
            <FlowField label="Quantity">
              <FlowValueInput type="number" suffix="sh" value={quantity} disabled={!canDraft} onChange={(event) => setQuantity(event.target.value)} />
            </FlowField>
          </FlowRow>
          {kind === "trailing_stop" && (
            <FlowRow className="space-y-4">
              <FlowField label="Order type">
                <FlowSegmented value={trailOrderType} options={["TRAIL", "TRAILLMT"] as const} onChange={setTrailOrderType} compact />
              </FlowField>
              <div className="grid gap-4 md:grid-cols-4">
                <FlowField label="Trail mode">
                  <div className="space-y-2">
                    <FlowSegmented
                      value={trailMode}
                      options={["amount", "percent"] as const}
                      onChange={setTrailMode}
                      getLabel={(value) => value === "amount" ? "$" : "%"}
                      className="justify-center"
                    />
                    <p className="text-[10px] text-[var(--text-3)]">$ trails by a fixed amount; % trails by a share of price.</p>
                  </div>
                </FlowField>
                <FlowField label="Value">
                  <FlowValueInput type="number" step="0.01" value={trailValue} disabled={!canDraft} onChange={(event) => setTrailValue(event.target.value)} />
                </FlowField>
                {trailOrderType === "TRAILLMT" && (
                  <FlowField label="Limit offset">
                    <FlowValueInput type="number" step="0.01" value={limitOffset} disabled={!canDraft} onChange={(event) => setLimitOffset(event.target.value)} />
                  </FlowField>
                )}
              </div>
            </FlowRow>
          )}
          {kind === "gtd" && (
            <FlowRow className="space-y-4">
              <FlowField label="Order type">
                <FlowSegmented value={gtdOrderType} options={["LMT", "STP", "STP LMT", "TRAIL", "TRAILLMT"] as const} onChange={setGtdOrderType} compact />
              </FlowField>
              <div className="grid gap-4 md:grid-cols-4">
                {(gtdOrderType === "LMT" || gtdOrderType === "STP LMT") && (
                  <FlowField label="Limit">
                    <FlowValueInput type="number" step="0.01" prefix="$" value={limitPrice} disabled={!canDraft} onChange={(event) => setLimitPrice(event.target.value)} />
                  </FlowField>
                )}
                {(gtdOrderType === "STP" || gtdOrderType === "STP LMT") && (
                  <FlowField label="Stop">
                    <FlowValueInput type="number" step="0.01" prefix="$" value={stopPrice} disabled={!canDraft} onChange={(event) => setStopPrice(event.target.value)} />
                  </FlowField>
                )}
                {(gtdOrderType === "TRAIL" || gtdOrderType === "TRAILLMT") && (
                  <>
                    <FlowField label="Trail mode">
                      <FlowSegmented
                        value={trailMode}
                        options={["amount", "percent"] as const}
                        onChange={setTrailMode}
                        getLabel={(value) => value === "amount" ? "Amount $" : "Percent %"}
                      />
                    </FlowField>
                    <FlowField label="Trail value">
                      <FlowValueInput type="number" step="0.01" value={trailValue} disabled={!canDraft} onChange={(event) => setTrailValue(event.target.value)} />
                    </FlowField>
                    {gtdOrderType === "TRAILLMT" && (
                      <FlowField label="Limit offset">
                        <FlowValueInput type="number" step="0.01" value={limitOffset} disabled={!canDraft} onChange={(event) => setLimitOffset(event.target.value)} />
                      </FlowField>
                    )}
                  </>
                )}
                <FlowField label="Good till date">
                  <FlowValueInput type="datetime-local" value={goodTillDate} disabled={!canDraft} onChange={(event) => setGoodTillDate(event.target.value)} />
                </FlowField>
              </div>
            </FlowRow>
          )}
          {kind === "moc" && (
            <FlowRow>
              <p className="text-[12px] text-[var(--text-2)]">Market-on-close submits into the closing auction without a limit price.</p>
            </FlowRow>
          )}
          {kind === "loc" && (
            <FlowRow className="grid gap-4 md:grid-cols-2">
              <FlowField label="Limit">
                <FlowValueInput type="number" step="0.01" prefix="$" value={limitPrice} disabled={!canDraft} onChange={(event) => setLimitPrice(event.target.value)} />
              </FlowField>
              <p className="self-end text-[12px] text-[var(--text-2)]">Limit-on-close joins the close only if the auction price satisfies your limit.</p>
            </FlowRow>
          )}
          {kind === "price_condition" && (
            <FlowRow className="space-y-4">
              <FlowField label="Order type">
                <FlowSegmented value={pcOrderType} options={["MKT", "LMT"] as const} onChange={setPcOrderType} compact />
              </FlowField>
              <div className="grid gap-4 md:grid-cols-4">
                {pcOrderType === "LMT" && (
                  <FlowField label="Limit">
                    <FlowValueInput type="number" step="0.01" prefix="$" value={limitPrice} disabled={!canDraft} onChange={(event) => setLimitPrice(event.target.value)} />
                  </FlowField>
                )}
                <FlowField label="Condition">
                  <FlowSegmented
                    value={conditionIsAbove ? "above" : "below"}
                    options={["above", "below"] as const}
                    onChange={(value) => setConditionIsAbove(value === "above")}
                    getLabel={(value) => value === "above" ? "Above" : "Below"}
                    className="flex-nowrap justify-center"
                  />
                </FlowField>
                <FlowField label="Trigger price">
                  <FlowValueInput type="number" step="0.01" prefix="$" value={conditionPrice} disabled={!canDraft} onChange={(event) => setConditionPrice(event.target.value)} />
                </FlowField>
              </div>
            </FlowRow>
          )}
          <FlowRow>
            <FlowGuidance>{guidance}</FlowGuidance>
          </FlowRow>
          {previewMutation.isError && (
            <FlowRow>
              <div className="w-full space-y-1">
                {validationErrors(previewMutation.error).length > 0 ? (
                  validationErrors(previewMutation.error).map((error, index) => (
                    <p key={index} className="text-xs text-[var(--clr-red)]">- {error}</p>
                  ))
                ) : (
                  <p className="text-xs text-[var(--clr-red)]">Preview failed — check inputs and TWS connection.</p>
                )}
              </div>
            </FlowRow>
          )}
          <FlowRow>
            <FlowSummary notional={estimatedNotional != null ? `$${estimatedNotional.toFixed(2)}` : "--"}>
              <div className="flex flex-col gap-2 sm:items-end">
                <FlowActionButton mode="advanced" disabled={!canDraft || !req || previewMutation.isPending} onClick={() => req && previewMutation.mutate(req)}>
                  {previewMutation.isPending ? "Previewing..." : "Preview order"}
                </FlowActionButton>
              </div>
            </FlowSummary>
          </FlowRow>
        </FlowSheet>
      </div>
    </div>
  );
}
