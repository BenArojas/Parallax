import type { OrderSnapshot, TwsPackageWarning } from "./api";
import type { BracketOrderPackage } from "./bracketPackages";
import { OrderRow } from "./OrderRow";

/** Unlike ScaleOutPackageManagerPanel, this is not read-only: a bracket leg
 * is still just one order, so canceling or modifying it here is the same
 * single-order action as it would be from Open Orders — no coordinated
 * multi-leg edit is needed the way a scale-out lot's replace would require. */
export function BracketPackageManagerPanel({
  pkg,
  warnings,
  onClose,
  onCancel,
  onModify,
}: {
  pkg: BracketOrderPackage;
  warnings: TwsPackageWarning[];
  onClose: () => void;
  onCancel: (order_id: number) => void;
  onModify: (order: OrderSnapshot) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">Manage Bracket</p>
          <p className="font-data text-sm font-semibold text-[var(--text-1)]">
            {pkg.symbol} <span className="text-[var(--text-3)]">· pkg {pkg.packageId.slice(0, 8)}</span>
          </p>
        </div>
        <button
          type="button"
          className="h-8 rounded border border-border bg-[var(--bg-0)] px-3 text-xs font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--bg-1)] hover:text-[var(--text-1)] active:scale-95"
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-xs text-[var(--text-3)]">
              <th className="pb-1.5 pr-4 font-medium">Symbol</th>
              <th className="pb-1.5 pr-4 font-medium">Side</th>
              <th className="pb-1.5 pr-4 font-medium">Qty</th>
              <th className="pb-1.5 pr-4 font-medium">Type</th>
              <th className="pb-1.5 pr-4 font-medium">Price</th>
              <th className="pb-1.5 pr-4 font-medium">Status</th>
              <th className="pb-1.5 pr-4 font-medium">Parent</th>
              <th className="pb-1.5 pr-4 font-medium">OCA</th>
              <th className="pb-1.5 pr-2 font-medium" />
              <th className="pb-1.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pkg.orders.map((order) => (
              <OrderRow key={order.order_id} order={order} warnings={warnings} onCancel={onCancel} onModify={onModify} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="shrink-0 rounded border border-border/60 bg-[var(--bg-0)] p-2 text-[11px] leading-5 text-[var(--text-3)]">
        Each leg here is still its own order — canceling or modifying one acts on that order alone.
      </div>
    </div>
  );
}
