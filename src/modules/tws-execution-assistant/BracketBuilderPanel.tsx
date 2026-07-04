import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import type { PlanChartLine } from "./TwsCandleChart";
import { RECON_KEY } from "./TwsExecutionAssistantModule";

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

function quantityInput(value: string): string {
  const n = Number(value);
  return n > 0 ? String(n) : "missing";
}

function bracketSentence(side: ExecutionPlanSide, quantity: string, symbol: string, targetPrice: string, useTrail: boolean, stopPrice: string, trailValue: string): string {
  const action = side === "BUY" ? "Buy" : "Sell";
  const ticker = symbol || "symbol";
  const target = Number(targetPrice) > 0 ? `$${Number(targetPrice).toFixed(2)}` : "a target";
  const protection = useTrail
    ? Number(trailValue) > 0 ? `a trail of $${Number(trailValue).toFixed(2)}` : "a trail"
    : Number(stopPrice) > 0 ? `a stop at $${Number(stopPrice).toFixed(2)}` : "a stop";
  return `Plan: ${action} ${quantityInput(quantity)} ${ticker}. If filled, attach ${target} and ${protection}.`;
}

/** Build the request from raw form inputs, or null while required fields are incomplete. */
function buildRequest(
  conid: number,
  symbol: string,
  side: ExecutionPlanSide,
  quantity: string,
  orderType: "MKT" | "LMT",
  limitPrice: string,
  targetPrice: string,
  useTrail: boolean,
  stopPrice: string,
  trailValue: string,
): TwsOrderPackageRequest | null {
  if (!conid || !symbol) return null;
  const qty = Number(quantity);
  if (!qty) return null;
  const target = Number(targetPrice);
  if (!target) return null;
  if (orderType === "LMT" && !Number(limitPrice)) return null;

  let stop_price: number | null = null;
  let trail: TwsOrderPackageRequest["trail"] = null;
  if (useTrail) {
    const value = Number(trailValue);
    if (!value) return null;
    trail = { mode: "amount", value };
  } else {
    const parsedStop = Number(stopPrice);
    if (!parsedStop) return null;
    stop_price = parsedStop;
  }

  return {
    kind: "bracket",
    conid,
    symbol,
    side,
    quantity: qty,
    order_type: orderType,
    limit_price: orderType === "LMT" ? Number(limitPrice) : null,
    limit_offset: null,
    stop_price,
    trail,
    good_till_date: null,
    target_price: target,
    lots: [],
    condition_price: null,
    condition_is_above: null,
  };
}

