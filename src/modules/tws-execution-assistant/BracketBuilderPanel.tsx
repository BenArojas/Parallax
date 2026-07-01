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
}: {
  canDraft: boolean;
  isLiveSession: boolean;
  connected: boolean;
  onInstrumentResolved: (instrument: InstrumentResult) => void;
}) {
  const queryClient = useQueryClient();
  const [conid, setConid] = useState(0);
  const [symbol, setSymbol] = useState("");
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
    <div className={cn("flex h-full flex-col", !canDraft && "opacity-45")}>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
        <div className="rounded border border-[var(--clr-orange)]/25 bg-[var(--glow-orange)] px-4 py-3 text-xs leading-5 text-[var(--text-2)]">
          A bracket sends one entry with its exit already attached: a profit target and a stop
          (or trailing stop), linked so that filling one cancels the other.
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs font-medium text-[var(--text-2)]">Symbol</span>
            <div className="relative">
              <input
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 pr-9 text-sm uppercase outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
                placeholder="e.g. INTC"
                value={symbol}
                disabled={!canDraft}
                onChange={(e) => handleSymbolChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
              />
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-[var(--text-3)] hover:text-[var(--clr-orange)] disabled:cursor-not-allowed"
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
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
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
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
              value={quantity}
              disabled={!canDraft}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-2)]">Entry type</span>
            <select
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
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
                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
                value={limitPrice}
                disabled={!canDraft}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
            </label>
          )}
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--text-2)]">Target</span>
            <input
              type="number"
              step="0.01"
              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
              value={targetPrice}
              disabled={!canDraft}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
          </label>
          <div className="flex items-end gap-3">
            <div className="flex items-center gap-1.5 pb-2 text-xs font-medium text-[var(--text-2)]">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={useTrail}
                  disabled={!canDraft}
                  onChange={(e) => setUseTrail(e.target.checked)}
                />
                Trail
              </label>
              <Hint text="A trailing stop follows the price up and triggers a sell if it falls back by this much — useful when you don't want to fix the stop in advance." />
            </div>
            {useTrail ? (
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[var(--text-2)]">Trail $</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-20 rounded border border-border bg-[var(--bg-0)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
                  value={trailValue}
                  disabled={!canDraft}
                  onChange={(e) => setTrailValue(e.target.value)}
                />
              </label>
            ) : (
              <label className="space-y-1.5">
                <span className="flex items-center gap-1 text-xs font-medium text-[var(--text-2)]">
                  Stop <Hint text="A fixed protective stop. If the price moves against you to this level, the position exits to limit the loss." />
                </span>
                <input
                  type="number"
                  step="0.01"
                  className="h-9 w-20 rounded border border-border bg-[var(--bg-0)] px-2.5 font-data text-sm outline-none focus:border-[var(--clr-orange)] disabled:cursor-not-allowed"
                  value={stopPrice}
                  disabled={!canDraft}
                  onChange={(e) => setStopPrice(e.target.value)}
                />
              </label>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          className="h-9 rounded-md border border-[var(--clr-orange)] px-4 text-sm font-semibold text-[var(--clr-orange)] transition-colors hover:bg-[var(--clr-orange)]/10 active:scale-[0.96] disabled:opacity-50"
          disabled={!canDraft || !req || previewMutation.isPending}
          onClick={() => req && previewMutation.mutate(req)}
        >
          {previewMutation.isPending ? "Previewing..." : "Preview bracket"}
        </button>
        {!req && (
          <span className="text-[11px] text-[var(--text-3)]">
            Fill symbol, quantity, entry price, target, and a stop or trail.
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
