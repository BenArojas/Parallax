import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
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

const LOT_BAR_COLORS = ["bg-[var(--clr-cyan)]", "bg-[var(--clr-green)]", "bg-[var(--clr-purple)]", "bg-[var(--clr-orange)]"];

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

/** "→ sell 5 @ $125, protected by a stop at $118" / "...trailing stop $2 below the high" */
function lotReadout(lot: LotInput): string | null {
  const qty = Number(lot.quantity);
  const target = Number(lot.target_price);
  if (!qty || !target) return null;
  const exit = lot.use_trail
    ? Number(lot.trail_value)
      ? `trailing stop $${Number(lot.trail_value).toFixed(2)} below the high`
      : null
    : Number(lot.stop_price)
      ? `protected by a stop at $${Number(lot.stop_price).toFixed(2)}`
      : null;
  if (!exit) return `sell ${qty} @ $${target.toFixed(2)}, then set a stop or trail`;
  return `sell ${qty} @ $${target.toFixed(2)}, ${exit}`;
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
                className="h-9 rounded-md border border-[var(--clr-cyan)] px-5 text-sm font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New ladder
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE ladder" : "Place PAPER ladder"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--bg-0)] hover:text-[var(--text-1)]"
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
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
        <div className="rounded border border-[var(--clr-purple)]/25 bg-[var(--glow-purple)] px-4 py-3 text-xs leading-5 text-[var(--text-2)]">
          Scale-out ladders split your exit across multiple price targets. Each lot gets its own protective stop
          (or trailing stop) and an end-of-day fallback — so a partial fill can never leave shares unprotected.
        </div>
        <button
          type="button"
          className="self-start rounded border border-dashed border-[var(--clr-purple)]/50 px-3 py-1.5 text-xs text-[var(--clr-purple)] transition-colors hover:bg-[var(--glow-purple)] disabled:opacity-50"
          disabled={!canDraft}
          onClick={loadExample}
        >
          ↻ Try an example: 20 shares, 3 stages
        </button>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[var(--text-2)]">Symbol</span>
            <div className="relative">
              <input
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 pr-9 text-sm uppercase outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                placeholder="e.g. INTC"
                value={symbol}
                disabled={!canDraft}
                onChange={(e) => handleSymbolChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
              />
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-[var(--text-3)] hover:text-[var(--clr-purple)] disabled:cursor-not-allowed"
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
            <span className="text-xs font-medium text-[var(--text-2)]">Entry type</span>
            <select
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
              value={orderType}
              disabled={!canDraft}
              onChange={(e) => setOrderType(e.target.value as "MKT" | "LMT")}
            >
              <option value="LMT">LMT</option>
              <option value="MKT">MKT</option>
            </select>
          </label>
          {orderType === "LMT" && (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-2)]">Entry limit</span>
              <input
                type="number"
                step="0.01"
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                value={limitPrice}
                disabled={!canDraft}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className="space-y-3">
          {lots.map((lot, i) => {
            const readout = lotReadout(lot);
            return (
              <div key={i} className="border-b border-border/40 pb-3 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-end gap-3">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs font-bold"
                    style={{ background: "var(--glow-purple)", color: "var(--clr-purple)" }}
                  >
                    {i + 1}
                  </span>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--text-2)]">Qty</span>
                    <input
                      type="number"
                      className="h-9 w-20 rounded border border-border bg-[var(--bg-1)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                      value={lot.quantity}
                      disabled={!canDraft}
                      onChange={(e) => updateLot(i, { quantity: e.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--text-2)]">Target</span>
                    <input
                      type="number"
                      step="0.01"
                      className="h-9 w-24 rounded border border-border bg-[var(--bg-1)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                      value={lot.target_price}
                      disabled={!canDraft}
                      onChange={(e) => updateLot(i, { target_price: e.target.value })}
                    />
                  </label>
                  <div className="flex items-center gap-1.5 pb-2 text-xs font-medium text-[var(--text-2)]">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={lot.use_trail}
                        disabled={!canDraft}
                        onChange={(e) => updateLot(i, { use_trail: e.target.checked })}
                      />
                      Trail
                    </label>
                    <Hint text="A trailing stop follows the price up and triggers a sell if it falls back by this much — useful when you don't want to fix the stop in advance." />
                  </div>
                  {lot.use_trail ? (
                    <label className="space-y-1.5">
                      <span className="text-xs font-medium text-[var(--text-2)]">Trail $</span>
                      <input
                        type="number"
                        step="0.01"
                        className="h-9 w-20 rounded border border-border bg-[var(--bg-1)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                        value={lot.trail_value}
                        disabled={!canDraft}
                        onChange={(e) => updateLot(i, { trail_value: e.target.value })}
                      />
                    </label>
                  ) : (
                    <label className="space-y-1.5">
                      <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-2)]">
                        Stop <Hint text="A fixed protective stop. If the price falls to this level, the lot sells to limit the loss." />
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        className="h-9 w-20 rounded border border-border bg-[var(--bg-1)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-purple)] disabled:cursor-not-allowed"
                        value={lot.stop_price}
                        disabled={!canDraft}
                        onChange={(e) => updateLot(i, { stop_price: e.target.value })}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="ml-auto h-9 rounded border border-[var(--clr-red)]/40 px-2.5 text-xs text-[var(--clr-red)] hover:bg-[var(--clr-red)]/10 disabled:opacity-50"
                    disabled={!canDraft || lots.length <= 1}
                    onClick={() => setLots((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                </div>
                {readout && (
                  <p className="mt-2.5 text-xs text-[var(--clr-purple)]">
                    <span className="text-[var(--text-3)]">→</span> {readout}
                  </p>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="h-8 w-full rounded border border-dashed border-border text-xs text-[var(--text-2)] hover:bg-[var(--bg-0)] disabled:opacity-50"
            disabled={!canDraft}
            onClick={() => setLots((prev) => [...prev, { ...EMPTY_LOT }])}
          >
            + Add another lot
          </button>
        </div>

        {totalQty > 0 && (
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-3)]">
            <span className="font-data text-[var(--text-1)]">{totalQty}</span>
            <span>shares total</span>
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-0)]">
              {lots.map((l, i) => {
                const qty = Number(l.quantity) || 0;
                if (!qty) return null;
                return (
                  <div
                    key={i}
                    className={LOT_BAR_COLORS[i % LOT_BAR_COLORS.length]}
                    style={{ width: `${(qty / totalQty) * 100}%` }}
                  />
                );
              })}
            </div>
            <span>{lots.length} {lots.length === 1 ? "lot" : "lots"}</span>
          </div>
        )}

        <ScaleOutScenarioCalculator entryPrice={entryPrice} lots={scenarioLots} />
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          className="h-9 rounded-md border border-[var(--clr-purple)] px-4 text-sm font-semibold text-[var(--clr-purple)] transition-colors hover:bg-[var(--clr-purple)]/10 active:scale-[0.96] disabled:opacity-50"
          disabled={!canDraft || !req || previewMutation.isPending}
          onClick={() => req && previewMutation.mutate(req)}
        >
          {previewMutation.isPending ? "Previewing..." : "Preview ladder"}
        </button>
        {!req && (
          <span className="text-[11px] text-[var(--text-3)]">
            Fill symbol, conid, entry price, and every lot's quantity/target/stop-or-trail.
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
