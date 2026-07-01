import type { OrderSnapshot } from "./api";
import { parseScaleOutOrderRef, type ScaleOutOrderPackage } from "./scaleOutPackages";

function priceDisplay(order: OrderSnapshot): string {
  if (order.lmt_price != null && order.stop_price != null)
    return `STP ${order.stop_price.toFixed(2)} / LMT ${order.lmt_price.toFixed(2)}`;
  if (order.stop_price != null) return order.stop_price.toFixed(2);
  if (order.lmt_price != null) return order.lmt_price.toFixed(2);
  return "—";
}

/** Read-only view: this V2 slice shows current package state only. Editing a
 * scale-out package (canceling and replacing matched exit legs together) is a
 * separate broker-mutation slice with its own safety review. */
export function ScaleOutPackageManagerPanel({
  pkg,
  onClose,
}: {
  pkg: ScaleOutOrderPackage;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Manage Scale-Out</p>
          <p className="font-data text-sm font-semibold text-[var(--text-1)]">
            {pkg.symbol} <span className="text-[var(--text-3)]">· pkg {pkg.packageId.slice(0, 8)}</span>
          </p>
        </div>
        <button
          type="button"
          className="h-8 rounded border border-border px-3 text-xs text-[var(--text-2)] hover:bg-[var(--bg-1)]"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      {pkg.warnings.length > 0 && (
        <div className="shrink-0 space-y-1 rounded border border-[var(--clr-orange)]/30 bg-[var(--glow-orange)] p-2 text-[11px] text-[var(--clr-orange)]">
          {pkg.warnings.map((w, i) => (
            <p key={i}>{w.message}</p>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {pkg.lots.map((lot) => {
          const rows = [lot.entry, ...lot.exits].filter((o): o is OrderSnapshot => o != null);
          return (
            <div key={lot.lotIndex} className="border-b border-border/40 pb-2 last:border-b-0">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-3)]">Lot {lot.lotIndex + 1}</p>
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="text-[var(--text-3)]">
                    <th className="pb-1 pr-2 font-medium">Role</th>
                    <th className="pb-1 pr-2 font-medium">Side</th>
                    <th className="pb-1 pr-2 font-medium">Qty</th>
                    <th className="pb-1 pr-2 font-medium">Type</th>
                    <th className="pb-1 pr-2 font-medium">Price</th>
                    <th className="pb-1 pr-2 font-medium">Status</th>
                    <th className="pb-1 pr-2 font-medium">Parent</th>
                    <th className="pb-1 font-medium">OCA</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.order_id} className="border-t border-border/40">
                      <td className="py-1 pr-2 font-medium text-[var(--text-2)]">
                        {parseScaleOutOrderRef(o.order_ref)?.roleType ?? "—"}
                      </td>
                      <td className={`pr-2 ${o.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
                        {o.side}
                      </td>
                      <td className="pr-2 font-data">{o.quantity}</td>
                      <td className="pr-2 font-data text-[var(--text-2)]">{o.order_type}</td>
                      <td className="pr-2 font-data text-[var(--text-2)]">{priceDisplay(o)}</td>
                      <td className="pr-2 text-[var(--text-2)]">{o.status}</td>
                      <td className="pr-2 text-[var(--text-3)]">{o.parent_id ?? "—"}</td>
                      <td className="text-[var(--text-3)]">{o.oca_group ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 rounded border border-border/60 bg-[var(--bg-0)] p-2 text-[11px] leading-5 text-[var(--text-3)]">
        Read-only for now. Changing a lot's quantity, target, or stop means canceling and replacing
        its matched exit orders together — that review flow needs its own safety plan and isn't
        built yet.
      </div>
    </div>
  );
}