export function BracketBuilderPanel({
  canDraft,
  isLiveSession,
  connected,
  onInstrumentResolved,
  onChartLines,
  onReviewLocked,
  initialConid,
  initialSymbol,
}: {
  canDraft: boolean;
  isLiveSession: boolean;
  connected: boolean;
  onInstrumentResolved: (instrument: InstrumentResult) => void;
  onChartLines?: (conid: number, lines: PlanChartLine[]) => void;
  onReviewLocked?: (locked: boolean) => void;
  initialConid?: number;
  initialSymbol?: string;
}) {
  const queryClient = useQueryClient();
  const [conid, setConid] = useState(initialConid ?? 0);
  const [symbol, setSymbol] = useState(initialSymbol ?? "");
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentResult | null>(null);
  const [searchResults, setSearchResults] = useState<InstrumentResult[]>([]);
  const [side, setSide] = useState<ExecutionPlanSide>("BUY");
  const [quantity, setQuantity] = useState("");
  const [riskDollars, setRiskDollars] = useState("");
  const [orderType, setOrderType] = useState<"MKT" | "LMT">("LMT");
  const [limitPrice, setLimitPrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [useTrail, setUseTrail] = useState(false);
  const [stopPrice, setStopPrice] = useState("");
  const [trailValue, setTrailValue] = useState("");
  const [preview, setPreview] = useState<TwsOrderPackagePreview | null>(null);
  const [submission, setSubmission] = useState<TwsOrderPackageSubmission | null>(null);

  // Preview/submission is a review-in-progress the module can't see — publish
  // it so the module can lock mode switching instead of silently unmounting
  // this panel mid-review (same bug class as standardReviewLocked).
  useEffect(() => {
    onReviewLocked?.(preview != null || submission != null);
  }, [onReviewLocked, preview, submission]);
  useEffect(() => () => onReviewLocked?.(false), [onReviewLocked]);

  useEffect(() => {
    if (!onChartLines) return;
    const lines: PlanChartLine[] = [];
    const entry = Number(limitPrice);
    if (orderType === "LMT" && entry > 0) {
      lines.push({
        id: "bracket-entry", price: Math.round(entry * 100) / 100, kind: "entry", label: "Entry",
        onDrag: (p) => setLimitPrice(String(p)),
      });
    }
    const tp = Number(targetPrice);
    if (tp > 0) {
      lines.push({
        id: "bracket-target", price: Math.round(tp * 100) / 100, kind: "target", label: "Target",
        onDrag: (p) => setTargetPrice(String(p)),
      });
    }
    const sp = Number(stopPrice);
    if (!useTrail && sp > 0) {
      lines.push({
        id: "bracket-stop", price: Math.round(sp * 100) / 100, kind: "stop", label: "Stop",
        onDrag: (p) => setStopPrice(String(p)),
      });
    }
    onChartLines(conid, lines);
  }, [onChartLines, conid, orderType, limitPrice, targetPrice, stopPrice, useTrail]);

  useEffect(() => () => onChartLines?.(0, []), [onChartLines]);

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

  const req = buildRequest(conid, symbol, side, quantity, orderType, limitPrice, targetPrice, useTrail, stopPrice, trailValue);
  const guidance = bracketSentence(side, quantity, symbol, targetPrice, useTrail, stopPrice, trailValue);

  // Risk sizing: bracket has no live quote prop, so entryRef is limit-price-only.
  const riskEntryRef = Number(limitPrice) > 0 ? Number(limitPrice) : null;
  const riskStopRef = !useTrail && Number(stopPrice) > 0 ? Number(stopPrice) : null;
  const riskPerShare = riskEntryRef != null && riskStopRef != null ? Math.abs(riskEntryRef - riskStopRef) : null;
  const riskSizingDisabledReason =
    riskEntryRef == null
      ? "Set a limit price (or wait for a quote) to size by risk"
      : riskStopRef == null
        ? "Risk sizing needs a stop price"
        : null;
  const riskHint =
    riskPerShare != null && riskPerShare > 0 && Number(riskDollars) > 0
      ? `risk $${Number(riskDollars).toFixed(2)} / ${riskPerShare.toFixed(2)} per share → ${Math.floor(Number(riskDollars) / riskPerShare)}`
      : null;

  // Keep quantity synced while a risk figure is active — editing the limit or
  // stop after entering risk changes risk-per-share, and a stale size would no
  // longer match the stop. Manual quantity edits clear riskDollars, disarming
  // this.
  useEffect(() => {
    const risk = Number(riskDollars);
    if (!(risk > 0) || riskPerShare == null || riskPerShare === 0) return;
    setQuantity(String(Math.max(0, Math.floor(risk / riskPerShare))));
  }, [riskDollars, riskPerShare]);

  function handleQuantityChange(value: string) {
    setQuantity(value);
    setRiskDollars("");
  }
  const estimatedNotional =
    Number(quantity) > 0 && orderType === "LMT" && Number(limitPrice) > 0
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
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-[var(--text-3)]">
                <th className="pb-1 pr-2 font-medium">Role</th>
                <th className="pb-1 pr-2 font-medium">Side</th>
                <th className="pb-1 pr-2 font-medium">Qty</th>
                <th className="pb-1 pr-2 font-medium">Type</th>
                <th className="pb-1 pr-2 font-medium">Price</th>
                <th className="pb-1 pr-2 font-medium">
                  <span className="inline-flex items-center gap-1">Parent <Hint text="The target and stop only activate once the parent entry fills. Filling either one cancels the other." /></span>
                </th>
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
                      ? `trail ${leg.trail.value}${leg.trail.mode === "percent" ? "%" : ""}`
                      : (leg.limit_price ?? leg.stop_price ?? "—")}
                  </td>
                  <td className="pr-2 text-[var(--text-3)]">{leg.parent_ref ?? "— (parent)"}</td>
                  <td className="font-data text-[var(--text-3)]">{leg.transmit ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {submission && (
            <div className="rounded border border-[var(--clr-green)]/30 bg-[var(--glow-green)] p-3 text-[11px]">
              <p className="font-semibold text-[var(--clr-green)]">
                Sent — {submission.order_ids.length} orders, status {submission.status}.
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
                className="h-9 rounded-md border border-[var(--clr-orange)] px-5 text-sm font-semibold text-[var(--clr-orange)] transition-[background-color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--clr-orange)]/10 hover:shadow-sm active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New bracket
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-[opacity,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:opacity-90 hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE bracket" : "Place PAPER bracket"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-[background-color,color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-0)] hover:text-[var(--text-1)] hover:shadow-sm active:scale-[0.96]"
                  onClick={() => setPreview(null)}
                >
                  Edit bracket
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
        <FlowSheet mode="bracket">
          <FlowRow id="bracket-symbol">
            <FlowSymbolSearchRow
              mode="bracket"
              symbol={symbol}
              placeholder="TSLA"
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
          <FlowRow className="grid gap-4 md:grid-cols-3">
            <div id="bracket-size">
              <FlowField label="Side">
                <FlowSegmented
                  value={side}
                  options={["BUY", "SELL"] as const}
                  onChange={setSide}
                  compact
                />
              </FlowField>
            </div>
            <FlowField label="Quantity">
              <FlowValueInput
                type="number"
                suffix="sh"
                value={quantity}
                disabled={!canDraft}
                onChange={(event) => handleQuantityChange(event.target.value)}
              />
            </FlowField>
            <FlowField label="Risk $" title="Sizes the position to lose about this much if your stop is hit.">
              <FlowValueInput
                type="number"
                step="0.01"
                prefix="$"
                placeholder="0.00"
                value={riskDollars}
                disabled={!canDraft || riskSizingDisabledReason != null}
                title={riskSizingDisabledReason ?? undefined}
                onChange={(event) => setRiskDollars(event.target.value)}
              />
              {riskHint && <p className="mt-1 text-[10px] text-[var(--text-3)]">{riskHint}</p>}
            </FlowField>
          </FlowRow>
          <FlowRow id="bracket-entry" className="space-y-4">
              <FlowField label="Entry type">
                <FlowSegmented
                  value={orderType}
                  options={["MKT", "LMT"] as const}
                  onChange={setOrderType}
                  compact
                />
              </FlowField>
            <div className="grid gap-4 md:grid-cols-2">
              {orderType === "LMT" && (
                <FlowField label="Entry limit">
                  <FlowValueInput
                    type="number"
                    step="0.01"
                    prefix="$"
                    placeholder="0.00"
                    value={limitPrice}
                    disabled={!canDraft}
                    onChange={(event) => setLimitPrice(event.target.value)}
                  />
                </FlowField>
              )}
              <FlowField label="Target">
                <FlowValueInput
                  type="number"
                  step="0.01"
                  prefix="$"
                  placeholder="0.00"
                  value={targetPrice}
                  disabled={!canDraft}
                  onChange={(event) => setTargetPrice(event.target.value)}
                />
              </FlowField>
            </div>
            <div id="bracket-exit" className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <FlowField label="Protection">
                <div className="space-y-2">
                  <FlowSegmented
                    value={useTrail ? "TRAIL" : "STOP"}
                    options={["STOP", "TRAIL"] as const}
                    onChange={(value) => setUseTrail(value === "TRAIL")}
                    className="justify-center"
                  />
                  <p className="text-[10px] text-[var(--text-3)]">
                    {useTrail ? "Trail follows price until it snaps back." : "Fixed stop stays at one price."}
                  </p>
                </div>
              </FlowField>
              <FlowField label={useTrail ? "Trail amount" : "Stop price"}>
                <FlowValueInput
                  type="number"
                  step="0.01"
                  prefix="$"
                  placeholder="0.00"
                  value={useTrail ? trailValue : stopPrice}
                  disabled={!canDraft}
                  onChange={(event) => useTrail ? setTrailValue(event.target.value) : setStopPrice(event.target.value)}
                />
              </FlowField>
            </div>
          </FlowRow>
          <FlowRow>
            <FlowGuidance>{guidance}</FlowGuidance>
          </FlowRow>
          {previewMutation.isError && (
            <FlowRow>
              <div className="space-y-1 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2">
                {validationErrors(previewMutation.error).length > 0 ? (
                  validationErrors(previewMutation.error).map((error, index) => (
                    <p key={index} className="text-xs text-red-300">- {error}</p>
                  ))
                ) : (
                  <p className="text-xs text-red-300">Preview failed — check inputs and TWS connection.</p>
                )}
              </div>
            </FlowRow>
          )}
          <FlowRow>
            <FlowSummary notional={estimatedNotional != null ? `$${estimatedNotional.toFixed(2)}` : "--"}>
              <div className="flex flex-col gap-2 sm:items-end">
                <FlowActionButton
                  mode="bracket"
                  disabled={!canDraft || !req || previewMutation.isPending}
                  onClick={() => req && previewMutation.mutate(req)}
                >
                  {previewMutation.isPending ? "Previewing..." : "Preview bracket"}
                </FlowActionButton>
              </div>
            </FlowSummary>
          </FlowRow>
        </FlowSheet>
      </div>
    </div>
  );
}
