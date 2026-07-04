import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/sidecarClient";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  twsApi,
  type InstrumentResult,
  type TwsOrderPackagePreview,
  type TwsOrderPackageRequest,
  type TwsOrderPackageSubmission,
  type TwsScaleOutLotDraft,
} from "./api";
import type { PlanChartLine } from "./TwsCandleChart";
import { RECON_KEY } from "./TwsExecutionAssistantModule";
import { ScaleOutScenarioCalculator } from "./ScaleOutScenarioCalculator";
import type { ScaleOutScenarioLot } from "./scaleOutScenario";
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

interface LotInput {
  quantity: string;
  target_price: string;
  stop_price: string;
  trail_value: string;
  use_trail: boolean;
}

const EMPTY_LOT: LotInput = { quantity: "", target_price: "", stop_price: "", trail_value: "", use_trail: false };

/** The same scale-out breakout scenario described in the design doc's user story. */
const EXAMPLE = {
  conid: 270639,
  symbol: "INTC",
  limitPrice: "120",
  lots: [
    { ...EMPTY_LOT, quantity: "5", target_price: "125", stop_price: "118" },
    { ...EMPTY_LOT, quantity: "5", target_price: "130", stop_price: "118" },
    { ...EMPTY_LOT, quantity: "10", target_price: "135", use_trail: true, trail_value: "2" },
  ],
};

export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[var(--text-3)] text-[8px] leading-none text-[var(--text-3)]">
            ?
          </span>
        }
      />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
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

/** Build the request from raw form inputs, or null while required fields are incomplete. */
function buildRequest(conid: number, symbol: string, orderType: "MKT" | "LMT", limitPrice: string, lots: LotInput[]): TwsOrderPackageRequest | null {
  if (!conid || !symbol || lots.length === 0) return null;
  const parsedLots: TwsScaleOutLotDraft[] = [];
  for (const lot of lots) {
    const quantity = Number(lot.quantity);
    const target_price = Number(lot.target_price);
    if (!quantity || !target_price) return null;
    if (lot.use_trail) {
      const value = Number(lot.trail_value);
      if (!value) return null;
      parsedLots.push({ quantity, target_price, stop_price: null, trail: { mode: "amount", value }, close_fallback: "MOC" });
    } else {
      const stop_price = Number(lot.stop_price);
      if (!stop_price) return null;
      parsedLots.push({ quantity, target_price, stop_price, trail: null, close_fallback: "MOC" });
    }
  }
  if (orderType === "LMT" && !Number(limitPrice)) return null;

  return {
    kind: "scale_out_ladder",
    conid,
    symbol,
    side: "BUY",
    quantity: parsedLots.reduce((sum, l) => sum + l.quantity, 0),
    order_type: orderType,
    limit_price: orderType === "LMT" ? Number(limitPrice) : null,
    limit_offset: null,
    stop_price: null,
    trail: null,
    good_till_date: null,
    target_price: null,
    lots: parsedLots,
    condition_price: null,
    condition_is_above: null,
  };
}

function scaleOutSentence(quantity: number, symbol: string): string {
  return `Plan: Buy ${quantity > 0 ? quantity : "missing"} ${symbol || "symbol"}, then stage each lot with its own exit and protection. Review before sending.`;
}

