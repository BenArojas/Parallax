import { useEffect, useState } from "react";
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
import { PlanAnatomyPanel, type PlanAnatomyEffect, type PlanAnatomyStep } from "./PlanAnatomyPanel";
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

function moneyInput(value: string): string {
  const n = Number(value);
  return n > 0 ? `$${n.toFixed(2)}` : "missing";
}

function quantityInput(value: string): string {
  const n = Number(value);
  return n > 0 ? String(n) : "missing";
}

function bracketPlainEnglish(side: ExecutionPlanSide, symbol: string, orderType: "MKT" | "LMT", useTrail: boolean): string {
  const action = side === "BUY" ? "Buy" : "Sell";
  const ticker = symbol || "symbol";
  const entry = orderType === "LMT" ? "with a limit entry" : "at the market";
  const protection = useTrail ? "one trailing protective stop" : "one protective stop";
  return `${action} ${ticker} ${entry}. If filled, attach one profit target and ${protection}.`;
}

function oppositeSide(side: ExecutionPlanSide): ExecutionPlanSide {
  return side === "BUY" ? "SELL" : "BUY";
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
  const [searchResults, setSearchResults] = useState<InstrumentResult[]>([]);
  const [side, setSide] = useState<ExecutionPlanSide>("BUY");
  const [quantity, setQuantity] = useState("");
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

  const req = buildRequest(conid, symbol, side, quantity, orderType, limitPrice, targetPrice, useTrail, stopPrice, trailValue);
  const entryText = orderType === "LMT" ? `LMT ${moneyInput(limitPrice)}` : "MKT";
  const quantityText = quantityInput(quantity);
  const exitSide = oppositeSide(side);
  const displaySymbol = symbol || "symbol";
  const trailNumber = Number(trailValue);
  const stopNumber = Number(stopPrice);
  const hasProtection = useTrail ? trailNumber > 0 : stopNumber > 0;
  const protectText = useTrail
    ? trailNumber > 0 ? `TRAIL $${trailNumber.toFixed(2)}` : "TRAIL missing"
    : `STP ${moneyInput(stopPrice)}`;
  const anatomySteps: PlanAnatomyStep[] = [
    {
      tone: "blue",
      label: "WHEN",
      title: "Immediately after submit",
      detail: "No condition gate. This bracket is ready once it is previewed and submitted.",
      metaLabel: "State",
      metaValue: req ? "Ready" : "Draft",
    },
    {
      tone: "cyan",
      label: "ENTER",
      title: `${side} ${quantityText} ${displaySymbol} · ${entryText}`,
      detail: "This parent entry controls when the target and protection legs become active.",
      metaLabel: "Role",
      metaValue: "Parent",
    },
    {
      tone: "green",
      label: "EXIT",
      title: `${exitSide} ${quantityText} ${displaySymbol} · LMT ${moneyInput(targetPrice)}`,
      detail: "If this target fills, the protective exit is canceled.",
      metaLabel: "Cancels",
      metaValue: "Protection",
    },
    {
      tone: hasProtection ? "red" : "orange",
      label: "PROTECT",
      title: `${exitSide} ${quantityText} ${displaySymbol} · ${protectText}`,
      detail: hasProtection
        ? "If this protection fires, the target exit is canceled."
        : "Add a fixed stop or trailing stop before previewing the bracket.",
      metaLabel: "Safety",
      metaValue: hasProtection ? "Protected" : "Missing",
    },
  ];
  const anatomyEffects: PlanAnatomyEffect[] = [
    { label: "Broker effect", value: "3 linked orders", detail: "One parent entry and two child exits.", tone: "cyan" },
    { label: "Cancel rule", value: "OCA-style exits", detail: "Target and protection cancel each other.", tone: "purple" },
    {
      label: "Protection state",
      value: hasProtection ? "Covered after fill" : "Protection missing",
      detail: hasProtection ? "The intended package protects the filled entry." : "Preview stays disabled until protection is complete.",
      tone: hasProtection ? "green" : "orange",
    },
  ];
  const estimatedNotional =
    Number(quantity) > 0 && orderType === "LMT" && Number(limitPrice) > 0
      ? Number(quantity) * Number(limitPrice)
      : null;
  const ticketStatus = isLiveSession ? "Live session" : connected ? "Paper connected" : "Disconnected";

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
                className="h-9 rounded-md border border-[var(--clr-orange)] px-5 text-sm font-semibold text-[var(--clr-orange)] transition-colors hover:bg-[var(--clr-orange)]/10 active:scale-[0.96]"
                onClick={() => { setPreview(null); setSubmission(null); submitMutation.reset(); }}
              >
                New bracket
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE bracket" : "Place PAPER bracket"}
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--bg-0)] hover:text-[var(--text-1)]"
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
    <div className={cn("flex h-full flex-col overflow-hidden rounded-lg border border-[#1f1b12] bg-[#05070d] text-slate-100 shadow-[0_18px_60px_rgba(0,0,0,0.35)]", !canDraft && "opacity-45")}>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="mb-4 text-[11px] font-black uppercase tracking-[0.28em] text-slate-400">
          Order ticket
        </div>

        <section className="relative rounded-[18px] border border-cyan-500/35 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),rgba(8,13,20,0.96)_44%,rgba(5,7,13,1))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="relative max-w-sm">
                <input
                  className="h-14 w-full rounded-xl border border-transparent bg-transparent pr-12 text-[42px] font-black uppercase leading-none tracking-[-0.02em] text-slate-50 outline-none placeholder:text-slate-600 focus:border-cyan-400/35 focus:bg-black/20"
                  placeholder="TSLA"
                  value={symbol}
                  disabled={!canDraft}
                  onChange={(e) => handleSymbolChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                />
                <button
                  type="button"
                  className="absolute right-1 top-2.5 flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-cyan-400/10 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={!canDraft || !symbol || searchMutation.isPending}
                  onClick={runSearch}
                  tabIndex={-1}
                >
                  <Search className="h-5 w-5" strokeWidth={1.8} />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-slate-400">
                <span>{symbol || "Search symbol"}</span>
                <span>/</span>
                <span>SMART</span>
                <span>/</span>
                <span>USD</span>
                <span>/</span>
                <span>conid {conid || "resolve"}</span>
              </div>
              {searchResults.length > 1 && (
                <ul className="absolute z-20 mt-3 w-[min(520px,calc(100%-2rem))] overflow-hidden rounded-xl border border-cyan-400/25 bg-[#070a11] shadow-2xl">
                  {searchResults.map((r) => (
                    <li key={r.conid}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] text-slate-300 hover:bg-cyan-400/10"
                        onClick={() => resolveInstrument(r)}
                      >
                        <span className="font-bold text-slate-100">{r.symbol}</span>
                        <span className="truncate text-slate-500">
                          {r.sec_type} / {r.primary_exchange || r.exchange} / {r.currency}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <span className={cn(
              "inline-flex shrink-0 rounded-full border px-4 py-2 text-[13px] font-black",
              isLiveSession
                ? "border-red-400/45 bg-red-500/12 text-red-300"
                : connected
                  ? "border-emerald-400/45 bg-emerald-500/12 text-emerald-300"
                  : "border-orange-400/45 bg-orange-500/12 text-orange-300",
            )}>
              {ticketStatus}
            </span>
          </div>
        </section>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <section className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="mb-3 text-[12px] font-black text-slate-400">Side</div>
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white/[0.04] p-1">
              {(["BUY", "SELL"] as ExecutionPlanSide[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "h-12 rounded-xl text-[14px] font-black transition-transform active:scale-[0.96] disabled:cursor-not-allowed",
                    side === option
                      ? option === "BUY"
                        ? "bg-emerald-500/22 text-emerald-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                        : "bg-red-500/20 text-red-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300",
                  )}
                  disabled={!canDraft}
                  onClick={() => setSide(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </section>

          <label className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <span className="mb-3 block text-[12px] font-black text-slate-400">Quantity</span>
            <div className="flex items-baseline gap-2">
              <input
                type="number"
                className="min-w-0 flex-1 bg-transparent font-data text-[34px] font-black leading-none text-slate-50 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
                value={quantity}
                disabled={!canDraft}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <span className="font-data text-[30px] font-black text-slate-100">sh</span>
            </div>
          </label>
        </div>

        <section className="mt-3 rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="mb-3 text-[12px] font-black text-slate-400">Entry type</div>
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white/[0.04] p-1">
            {(["MKT", "LMT"] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={cn(
                  "h-12 rounded-xl font-data text-[14px] font-black transition-transform active:scale-[0.96] disabled:cursor-not-allowed",
                  orderType === type
                    ? "bg-cyan-400/20 text-cyan-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                    : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300",
                )}
                disabled={!canDraft}
                onClick={() => setOrderType(type)}
              >
                {type}
              </button>
            ))}
          </div>
        </section>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {orderType === "LMT" && (
            <label className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <span className="mb-3 block text-[12px] font-black text-slate-400">Entry limit</span>
              <div className="flex items-baseline">
                <span className="font-data text-[30px] font-black text-slate-50">$</span>
                <input
                  type="number"
                  step="0.01"
                  className="min-w-0 flex-1 bg-transparent font-data text-[34px] font-black leading-none text-slate-50 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
                  placeholder="0.00"
                  value={limitPrice}
                  disabled={!canDraft}
                  onChange={(e) => setLimitPrice(e.target.value)}
                />
              </div>
            </label>
          )}
          <label className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <span className="mb-3 block text-[12px] font-black text-slate-400">Target</span>
            <div className="flex items-baseline">
              <span className="font-data text-[30px] font-black text-slate-50">$</span>
              <input
                type="number"
                step="0.01"
                className="min-w-0 flex-1 bg-transparent font-data text-[34px] font-black leading-none text-slate-50 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
                placeholder="0.00"
                value={targetPrice}
                disabled={!canDraft}
                onChange={(e) => setTargetPrice(e.target.value)}
              />
            </div>
          </label>
          <label className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <span className="mb-3 block text-[12px] font-black text-slate-400">{useTrail ? "Trail" : "Stop"}</span>
            <div className="flex items-baseline">
              <span className="font-data text-[30px] font-black text-slate-50">$</span>
              <input
                type="number"
                step="0.01"
                className="min-w-0 flex-1 bg-transparent font-data text-[34px] font-black leading-none text-slate-50 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
                placeholder="0.00"
                value={useTrail ? trailValue : stopPrice}
                disabled={!canDraft}
                onChange={(e) => useTrail ? setTrailValue(e.target.value) : setStopPrice(e.target.value)}
              />
            </div>
          </label>
          <section className="rounded-[18px] border border-white/10 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="mb-3 flex items-center gap-1.5 text-[12px] font-black text-slate-400">
              Trail <Hint text="A trailing stop follows the price up and triggers a sell if it falls back by this much." />
            </div>
            <button
              type="button"
              className={cn(
                "h-12 w-full rounded-xl font-data text-[20px] font-black transition-transform active:scale-[0.96] disabled:cursor-not-allowed",
                useTrail ? "bg-cyan-400/20 text-cyan-300" : "bg-white/[0.04] text-slate-100",
              )}
              disabled={!canDraft}
              onClick={() => setUseTrail((v) => !v)}
            >
              {useTrail ? "ON" : "OFF"}
            </button>
          </section>
        </div>

        <div className="mt-3 rounded-[18px] border border-orange-400/25 bg-orange-500/[0.06] px-4 py-3 text-[13px] leading-6 text-slate-400">
          <span className="font-black text-slate-100">Plain English:</span> {bracketPlainEnglish(side, symbol, orderType, useTrail)}
        </div>

        <div className="[--bg-0:#070a11] [--bg-1:#0c111a] [--text-1:#f8fafc] [--text-2:#cbd5e1] [--text-3:#7d8ba1] [--border:rgba(148,163,184,0.20)] mt-3">
          <PlanAnatomyPanel
            title="Bracket order logic"
            subtitle="The chart shows the prices. This explains the sequence, links, and protection state."
            badge={req ? "Ready to preview" : "Draft incomplete"}
            steps={anatomySteps}
            effects={anatomyEffects}
          />
        </div>

        {previewMutation.isError && (
          <div className="mt-3 space-y-1 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2">
            {validationErrors(previewMutation.error).length > 0 ? (
              validationErrors(previewMutation.error).map((e, i) => (
                <p key={i} className="text-xs text-red-300">- {e}</p>
              ))
            ) : (
              <p className="text-xs text-red-300">Preview failed — check inputs and TWS connection.</p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3 rounded-[18px] border border-orange-400/25 bg-black/28 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-400">Estimated notional</div>
            <div className="mt-1 font-data text-[28px] font-black text-slate-50">
              {estimatedNotional != null ? `$${estimatedNotional.toFixed(2)}` : "--"}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <button
              type="button"
              className="h-14 rounded-2xl bg-orange-400 px-7 text-[15px] font-black text-[#160d02] shadow-[0_12px_28px_rgba(251,146,60,0.22)] transition-transform hover:bg-orange-300 active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none"
              disabled={!canDraft || !req || previewMutation.isPending}
              onClick={() => req && previewMutation.mutate(req)}
            >
              {previewMutation.isPending ? "Previewing..." : "Preview bracket"}
            </button>
            {!req && (
              <span className="max-w-[300px] text-right text-[12px] font-semibold text-slate-500">
                Fill symbol, quantity, entry price, target, and a stop or trail.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
