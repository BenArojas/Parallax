import { useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { canModifyOrderType } from "./orderCapabilities";
import type { OrderSnapshot, TwsPackageWarning } from "./api";

function UnmanagedBadge() {
  return (
    <span className="rounded bg-[var(--glow-orange)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--clr-orange)]">
      unmanaged
    </span>
  );
}

export function OrderRow({
  order,
  warnings,
  onCancel,
  onModify,
}: {
  order: OrderSnapshot;
  warnings: TwsPackageWarning[];
  onCancel: (order_id: number) => void;
  onModify: (order: OrderSnapshot) => void;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const rowWarnings = warnings.filter((w) => w.order_ids.includes(order.order_id));
  const priceDisplay = (() => {
    if (order.lmt_price != null && order.stop_price != null)
      return `STP ${order.stop_price.toFixed(2)} / LMT ${order.lmt_price.toFixed(2)}`;
    if (order.stop_price != null) return order.stop_price.toFixed(2);
    if (order.lmt_price != null) return order.lmt_price.toFixed(2);
    return "—";
  })();
  return (
    <tr className={cn("border-t border-border text-xs transition-colors", confirmingCancel && "bg-[var(--clr-red)]/5")}>
      <td className="py-1.5 pr-3 font-medium">
        <span className="inline-flex items-center gap-1.5">
          {order.symbol}
          {rowWarnings.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-help text-[var(--clr-orange)]" aria-label="Package warning">
                    ⚠
                  </span>
                }
              />
              <TooltipContent>
                <div className="space-y-1">
                  {rowWarnings.map((w, i) => (
                    <p key={i}>{w.message}</p>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </td>
      <td className={`pr-3 ${order.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
        {order.side}
      </td>
      <td className="pr-3 font-data">{order.quantity}</td>
      <td className="pr-3 font-data text-[var(--text-2)]">{order.order_type}</td>
      <td className="pr-3 font-data text-[var(--text-2)]">{priceDisplay}</td>
      <td className="pr-3 text-[var(--text-2)]">{order.status}</td>
      <td className="pr-3 text-[var(--text-3)]">{order.parent_id ?? "—"}</td>
      <td className="pr-3 text-[var(--text-3)]">{order.oca_group ? order.oca_group.split("-").pop() : "—"}</td>
      <td className="pr-2">{order.is_unmanaged && <UnmanagedBadge />}</td>
      <td className="whitespace-nowrap py-1">
        <div className="flex items-center gap-1.5">
          {confirmingCancel ? (
            <div className="flex items-center gap-1 rounded-full border border-[var(--clr-red)]/40 bg-[var(--clr-red)]/8 px-2 py-0.5">
              <span className="text-[9px] text-[var(--text-3)]">Sure?</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[9px] font-semibold text-[var(--clr-red)] hover:bg-[var(--clr-red)]/20 active:scale-95"
                onClick={() => { onCancel(order.order_id); setConfirmingCancel(false); }}
              >
                Yes
              </button>
              <button
                type="button"
                className="rounded px-1 py-0.5 text-[10px] leading-none text-[var(--text-3)] hover:text-[var(--text-1)]"
                onClick={() => setConfirmingCancel(false)}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="h-5 rounded border border-[var(--clr-red)]/50 px-1.5 text-[10px] text-[var(--clr-red)] hover:bg-[var(--clr-red)]/10 active:scale-95"
              onClick={() => setConfirmingCancel(true)}
            >
              Cancel
            </button>
          )}
          {canModifyOrderType(order.order_type) ? (
            <button
              type="button"
              className="h-5 rounded border border-[var(--clr-cyan)]/50 px-1.5 text-[10px] text-[var(--clr-cyan)] hover:bg-[var(--clr-cyan)]/10 active:scale-95"
              onClick={() => onModify(order)}
            >
              Modify
            </button>
          ) : (
            <span className="text-[10px] text-[var(--text-3)]" title="Modify not supported for this order type.">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}