export function ScaleOutLadderPanel({
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
  const [orderType, setOrderType] = useState<"MKT" | "LMT">("LMT");
  const [limitPrice, setLimitPrice] = useState("");
  const [lots, setLots] = useState<LotInput[]>([{ ...EMPTY_LOT }, { ...EMPTY_LOT }]);
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
        id: "ladder-entry", price: Math.round(entry * 100) / 100, kind: "entry", label: "Entry",
        onDrag: (p) => setLimitPrice(String(p)),
      });
    }
    lots.forEach((lot, i) => {
      const tp = Number(lot.target_price);
      if (tp > 0) {
        lines.push({
          id: `ladder-t${i}`, price: Math.round(tp * 100) / 100, kind: "target", label: `T${i + 1}`,
          onDrag: (p) => setLots((ls) => ls.map((l, j) => (j === i ? { ...l, target_price: String(p) } : l))),
        });
      }
      const sp = Number(lot.stop_price);
      if (!lot.use_trail && sp > 0) {
        lines.push({
          id: `ladder-s${i}`, price: Math.round(sp * 100) / 100, kind: "stop", label: `S${i + 1}`,
          onDrag: (p) => setLots((ls) => ls.map((l, j) => (j === i ? { ...l, stop_price: String(p) } : l))),
        });
      }
    });
    onChartLines(conid, lines);
  }, [onChartLines, conid, orderType, limitPrice, lots]);

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

  function updateLot(i: number, patch: Partial<LotInput>) {
    setLots((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function loadExample() {
    setConid(EXAMPLE.conid);
    setSymbol(EXAMPLE.symbol);
    setOrderType("LMT");
    setLimitPrice(EXAMPLE.limitPrice);
    setLots(EXAMPLE.lots.map((l) => ({ ...l })));
    previewMutation.reset();
    setPreview(null);
    setSubmission(null);
  }

  const req = buildRequest(conid, symbol, orderType, limitPrice, lots);
  const totalQty = lots.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
  const entryPrice = orderType === "LMT" ? Number(limitPrice) || null : null;
  const scenarioLots: ScaleOutScenarioLot[] = lots.map((l) => ({
    quantity: Number(l.quantity) || 0,
    targetPrice: Number(l.target_price) || 0,
    stopPrice: l.use_trail ? null : Number(l.stop_price) || null,
    trailAmount: l.use_trail ? Number(l.trail_value) || null : null,
  }));
  const estimatedNotional =
    Number(limitPrice) > 0 && totalQty > 0
      ? Number(limitPrice) * totalQty
      : null;
  const guidance = scaleOutSentence(totalQty, symbol);
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
                  <span className="inline-flex items-center gap-1">Parent <Hint text="Each lot's exits only activate once that lot's own entry order fills." /></span>
                </th>
                <th className="pb-1 pr-2 font-medium">
                  <span className="inline-flex items-center gap-1">OCA <Hint text="One-Cancels-All group. If one exit in the group fires, the others in that same lot are cancelled — so a lot can never be sold twice." /></span>
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
                  <td className="pr-2 text-[var(--text-3)]">{leg.oca_group ? leg.oca_group.split("-").pop() : "—"}</td>
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
                className="h-9 rounded-md border border-[var(--clr-cyan)] px-5 text-sm font-semibold text-[var(--clr-cyan)] transition-[background-color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--clr-cyan)]/10 hover:shadow-sm active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New ladder
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-[opacity,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:opacity-90 hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE ladder" : "Place PAPER ladder"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-[background-color,color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-0)] hover:text-[var(--text-1)] hover:shadow-sm active:scale-[0.96]"
                  onClick={() => setPreview(null)}
                >
                  Edit ladder
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
        <FlowSheet mode="scale_out">
          <FlowRow id="scale-symbol">
            <FlowSymbolSearchRow
              mode="scale_out"
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
          <FlowRow id="scale-entry" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <FlowField label="Entry type">
                <FlowSegmented
                  value={orderType}
                  options={["LMT", "MKT"] as const}
                  onChange={setOrderType}
                  compact
                  className="flex-nowrap"
                />
              </FlowField>
              <button
                type="button"
                className="rounded-full border border-dashed border-[var(--clr-purple)]/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--clr-purple)] transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--clr-purple)]/10 hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canDraft}
                onClick={loadExample}
              >
                Load example
              </button>
            </div>
            {orderType === "LMT" && (
              <FlowField label="Entry limit">
                <FlowValueInput
                  type="number"
                  step="0.01"
                  prefix="$"
                  value={limitPrice}
                  disabled={!canDraft}
                  onChange={(event) => setLimitPrice(event.target.value)}
                />
              </FlowField>
            )}
          </FlowRow>
          <FlowRow id="scale-lots" className="space-y-3">
            {lots.map((lot, index) => (
              <div key={index} className="space-y-3 rounded-xl border border-border/70 bg-[var(--bg-0)] px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">Lot</div>
                    <div className="font-data text-[16px] text-[var(--clr-purple)]">{index + 1}</div>
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-[var(--clr-red)]/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--clr-red)] transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--clr-red)]/10 hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canDraft || lots.length <= 1}
                    onClick={() => setLots((previous) => previous.filter((_, lotIndex) => lotIndex !== index))}
                  >
                    Remove
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <FlowField label="Qty">
                    <FlowValueInput
                      type="number"
                      value={lot.quantity}
                      disabled={!canDraft}
                      onChange={(event) => updateLot(index, { quantity: event.target.value })}
                    />
                  </FlowField>
                  <FlowField label="Target">
                    <FlowValueInput
                      type="number"
                      step="0.01"
                      prefix="$"
                      value={lot.target_price}
                      disabled={!canDraft}
                      onChange={(event) => updateLot(index, { target_price: event.target.value })}
                    />
                  </FlowField>
                </div>
                <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_96px] md:items-end">
                  <div className="space-y-2">
                    <FlowField label="Protection">
                      <FlowSegmented
                        value={lot.use_trail ? "TRAIL" : "STOP"}
                        options={["STOP", "TRAIL"] as const}
                        onChange={(value) => updateLot(index, { use_trail: value === "TRAIL" })}
                      />
                    </FlowField>
                    <p className="text-[10px] text-[var(--text-3)]">
                      {lot.use_trail ? "Trail stays preview-only until fill." : "Fixed stop anchors the lot."}
                    </p>
                  </div>
                  <FlowField label={lot.use_trail ? "Trail $" : "Stop $"}>
                    <FlowValueInput
                      type="number"
                      step="0.01"
                      prefix="$"
                      value={lot.use_trail ? lot.trail_value : lot.stop_price}
                      disabled={!canDraft}
                      onChange={(event) => updateLot(index, lot.use_trail ? { trail_value: event.target.value } : { stop_price: event.target.value })}
                    />
                  </FlowField>
                  <div className="rounded-lg border border-border/70 bg-[var(--bg-1)] px-3 py-2 text-center md:text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">Fallback</div>
                    <div className="mt-1 font-data text-[12px] text-[var(--text-2)]">EOD</div>
                  </div>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="h-9 w-full rounded-full border border-dashed border-border/80 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-2)] transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-0)] hover:text-[var(--text-1)] hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canDraft}
              onClick={() => setLots((previous) => [...previous, { ...EMPTY_LOT }])}
            >
              Add lot
            </button>
          </FlowRow>
          <FlowRow>
            <FlowGuidance>{guidance}</FlowGuidance>
          </FlowRow>
          <FlowRow id="scale-scenario">
            <ScaleOutScenarioCalculator entryPrice={entryPrice} lots={scenarioLots} />
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
                <FlowActionButton
                  mode="scale_out"
                  disabled={!canDraft || !req || previewMutation.isPending}
                  onClick={() => req && previewMutation.mutate(req)}
                >
                  {previewMutation.isPending ? "Previewing..." : "Preview ladder"}
                </FlowActionButton>
              </div>
            </FlowSummary>
          </FlowRow>
        </FlowSheet>
      </div>
    </div>
  );
}
