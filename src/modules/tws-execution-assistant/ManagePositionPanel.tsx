import { useState } from "react";
import type { OrderSnapshot, PositionSnapshot, TwsFlattenResult } from "./api";

function priceDisplay(order: OrderSnapshot): string {
  if (order.lmt_price != null && order.stop_price != null)
    return `STP ${order.stop_price.toFixed(2)} / LMT ${order.lmt_price.toFixed(2)}`;
  if (order.stop_price != null) return order.stop_price.toFixed(2);
  if (order.lmt_price != null) return order.lmt_price.toFixed(2);
  return "—";
}

function pnlClass(v: number | null): string {
  return v == null ? "" : v > 0 ? "text-[var(--clr-green)]" : v < 0 ? "text-[var(--clr-red)]" : "";
}

/** Click-to-confirm danger action — mirrors CancelLotButton in
 * ScaleOutPackageManagerPanel. Flatten is the only order-submitting action
 * here that needs a confirm step: it cancels every working order on the
 * symbol and then market-closes whatever remains, so a stray click is
 * expensive to undo. */
function FlattenButton({
  quantity,
  side,
  workingCount,
  disabled,
  disabledReason,
  pending,
  onConfirm,
}: {
  quantity: number;
  side: "BUY" | "SELL";
  workingCount: number;
  disabled: boolean;
  disabledReason?: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (pending) {
    return (
      <button type="button" disabled className="h-7 rounded border border-border px-2 text-[11px] text-[var(--text-3)]">
        Flattening…
      </button>
    );
  }
  if (confirming) {
    return (
      <div className="flex items-center gap-1 rounded-full border border-[var(--clr-red)]/40 bg-[var(--clr-red)]/8 px-2 py-1">
        <span className="text-[10px] text-[var(--text-3)]">
          Cancel {workingCount} working order{workingCount === 1 ? "" : "s"}, then {side} {quantity} MKT?
        </span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-[var(--clr-red)] hover:bg-[var(--clr-red)]/20 active:scale-95"
          onClick={() => { onConfirm(); setConfirming(false); }}
        >
          Yes
        </button>
        <button
          type="button"
          className="rounded px-1 py-0.5 text-[10px] leading-none text-[var(--text-3)] hover:text-[var(--text-1)]"
          onClick={() => setConfirming(false)}
        >
          ✕
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className="h-7 rounded border border-[var(--clr-red)]/50 px-3 text-[11px] font-semibold text-[var(--clr-red)] hover:bg-[var(--clr-red)]/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => setConfirming(true)}
    >
      Close position
    </button>
  );
}

export function ManagePositionPanel({
  position,
  openOrders,
  reviewLocked,
  isLive,
  onFlatten,
  flattenPending,
  flattenResult,
  flattenError,
  covered,
  needed,
  onPrefillTicket,
  onClose,
}: {
  position: PositionSnapshot;
  openOrders: OrderSnapshot[];
  reviewLocked: boolean;
  isLive: boolean;
  onFlatten: () => void;
  flattenPending: boolean;
  flattenResult: TwsFlattenResult | null;
  flattenError: string | null;
  covered: number;
  needed: number;
  onPrefillTicket: (side: "BUY" | "SELL", quantity: number) => void;
  onClose: () => void;
}) {
  const [customQty, setCustomQty] = useState("");
  const exitSide: "BUY" | "SELL" = position.position > 0 ? "SELL" : "BUY";
  const addSide: "BUY" | "SELL" = position.position > 0 ? "BUY" : "SELL";
  const freeQty = Math.max(0, needed - covered);
  const thirdQty = Math.floor(freeQty / 3);
  const halfQty = Math.floor(freeQty / 2);
  const customQtyNum = Number(customQty);
  const customValid = customQty !== "" && Number.isFinite(customQtyNum) && customQtyNum > 0;
  const sellCustomQty = customValid ? Math.min(customQtyNum, freeQty) : 0;

  const exitOrders = openOrders.filter((o) => o.conid === position.conid);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Manage Position</p>
          <p className="font-data text-sm font-semibold text-[var(--text-1)]">{position.symbol}</p>
        </div>
        <button
          type="button"
          className="h-8 rounded border border-border bg-[var(--bg-0)] px-3 text-xs font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--bg-1)] hover:text-[var(--text-1)] active:scale-95"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {/* Summary row */}
        <div className="grid grid-cols-4 gap-2 rounded border border-border/60 bg-[var(--bg-0)] p-2 text-[11px]">
          <div>
            <p className="text-[var(--text-3)]">Position</p>
            <p className={`font-data font-semibold ${position.position < 0 ? "text-[var(--clr-red)]" : "text-[var(--text-1)]"}`}>
              {position.position}
            </p>
          </div>
          <div>
            <p className="text-[var(--text-3)]">Avg Cost</p>
            <p className="font-data text-[var(--text-2)]">{position.avg_cost.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[var(--text-3)]">Unrl P&L</p>
            <p className={`font-data ${pnlClass(position.unrealized_pnl)}`}>
              {position.unrealized_pnl != null ? position.unrealized_pnl.toFixed(2) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[var(--text-3)]">Daily P&L</p>
            <p className={`font-data ${pnlClass(position.daily_pnl)}`}>
              {position.daily_pnl != null ? position.daily_pnl.toFixed(2) : "—"}
            </p>
          </div>
        </div>

        {/* Exposure block */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Working Exits</p>
            <span className="text-[10px] text-[var(--text-3)]">
              {covered === 0 || needed === 0 ? (
                <span>—</span>
              ) : covered < needed ? (
                <span className="text-[var(--clr-orange)]">⚠ {needed - covered} unprotected</span>
              ) : (
                <span className="text-[var(--clr-green)]">{covered}/{needed} covered</span>
              )}
            </span>
          </div>
          {exitOrders.length > 0 ? (
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="text-[var(--text-3)]">
                  <th className="pb-1 pr-2 font-medium">Side</th>
                  <th className="pb-1 pr-2 font-medium">Qty</th>
                  <th className="pb-1 pr-2 font-medium">Type</th>
                  <th className="pb-1 pr-2 font-medium">Price</th>
                  <th className="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {exitOrders.map((o) => (
                  <tr key={o.order_id} className="border-t border-border/40">
                    <td className={`py-1 pr-2 ${o.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
                      {o.side}
                    </td>
                    <td className="pr-2 font-data">{o.quantity}</td>
                    <td className="pr-2 font-data text-[var(--text-2)]">{o.order_type}</td>
                    <td className="pr-2 font-data text-[var(--text-2)]">{priceDisplay(o)}</td>
                    <td className="text-[var(--text-2)]">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-[var(--text-3)]">No working orders on this symbol.</p>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-2 rounded border border-border/60 bg-[var(--bg-0)] p-2">
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Actions</p>

          <div className="flex flex-wrap items-center gap-2">
            <FlattenButton
              quantity={Math.abs(position.position)}
              side={exitSide}
              workingCount={exitOrders.length}
              disabled={reviewLocked}
              disabledReason={reviewLocked ? "Finish or cancel the current review before closing this position" : undefined}
              pending={flattenPending}
              onConfirm={onFlatten}
            />
            {isLive && (
              <span className="rounded bg-[var(--clr-red)]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--clr-red)]">
                Live
              </span>
            )}
          </div>
          {flattenResult && (
            <p className="text-[11px] text-[var(--text-2)]">{flattenResult.message}</p>
          )}
          {flattenError && (
            <p className="text-[11px] text-[var(--clr-red)]">{flattenError}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              type="button"
              disabled={reviewLocked || thirdQty < 1}
              title={freeQty === 0 ? "All shares covered by working exits — manage or cancel them first" : undefined}
              className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onPrefillTicket(exitSide, thirdQty)}
            >
              Sell third ({thirdQty})
            </button>
            <button
              type="button"
              disabled={reviewLocked || halfQty < 1}
              title={freeQty === 0 ? "All shares covered by working exits — manage or cancel them first" : undefined}
              className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onPrefillTicket(exitSide, halfQty)}
            >
              Sell half ({halfQty})
            </button>
            <input
              type="number"
              min={1}
              max={freeQty || undefined}
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value)}
              placeholder="Qty"
              className="h-6 w-16 rounded border border-border bg-[var(--bg-1)] px-1.5 text-[10px] text-[var(--text-1)]"
            />
            <button
              type="button"
              disabled={reviewLocked || freeQty === 0 || !customValid}
              title={freeQty === 0 ? "All shares covered by working exits — manage or cancel them first" : undefined}
              className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onPrefillTicket(exitSide, sellCustomQty)}
            >
              Sell qty
            </button>
          </div>
          {freeQty === 0 && (
            <p className="text-[10px] text-[var(--text-3)]">
              All shares covered by working exits — manage or cancel them first.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              type="button"
              disabled={reviewLocked}
              className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onPrefillTicket(addSide, Math.abs(position.position))}
            >
              Double position ({Math.abs(position.position)})
            </button>
            <input
              type="number"
              min={1}
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value)}
              placeholder="Qty"
              className="h-6 w-16 rounded border border-border bg-[var(--bg-1)] px-1.5 text-[10px] text-[var(--text-1)]"
            />
            <button
              type="button"
              disabled={reviewLocked || !customValid}
              className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onPrefillTicket(addSide, customQtyNum)}
            >
              Add qty
            </button>
          </div>
        </div>
      </div>

      <div className="shrink-0 rounded border border-border/60 bg-[var(--bg-0)] p-2 text-[11px] leading-5 text-[var(--text-3)]">
        Closing cancels all working orders on the symbol first, waits for those cancels to be confirmed,
        then sends a market order for whatever quantity actually remains. Partial actions (sell third/half/qty,
        double, add) only ever prefill the standard ticket — they never touch shares already covered by a
        working exit, and nothing submits until you review and confirm it there.
      </div>
    </div>
  );
}
