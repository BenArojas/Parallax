import type { TwsDepthLevel, TwsDepthUpdateEvent } from "./api";

const ROWS = 5;

function DepthRow({ level, side }: { level: TwsDepthLevel | undefined; side: "bid" | "ask" }) {
  return (
    <div className="flex items-center justify-between font-data">
      <span className={side === "bid" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}>
        {level ? level.price.toFixed(2) : "—"}
      </span>
      <span className="text-[var(--text-3)]">{level ? level.size.toLocaleString() : ""}</span>
    </div>
  );
}

export function DepthPanel({ depth }: { depth: TwsDepthUpdateEvent | null }) {
  if (depth?.entitlement === "unavailable") {
    return (
      <div className="flex h-full items-center justify-center px-1 text-center text-[10px] text-[var(--text-3)]">
        Depth data not available for this account/exchange.
      </div>
    );
  }

  const bids = depth?.bids ?? [];
  const asks = depth?.asks ?? [];

  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="space-y-0.5">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Bids</div>
        {Array.from({ length: ROWS }, (_, i) => (
          <DepthRow key={i} level={bids[i]} side="bid" />
        ))}
      </div>
      <div className="space-y-0.5">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Asks</div>
        {Array.from({ length: ROWS }, (_, i) => (
          <DepthRow key={i} level={asks[i]} side="ask" />
        ))}
      </div>
    </div>
  );
}
