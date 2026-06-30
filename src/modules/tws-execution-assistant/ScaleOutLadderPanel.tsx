import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/sidecarClient";
import { cn } from "@/lib/utils";
import {
  twsApi,
  type TwsOrderPackagePreview,
  type TwsOrderPackageRequest,
  type TwsOrderPackageSubmission,
  type TwsScaleOutLotDraft,
} from "./api";
import { RECON_KEY } from "./TwsExecutionAssistantModule";

interface LotInput {
  quantity: string;
  target_price: string;
  stop_price: string;
  trail_value: string;
  use_trail: boolean;
}

const EMPTY_LOT: LotInput = { quantity: "", target_price: "", stop_price: "", trail_value: "", use_trail: false };

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

export function ScaleOutLadderPanel({
  canDraft,
  isLiveSession,
}: {
  canDraft: boolean;
  isLiveSession: boolean;
}) {
  const queryClient = useQueryClient();
  const [conid, setConid] = useState(0);
  const [symbol, setSymbol] = useState("");
  const [orderType, setOrderType] = useState<"MKT" | "LMT">("LMT");
  const [limitPrice, setLimitPrice] = useState("");
  const [lots, setLots] = useState<LotInput[]>([{ ...EMPTY_LOT }, { ...EMPTY_LOT }]);
  const [preview, setPreview] = useState<TwsOrderPackagePreview | null>(null);
  const [submission, setSubmission] = useState<TwsOrderPackageSubmission | null>(null);

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

  const req = buildRequest(conid, symbol, orderType, limitPrice, lots);

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-[var(--bg-1)] shadow-sm">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--clr-cyan)]">
          Scale-Out Ladder (long-only)
        </h2>
      </div>
      <div className={cn("flex flex-col gap-3 p-3", !canDraft && "opacity-45")}>
        <div className="grid gap-2 md:grid-cols-4">
          <label className="space-y-1">
            <span className="text-[10px] text-[var(--text-3)]">Symbol</span>
            <input
              className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 text-xs uppercase outline-none focus:border-[var(--clr-cyan)]"
              value={symbol}
              disabled={!canDraft}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-[var(--text-3)]">ConID</span>
            <input
              type="number"
              className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
              value={conid || ""}
              disabled={!canDraft}
              onChange={(e) => setConid(Number(e.target.value))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-[var(--text-3)]">Entry type</span>
            <select
              className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 text-xs outline-none focus:border-[var(--clr-cyan)]"
              value={orderType}
              disabled={!canDraft}
              onChange={(e) => setOrderType(e.target.value as "MKT" | "LMT")}
            >
              <option value="LMT">LMT</option>
              <option value="MKT">MKT</option>
            </select>
          </label>
          {orderType === "LMT" && (
            <label className="space-y-1">
              <span className="text-[10px] text-[var(--text-3)]">Entry limit</span>
              <input
                type="number"
                step="0.01"
                className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
                value={limitPrice}
                disabled={!canDraft}
                onChange={(e) => setLimitPrice(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className="space-y-1.5">
          {lots.map((lot, i) => (
            <div key={i} className="grid items-end gap-2 md:grid-cols-6">
              <label className="space-y-1">
                <span className="text-[10px] text-[var(--text-3)]">Lot {i} qty</span>
                <input
                  type="number"
                  className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
                  value={lot.quantity}
                  disabled={!canDraft}
                  onChange={(e) => updateLot(i, { quantity: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] text-[var(--text-3)]">Target</span>
                <input
                  type="number"
                  step="0.01"
                  className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
                  value={lot.target_price}
                  disabled={!canDraft}
                  onChange={(e) => updateLot(i, { target_price: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-1.5 pb-1.5 text-[10px] text-[var(--text-3)]">
                <input
                  type="checkbox"
                  checked={lot.use_trail}
                  disabled={!canDraft}
                  onChange={(e) => updateLot(i, { use_trail: e.target.checked })}
                />
                Trail
              </label>
              {lot.use_trail ? (
                <label className="space-y-1">
                  <span className="text-[10px] text-[var(--text-3)]">Trail $</span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
                    value={lot.trail_value}
                    disabled={!canDraft}
                    onChange={(e) => updateLot(i, { trail_value: e.target.value })}
                  />
                </label>
              ) : (
                <label className="space-y-1">
                  <span className="text-[10px] text-[var(--text-3)]">Stop</span>
                  <input
                    type="number"
                    step="0.01"
                    className="h-8 w-full rounded border border-border bg-[var(--bg-0)] px-2 font-data text-xs outline-none focus:border-[var(--clr-cyan)]"
                    value={lot.stop_price}
                    disabled={!canDraft}
                    onChange={(e) => updateLot(i, { stop_price: e.target.value })}
                  />
                </label>
              )}
              <button
                type="button"
                className="h-8 rounded border border-[var(--clr-red)]/40 px-2 text-[10px] text-[var(--clr-red)] hover:bg-[var(--clr-red)]/10 disabled:opacity-50"
                disabled={!canDraft || lots.length <= 1}
                onClick={() => setLots((prev) => prev.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="h-7 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-0)] disabled:opacity-50"
            disabled={!canDraft}
            onClick={() => setLots((prev) => [...prev, { ...EMPTY_LOT }])}
          >
            + Add lot
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="h-9 rounded-md border border-[var(--clr-cyan)] px-4 text-sm font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96] disabled:opacity-50"
            disabled={!canDraft || !req || previewMutation.isPending}
            onClick={() => {
              if (req) {
                submitMutation.reset();
                previewMutation.mutate(req);
              }
            }}
          >
            {previewMutation.isPending ? "Previewing..." : "Preview ladder"}
          </button>
          {!req && (
            <span className="text-[11px] text-[var(--text-3)]">
              Fill symbol, conid, entry price, and every lot's quantity/target/stop-or-trail.
            </span>
          )}
        </div>

        {previewMutation.isError &&
          (validationErrors(previewMutation.error).length > 0 ? (
            <div className="space-y-1">
              {validationErrors(previewMutation.error).map((e, i) => (
                <p key={i} className="text-xs text-[var(--clr-red)]">- {e}</p>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--clr-red)]">Preview failed — check inputs and TWS connection.</p>
          ))}

        {preview && (
          <div className="space-y-2 rounded border border-border/60 bg-[var(--bg-0)] p-2">
            <div className="flex items-center justify-between">
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
                  <th className="pb-1 pr-2 font-medium">Parent</th>
                  <th className="pb-1 pr-2 font-medium">OCA</th>
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

            {submission ? (
              <div className="rounded border border-[var(--clr-green)]/30 bg-[var(--glow-green)] p-2 text-[11px]">
                <p className="font-semibold text-[var(--clr-green)]">
                  Sent — {submission.order_ids.length} orders, status {submission.status}.
                </p>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="h-8 rounded-md bg-[var(--clr-green)] px-4 text-xs font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                  disabled={submitMutation.isPending}
                  onClick={() => req && submitMutation.mutate(req)}
                >
                  {submitMutation.isPending ? "Submitting..." : isLiveSession ? "Place LIVE ladder" : "Place PAPER ladder"}
                </button>
                {submitMutation.isError && (
                  <p className="mt-1 text-xs text-[var(--clr-red)]">
                    {errorCode(submitMutation.error) === "live_session_not_armed" ||
                    errorCode(submitMutation.error) === "live_session_not_allowlisted"
                      ? "Live trading is not armed — arm it above before submitting."
                      : "Submit failed — check TWS connection and try again."}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
