import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LockKeyhole, Power, Search } from "lucide-react";
import { BackToOrbitButton } from "@/components/ui/BackToOrbitButton";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { BROKER_SESSION_KEY } from "@/context/BrokerSessionContext";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/sidecarClient";
import { twsApi, TWS_CONNECT_DEFAULTS, TWS_TIMEFRAMES, type ExecutionPlan, type ExecutionPlanDraftRequest, type ExecutionPlanOrderType, type ExecutionPlanSide, type InstrumentResult, type OrderSnapshot, type PaperOrderPreview, type PaperOrderSubmission, type QuoteSnapshot, type ReconciliationSnapshot, type TwsAdvancedReject, type TwsConnectRequest, type TwsLiveAllowlistRequest, type TwsModifyOrderRequest, type TwsTimeframe } from "./api";
import { TWS_ORDER_CAPABILITIES, canModifyOrderType, priceFieldsFor, type TwsOrderType } from "./orderCapabilities";
import { OrderRow } from "./OrderRow";
import { ScaleOutLadderPanel } from "./ScaleOutLadderPanel";
import { BracketBuilderPanel } from "./BracketBuilderPanel";
import { AdvancedOrderPanel } from "./AdvancedOrderPanel";
import { ScaleOutPackageManagerPanel } from "./ScaleOutPackageManagerPanel";
import { BracketPackageManagerPanel } from "./BracketPackageManagerPanel";
import { groupScaleOutOrders, parseScaleOutOrderRef, type ScaleOutOrderPackage } from "./scaleOutPackages";
import { groupBracketOrders, parseBracketOrderRef, type BracketOrderPackage } from "./bracketPackages";
import { TwsCandleChart, type PlanChartLine } from "./TwsCandleChart";
import { DepthPanel } from "./DepthPanel";
import { useTwsLiveQuote } from "./useTwsLiveQuote";
import { useTwsLiveBars } from "./useTwsLiveBars";
import { useTwsLiveDepth } from "./useTwsLiveDepth";
import { useTwsLiveStream } from "./useTwsLiveStream";

const STATUS_KEY = ["tws-status"];
export const RECON_KEY = ["tws-reconciliation"];
const LIVE_STATUS_KEY = ["tws-live-status"];

const PLAN_DEFAULTS: ExecutionPlanDraftRequest = {
  conid: 0,
  symbol: "",
  side: "BUY",
  quantity: 1,
  order_type: "LMT",
  limit_price: null,
  stop_price: null,
};


/** IBKR returns -1 for fields that have no data (unset sentinel). */
function ibkrVal(v: number | null): number | null {
  return v == null || v < 0 ? null : v;
}

function QuoteStrip({ quote, exchange, loading }: { quote: QuoteSnapshot | null | undefined; exchange: string; loading?: boolean }) {
  const last  = quote ? ibkrVal(quote.last)  : null;
  const close = quote ? ibkrVal(quote.close) : null;
  const bid   = quote ? ibkrVal(quote.bid)   : null;
  const ask   = quote ? ibkrVal(quote.ask)   : null;
  const high  = quote ? ibkrVal(quote.high)  : null;
  const low   = quote ? ibkrVal(quote.low)   : null;

  const change    = last != null && close != null ? last - close : null;
  const changePct = change != null && close != null && close !== 0 ? (change / close) * 100 : null;

  const isDelayed = quote ? (quote.is_delayed || quote.market_data_type === "delayed" || quote.market_data_type === "delayed_frozen") : false;
  const isLive    = quote?.market_data_type === "live";

  // Skeleton: animated when loading, static dash when data simply isn't available
  const skel = loading
    ? <span className="inline-block h-[11px] w-10 animate-pulse rounded bg-[var(--bg-2)]" />
    : <span className="font-data text-[var(--text-3)]">—</span>;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/50 bg-[var(--bg-0)] px-3 py-1.5 text-[11px]">
      {/* Last — always visible */}
      <span className="flex items-baseline gap-1.5">
        <span className="text-[var(--text-3)]">Last</span>
        {last != null ? <span className="font-data font-semibold text-[var(--text-1)]">{last.toFixed(2)}</span> : skel}
        {loading
          ? <span className="inline-block h-[11px] w-16 animate-pulse rounded bg-[var(--bg-2)]" />
          : change != null && (
            <span className={cn("font-data text-[10px]", change >= 0 ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]")}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}
              {changePct != null && ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`}
            </span>
          )
        }
      </span>
      {/* Bid / Ask — only once data arrives (often -1 on delayed feeds) */}
      {!loading && bid != null && (
        <span className="flex items-baseline gap-1">
          <span className="text-[var(--text-3)]">Bid</span>
          <span className="font-data text-[var(--text-1)]">{bid.toFixed(2)}</span>
        </span>
      )}
      {!loading && ask != null && (
        <span className="flex items-baseline gap-1">
          <span className="text-[var(--text-3)]">Ask</span>
          <span className="font-data text-[var(--text-1)]">{ask.toFixed(2)}</span>
        </span>
      )}
      {/* Close — always visible */}
      <span className="flex items-baseline gap-1">
        <span className="text-[var(--text-3)]">Close</span>
        {close != null ? <span className="font-data text-[var(--text-2)]">{close.toFixed(2)}</span> : skel}
      </span>
      {/* High — always visible */}
      <span className="flex items-baseline gap-1">
        <span className="text-[var(--text-3)]">High</span>
        {high != null ? <span className="font-data text-[var(--text-2)]">{high.toFixed(2)}</span> : skel}
      </span>
      {/* Low — always visible */}
      <span className="flex items-baseline gap-1">
        <span className="text-[var(--text-3)]">Low</span>
        {low != null ? <span className="font-data text-[var(--text-2)]">{low.toFixed(2)}</span> : skel}
      </span>
      {/* Exchange + status — appear once data is ready */}
      {!loading && (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {exchange && <span className="text-[var(--text-3)]">{exchange}</span>}
          {isDelayed && (
            <span className="rounded bg-[var(--glow-orange,rgba(251,146,60,0.12))] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--clr-orange,#fb923c)]">
              Delayed
            </span>
          )}
          {!isDelayed && isLive && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--clr-green)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--clr-green)]" />
              Live
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** Chart header title slot — shows the entitlement guidance note in place of
 * the plain title when data is limited/unavailable (no action button, no
 * account-settings link, no "which subscription to buy" detection, per the
 * Human Approval Gate), and falls back to the title once dismissed so the
 * button row never collapses into an empty slot. Keyed by conid at the call
 * site so switching symbols always starts fresh instead of staying dismissed
 * from a previous symbol. */
/** Informational-only entitlement note — no action button, no account-settings
 * link, no "which subscription to buy" detection (Human Approval Gate). Keyed
 * by conid at the call site so switching symbols always shows its own state
 * fresh instead of staying dismissed from a previous symbol. Rendered beside
 * the chart title, not in place of it. */
function EntitlementGuidanceNote({ reason, exchange }: { reason: string | null | undefined; exchange: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !reason) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-[var(--clr-orange)]">
      <span aria-hidden className="shrink-0">⚠</span>
      <span className="truncate">{reason}{exchange ? ` (${exchange})` : ""}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-[var(--clr-orange)]/70 hover:text-[var(--clr-orange)]"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}

/** Compact iOS-style switch — used instead of a plain toggle button where a
 * clear on/off state matters more than a label. */
function ToggleSwitch({ checked, onChange, title }: { checked: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={onChange}
      className={cn(
        "relative h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-[var(--clr-cyan)]" : "bg-[var(--bg-2)] border border-border",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-0.5 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-white shadow transition-transform duration-200",
          checked && "translate-x-[10px]",
        )}
      />
    </button>
  );
}

/** Extract the typed `error` key from a place-paper ApiError response body. */
function submitErrorCode(err: unknown): string | null {
  if (err instanceof ApiError) {
    const d = err.body.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const code = (d as Record<string, unknown>).error;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

/** Extract TwsAdvancedReject from an advanced_reject ApiError. */
function extractAdvancedReject(err: unknown): TwsAdvancedReject | null {
  if (err instanceof ApiError && submitErrorCode(err) === "advanced_reject") {
    const d = err.body.detail as Record<string, unknown>;
    const reject = d.reject;
    if (reject && typeof reject === "object" && !Array.isArray(reject)) {
      return reject as TwsAdvancedReject;
    }
  }
  return null;
}

const SUBMIT_ERROR_MESSAGES: Record<string, string> = {
  kill_switch_active: "Kill switch is active — deactivate it before placing orders.",
  not_connected: "Lost connection to TWS — reconnect and try again.",
  not_paper_port: "Not a paper port — only ports 4002 (IB Gateway) or 7497 (TWS) are allowed.",
  plan_not_valid: "Plan is no longer valid — re-validate before retrying.",
  invalid_plan: "Plan is no longer valid — re-validate before retrying.",
};




function Panel({
  title,
  children,
  className,
  headerRight,
  accent = "cyan",
  sweep = false,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  headerRight?: ReactNode;
  /** Pro-mode accent — shifts the title color and adds a faint panel glow. */
  accent?: "cyan" | "purple" | "orange" | "blue";
  /** Plays a one-shot light sweep across the header (e.g. on mode switch). */
  sweep?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-[var(--bg-1)] shadow-sm transition-shadow duration-300",
        accent === "purple" && "shadow-[0_0_0_1px_rgba(180,77,255,0.12),0_0_20px_rgba(180,77,255,0.06)]",
        accent === "orange" && "shadow-[0_0_0_1px_rgba(255,159,28,0.12),0_0_20px_rgba(255,159,28,0.06)]",
        accent === "blue" && "shadow-[0_0_0_1px_rgba(68,136,255,0.12),0_0_20px_rgba(68,136,255,0.06)]",
        className,
      )}
    >
      <div className={cn("relative shrink-0 overflow-hidden border-b border-border px-3 py-2", sweep && "panel-mode-sweep")}>
        <div className="flex items-center justify-between gap-2">
          <h2
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300",
              accent === "purple" ? "text-[var(--clr-purple)]" : accent === "orange" ? "text-[var(--clr-orange)]" : accent === "blue" ? "text-[var(--clr-blue)]" : "text-[var(--clr-cyan)]",
            )}
          >
            {title}
          </h2>
          {headerRight}
        </div>
      </div>
      <div className="flex-1 min-h-0 p-3">{children}</div>
    </section>
  );
}

function EmptyTableState({ label }: { label: string }) {
  return (
    <div className="flex min-h-16 items-center justify-center rounded border border-dashed border-border/80 bg-[var(--bg-0)]/40 text-center">
      <div>
        <div className="text-[12px] font-semibold text-[var(--text-1)]">{label}</div>
        <p className="mt-1 text-[11px] text-[var(--text-3)]">
          Connect and reconcile to view {label.toLowerCase()}.
        </p>
      </div>
    </div>
  );
}

function packageLegPrice(order: OrderSnapshot): string {
  if (order.lmt_price != null && order.stop_price != null)
    return `STP ${order.stop_price.toFixed(2)} / LMT ${order.lmt_price.toFixed(2)}`;
  if (order.stop_price != null) return order.stop_price.toFixed(2);
  if (order.lmt_price != null) return order.lmt_price.toFixed(2);
  return "—";
}

/** Scale-out legs are a linked package, not independent orders — no per-leg
 * Cancel/Modify here. Editing one quantity can require matching changes to
 * target, stop, and fallback legs together, so that lives in "Manage package". */
function ScaleOutPackageRows({
  pkg,
  onManage,
}: {
  pkg: ScaleOutOrderPackage;
  onManage: () => void;
}) {
  const legRows = pkg.lots.flatMap((lot) =>
    [lot.entry, ...lot.exits]
      .filter((o): o is OrderSnapshot => o != null)
      .map((order) => ({ lotIndex: lot.lotIndex, order })),
  );

  return (
    <>
      <tr className="border-t border-border bg-[var(--glow-purple)]/40 text-xs">
        <td colSpan={10} className="py-1.5 pr-3">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="rounded bg-[var(--clr-purple)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--clr-purple)]">
                Scale-Out
              </span>
              <span className="font-medium">{pkg.symbol}</span>
              <span className="text-[var(--text-3)]">pkg {pkg.packageId.slice(0, 8)}</span>
              {pkg.warnings.length > 0 && (
                <span className="text-[var(--clr-orange)]">⚠ {pkg.warnings.length}</span>
              )}
            </span>
            <button
              type="button"
              className="h-5 shrink-0 rounded border border-[var(--clr-purple)]/50 px-2 text-[10px] text-[var(--clr-purple)] hover:bg-[var(--clr-purple)]/10 active:scale-95"
              onClick={onManage}
            >
              Manage package
            </button>
          </div>
        </td>
      </tr>
      {legRows.map(({ lotIndex, order }) => (
        <tr key={order.order_id} className="border-t border-border/40 text-xs">
          <td className="py-1 pr-3 pl-4 text-[var(--text-3)]">
            Lot {lotIndex + 1} · {parseScaleOutOrderRef(order.order_ref)?.roleType ?? "—"}
          </td>
          <td className={`pr-3 ${order.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
            {order.side}
          </td>
          <td className="pr-3 font-data">{order.quantity}</td>
          <td className="pr-3 font-data text-[var(--text-2)]">{order.order_type}</td>
          <td className="pr-3 font-data text-[var(--text-2)]">{packageLegPrice(order)}</td>
          <td className="pr-3 text-[var(--text-2)]">{order.status}</td>
          <td className="pr-3 text-[var(--text-3)]">{order.parent_id ?? "—"}</td>
          <td className="pr-3 text-[var(--text-3)]">{order.oca_group ? order.oca_group.split("-").pop() : "—"}</td>
          <td className="pr-2" />
          <td className="whitespace-nowrap py-1 text-[10px] text-[var(--text-3)]">—</td>
        </tr>
      ))}
    </>
  );
}

/** A bracket's legs are one linked package, same as a scale-out lot — no
 * per-leg Cancel/Modify here. "Manage bracket" reopens this package in the
 * Execution Plan panel, where each leg can still be canceled/modified
 * individually (unlike scale-out's read-only manager, a bracket leg really
 * is just one order and needs no coordinated multi-leg edit). */
function BracketPackageRows({
  pkg,
  onManage,
}: {
  pkg: BracketOrderPackage;
  onManage: () => void;
}) {
  return (
    <>
      <tr className="border-t border-border bg-[var(--glow-orange)]/40 text-xs">
        <td colSpan={10} className="py-1.5 pr-3">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="rounded bg-[var(--clr-orange)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--clr-orange)]">
                Bracket
              </span>
              <span className="font-medium">{pkg.symbol}</span>
              <span className="text-[var(--text-3)]">pkg {pkg.packageId.slice(0, 8)}</span>
              {pkg.warnings.length > 0 && (
                <span className="text-[var(--clr-orange)]">⚠ {pkg.warnings.length}</span>
              )}
            </span>
            <button
              type="button"
              className="h-5 shrink-0 rounded border border-[var(--clr-orange)]/50 px-2 text-[10px] text-[var(--clr-orange)] hover:bg-[var(--clr-orange)]/10 active:scale-95"
              onClick={onManage}
            >
              Manage bracket
            </button>
          </div>
        </td>
      </tr>
      {pkg.orders.map((order) => (
        <tr key={order.order_id} className="border-t border-border/40 text-xs">
          <td className="py-1 pr-3 pl-4 text-[var(--text-3)]">
            {parseBracketOrderRef(order.order_ref)?.roleType ?? "—"}
          </td>
          <td className={`pr-3 ${order.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
            {order.side}
          </td>
          <td className="pr-3 font-data">{order.quantity}</td>
          <td className="pr-3 font-data text-[var(--text-2)]">{order.order_type}</td>
          <td className="pr-3 font-data text-[var(--text-2)]">{packageLegPrice(order)}</td>
          <td className="pr-3 text-[var(--text-2)]">{order.status}</td>
          <td className="pr-3 text-[var(--text-3)]">{order.parent_id ?? "—"}</td>
          <td className="pr-3 text-[var(--text-3)]">{order.oca_group ? order.oca_group.split("-").pop() : "—"}</td>
          <td className="pr-2" />
          <td className="whitespace-nowrap py-1 text-[10px] text-[var(--text-3)]">—</td>
        </tr>
      ))}
    </>
  );
}

type PlanMode = "standard" | "scale_out" | "bracket" | "advanced";

export function TwsExecutionAssistantModule() {
  const queryClient = useQueryClient();
  const { streamConnected } = useTwsLiveStream();
  const [planMode, setPlanMode] = useState<PlanMode>("standard");
  const [sweeping, setSweeping] = useState(false);
  const [form, setForm] = useState<TwsConnectRequest>(TWS_CONNECT_DEFAULTS);
  const [planForm, setPlanForm] = useState<ExecutionPlanDraftRequest>(PLAN_DEFAULTS);
  const [currentPlan, setCurrentPlan] = useState<ExecutionPlan | null>(null);
  const [paperPreview, setPaperPreview] = useState<PaperOrderPreview | null>(null);
  const [paperSubmission, setPaperSubmission] = useState<PaperOrderSubmission | null>(null);
  const [searchResults, setSearchResults] = useState<InstrumentResult[]>([]);
  const [activeTimeframe, setActiveTimeframe] = useState<TwsTimeframe>("5m");
  const [showPlanLines, setShowPlanLines] = useState(true);
  const [selectedExchange, setSelectedExchange] = useState("");
  const [selectedCompanyName, setSelectedCompanyName] = useState("");
  const [editingOrder, setEditingOrder] = useState<OrderSnapshot | null>(null);
  const [modifyForm, setModifyForm] = useState<TwsModifyOrderRequest>({ quantity: 1, limit_price: null, stop_price: null });
  const [modifyReview, setModifyReview] = useState(false);
  const [advancedReject, setAdvancedReject] = useState<TwsAdvancedReject | null>(null);
  const [managedScaleOutPackageId, setManagedScaleOutPackageId] = useState<string | null>(null);
  const [managedBracketPackageId, setManagedBracketPackageId] = useState<string | null>(null);

  // Reviewed or already-submitted — the draft is no longer being edited, so
  // its chart lines lock and mode switching is disabled to prevent the plan
  // silently drifting away from what was reviewed.
  const standardReviewLocked = paperPreview != null || paperSubmission != null;

  const standardPlanLines = useMemo<PlanChartLine[]>(() => {
    const fields = priceFieldsFor(planForm.order_type);
    const lines: PlanChartLine[] = [];
    if (fields.includes("limit_price") && planForm.limit_price && planForm.limit_price > 0) {
      lines.push({
        id: "plan-limit", price: planForm.limit_price, kind: "entry", label: "Entry",
        onDrag: (p) => setPlanForm((f) => ({ ...f, limit_price: p })),
        locked: standardReviewLocked,
      });
    }
    if (fields.includes("stop_price") && planForm.stop_price && planForm.stop_price > 0) {
      lines.push({
        id: "plan-stop", price: planForm.stop_price, kind: "stop", label: "Stop",
        onDrag: (p) => setPlanForm((f) => ({ ...f, stop_price: p })),
        locked: standardReviewLocked,
      });
    }
    return lines;
  }, [planForm.order_type, planForm.limit_price, planForm.stop_price, standardReviewLocked]);

  const modifyPlanLines = useMemo<PlanChartLine[]>(() => {
    if (!editingOrder) return [];
    const fields = canModifyOrderType(editingOrder.order_type)
      ? priceFieldsFor(editingOrder.order_type as TwsOrderType)
      : [];
    const lines: PlanChartLine[] = [];
    if (fields.includes("limit_price") && modifyForm.limit_price && modifyForm.limit_price > 0) {
      lines.push({
        id: "modify-limit", price: modifyForm.limit_price, kind: "entry", label: "Entry",
        onDrag: (p) => setModifyForm((f) => ({ ...f, limit_price: p })),
        locked: modifyReview,
      });
    }
    if (fields.includes("stop_price") && modifyForm.stop_price && modifyForm.stop_price > 0) {
      lines.push({
        id: "modify-stop", price: modifyForm.stop_price, kind: "stop", label: "Stop",
        onDrag: (p) => setModifyForm((f) => ({ ...f, stop_price: p })),
        locked: modifyReview,
      });
    }
    return lines;
  }, [editingOrder, modifyForm.limit_price, modifyForm.stop_price, modifyReview]);

  const [panelChart, setPanelChart] = useState<{ conid: number; lines: PlanChartLine[] }>({ conid: 0, lines: [] });
  const handlePanelChartLines = useCallback(
    (conid: number, lines: PlanChartLine[]) => setPanelChart({ conid, lines }),
    [],
  );

  // Scale-out/bracket/advanced panels have their own preview/submission review
  // state the module can't see directly — mirrors standardReviewLocked so mode
  // switching can't silently unmount a panel mid-review (same bug class 9f5c02d
  // fixed for the standard-mode flow).
  const [panelReviewLocked, setPanelReviewLocked] = useState(false);
  const handlePanelReviewLocked = useCallback((locked: boolean) => setPanelReviewLocked(locked), []);
  const reviewLocked = standardReviewLocked || panelReviewLocked;

  const EMPTY_LINES: PlanChartLine[] = useMemo(() => [], []);
  const panelLinesMatch = panelChart.conid > 0 && panelChart.conid === planForm.conid;
  const editingLinesMatch = editingOrder != null && editingOrder.conid === planForm.conid;
  const chartLines = !showPlanLines ? EMPTY_LINES
    : editingOrder != null ? (editingLinesMatch ? modifyPlanLines : EMPTY_LINES)
    : planMode === "standard" ? standardPlanLines
    : (planMode === "scale_out" || planMode === "bracket") && panelLinesMatch ? panelChart.lines
    : EMPTY_LINES;
  const panelLinesMismatch =
    showPlanLines && (planMode === "scale_out" || planMode === "bracket") &&
    panelChart.lines.length > 0 && !panelLinesMatch;
  const editingLinesMismatch = showPlanLines && editingOrder != null && !editingLinesMatch;

  const { data: status } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: twsApi.getStatus,
    refetchInterval: 5000,
  });

  const { data: recon } = useQuery({
    queryKey: RECON_KEY,
    queryFn: twsApi.getReconciliation,
    refetchInterval: 10000,
    enabled: status?.connected === true,
  });

  const { packages: scaleOutPackages, standaloneOrders: afterScaleOut } = recon
    ? groupScaleOutOrders(recon)
    : { packages: [] as ScaleOutOrderPackage[], standaloneOrders: [] as OrderSnapshot[] };
  const { packages: bracketPackages, standaloneOrders } = groupBracketOrders(afterScaleOut, recon?.package_warnings ?? []);
  const managedScaleOutPackage = scaleOutPackages.find((p) => p.packageId === managedScaleOutPackageId) ?? null;
  const managedBracketPackage = bracketPackages.find((p) => p.packageId === managedBracketPackageId) ?? null;

  const connectMutation = useMutation({
    mutationFn: twsApi.connect,
    onSuccess: (result) => {
      queryClient.setQueryData(STATUS_KEY, result);
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
      queryClient.invalidateQueries({ queryKey: BROKER_SESSION_KEY });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: twsApi.disconnect,
    onSuccess: (result) => {
      queryClient.setQueryData(STATUS_KEY, result);
      queryClient.setQueryData(RECON_KEY, undefined);
      queryClient.invalidateQueries({ queryKey: BROKER_SESSION_KEY });
    },
  });

  const { data: livePolicy } = useQuery({
    queryKey: LIVE_STATUS_KEY,
    queryFn: twsApi.getLiveStatus,
    refetchInterval: 5000,
    enabled: status?.connected === true,
  });

  const isLiveSession = status?.connected === true && livePolicy?.is_paper_port === false;
  const liveRequest: TwsLiveAllowlistRequest | null =
    livePolicy?.connected_account_id && livePolicy.connected_port != null
      ? { account_id: livePolicy.connected_account_id, host: livePolicy.connected_host, port: livePolicy.connected_port }
      : null;

  const allowLiveMutation = useMutation({
    mutationFn: twsApi.allowLive,
    onSuccess: (result) => queryClient.setQueryData(LIVE_STATUS_KEY, result),
  });

  const armLiveMutation = useMutation({
    mutationFn: twsApi.armLive,
    onSuccess: (result) => queryClient.setQueryData(LIVE_STATUS_KEY, result),
  });

  const disarmLiveMutation = useMutation({
    mutationFn: twsApi.disarmLive,
    onSuccess: (result) => queryClient.setQueryData(LIVE_STATUS_KEY, result),
  });

  const reviewMutation = useMutation({
    mutationFn: async (req: ExecutionPlanDraftRequest) => {
      const plan = await twsApi.createPlanDraft(req);
      const validated = await twsApi.validatePlan(plan.plan_id);
      if (validated.status !== "valid") return { plan: validated, preview: null };
      const preview = isLiveSession
        ? await twsApi.previewLiveOrder(plan.plan_id)
        : await twsApi.previewPaperOrder(plan.plan_id);
      return { plan: validated, preview };
    },
    onSuccess: ({ plan, preview }) => {
      setCurrentPlan(plan);
      setPaperPreview(preview);
      setPaperSubmission(null);
      setSearchResults([]);
    },
  });

  const placeOrderMutation = useMutation({
    mutationFn: (plan_id: string) =>
      isLiveSession ? twsApi.placeLiveOrder(plan_id) : twsApi.placePaperOrder(plan_id),
    onSuccess: (submission) => {
      setAdvancedReject(null);
      setPaperSubmission(submission);
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      const reject = extractAdvancedReject(err);
      if (reject) {
        setAdvancedReject(reject);
        return;
      }
      if (submitErrorCode(err) === "unknown_outcome") {
        queryClient.invalidateQueries({ queryKey: RECON_KEY });
        queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      }
    },
  });

  const overrideOrderMutation = useMutation({
    mutationFn: (req: Parameters<typeof twsApi.overrideOrder>[0]) => twsApi.overrideOrder(req),
    onSuccess: (result) => {
      setAdvancedReject(null);
      if (editingOrder) {
        setEditingOrder(null);
        setModifyReview(false);
      } else if (currentPlan) {
        // Build a full receipt from the plan — paperSubmission is null when the
        // original place was blocked by an advanced reject.
        setPaperSubmission({
          order_id: result.order_id,
          status: result.status,
          plan_id: currentPlan.plan_id,
          conid: currentPlan.conid,
          symbol: currentPlan.symbol,
          side: currentPlan.side,
          quantity: currentPlan.quantity,
          order_type: currentPlan.order_type,
          limit_price: currentPlan.limit_price,
          stop_price: currentPlan.stop_price,
          submitted_at: new Date().toISOString(),
        });
      }
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: RECON_KEY });
        queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      }, 1000);
    },
    onError: (err) => {
      const reject = extractAdvancedReject(err);
      if (reject) {
        setAdvancedReject(reject);
        return;
      }
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });

  const cancelOrderMutation = useMutation({
    mutationFn: (order_id: number) => twsApi.cancelOrder(order_id),
    onMutate: async (order_id) => {
      await queryClient.cancelQueries({ queryKey: RECON_KEY });
      const previous = queryClient.getQueryData<ReconciliationSnapshot>(RECON_KEY);
      if (previous) {
        const removed = previous.open_orders.find((o) => o.order_id === order_id);
        queryClient.setQueryData<ReconciliationSnapshot>(RECON_KEY, {
          ...previous,
          open_orders: previous.open_orders.filter((o) => o.order_id !== order_id),
          open_order_count: previous.open_order_count - 1,
          unmanaged_order_count: removed?.is_unmanaged
            ? previous.unmanaged_order_count - 1
            : previous.unmanaged_order_count,
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(RECON_KEY, ctx.previous);
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onSuccess: () => {
      // Delay refetch to let TWS process the cancel before we confirm truth.
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: RECON_KEY });
        queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      }, 1000);
    },
  });

  const modifyOrderMutation = useMutation({
    mutationFn: ({ order_id, req }: { order_id: number; req: TwsModifyOrderRequest }) =>
      twsApi.modifyOrder(order_id, req),
    onMutate: async ({ order_id, req }) => {
      await queryClient.cancelQueries({ queryKey: RECON_KEY });
      const previous = queryClient.getQueryData<ReconciliationSnapshot>(RECON_KEY);
      if (previous) {
        queryClient.setQueryData<ReconciliationSnapshot>(RECON_KEY, {
          ...previous,
          open_orders: previous.open_orders.map((o) =>
            o.order_id === order_id
              ? { ...o, quantity: req.quantity, lmt_price: req.limit_price, stop_price: req.stop_price }
              : o,
          ),
        });
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      const reject = extractAdvancedReject(err);
      if (reject) {
        setAdvancedReject(reject);
        return;
      }
      if (ctx?.previous) queryClient.setQueryData(RECON_KEY, ctx.previous);
      queryClient.invalidateQueries({ queryKey: RECON_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onSuccess: () => {
      setAdvancedReject(null);
      setEditingOrder(null);
      setModifyReview(false);
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: RECON_KEY });
        queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      }, 1000);
    },
  });

  const searchMutation = useMutation({
    mutationFn: (symbol: string) => twsApi.searchInstruments(symbol),
    onSuccess: (results) => {
      setSearchResults(results);
      const stk = results.filter(
        (r) => r.sec_type === "STK" && r.exchange === "SMART" && r.currency === "USD",
      );
      if (stk.length === 1) {
        setPlanForm((f) => ({ ...f, conid: stk[0].conid, limit_price: null, stop_price: null }));
        setSelectedExchange(stk[0].primary_exchange);
        setSelectedCompanyName(stk[0].company_name);
        setSearchResults([]);
      }
    },
  });

  const { data: quote, isLoading: quoteLoading } = useQuery({
    queryKey: ["tws-quote", planForm.conid],
    queryFn: () => twsApi.getQuote(planForm.conid),
    enabled: status?.connected === true && planForm.conid > 0,
    staleTime: 15000,
    refetchInterval: 30000,
  });
  const liveQuote = useTwsLiveQuote(planForm.conid);
  const displayedQuote = useMemo(() => {
    if (!quote || !liveQuote) return quote;
    return {
      ...quote,
      last: liveQuote.last ?? quote.last,
      bid: liveQuote.bid ?? quote.bid,
      ask: liveQuote.ask ?? quote.ask,
      high: liveQuote.high ?? quote.high,
      low: liveQuote.low ?? quote.low,
      market_data_type: liveQuote.entitlement,
      is_delayed: liveQuote.entitlement === "delayed" || liveQuote.entitlement === "delayed_frozen",
      unavailable_reason: liveQuote.unavailable_reason,
    };
  }, [liveQuote, quote]);

  const { data: barsData, isLoading: barsLoading } = useQuery({
    queryKey: ["tws-bars", planForm.conid, activeTimeframe],
    queryFn: () => twsApi.getBars(planForm.conid, activeTimeframe),
    enabled: status?.connected === true && planForm.conid > 0,
    staleTime: 60_000,
  });
  const liveBar = useTwsLiveBars(planForm.conid, activeTimeframe);
  const depth = useTwsLiveDepth(planForm.conid);

  const quoteUnavailable =
    displayedQuote != null &&
    (displayedQuote.market_data_type === "unavailable" || displayedQuote.market_data_type === "partial");
  const depthUnavailable = depth?.entitlement === "unavailable";
  const entitlementGuidanceReason = quoteUnavailable
    ? displayedQuote?.unavailable_reason
    : depthUnavailable
      ? depth?.unavailable_reason
      : null;

  /** Single entry point for "Modify" anywhere in Open Orders (standalone rows
   * or from inside a package manager panel). Clears every other transient
   * Execution Plan view first — otherwise the panel's priority ternary would
   * keep showing whichever managed-package view was already open instead of
   * the modify form, the same silently-does-nothing bug class hit before. */
  function focusOrderForModify(order: OrderSnapshot) {
    setManagedScaleOutPackageId(null);
    setManagedBracketPackageId(null);
    setPlanMode("standard");
    setEditingOrder(order);
    setModifyForm({ quantity: order.quantity, limit_price: order.lmt_price, stop_price: order.stop_price });
    setModifyReview(false);
    modifyOrderMutation.reset();
  }

  function selectPlanMode(mode: PlanMode) {
    if (mode === planMode || reviewLocked) return;
    setPlanMode(mode);
    if (mode === "scale_out") {
      setSweeping(true);
      window.setTimeout(() => setSweeping(false), 500);
    } else {
      setSweeping(false);
    }
  }

  function handleSymbolChange(value: string) {
    setPlanForm((f) => ({ ...f, symbol: value.toUpperCase(), conid: 0, limit_price: null, stop_price: null }));
    setSearchResults([]);
    setSelectedExchange("");
    setSelectedCompanyName("");
  }

  function runSearch() {
    if (planForm.symbol && status?.connected) searchMutation.mutate(planForm.symbol);
  }

  function saveDraftDisabledReason(): string | null {
    if (!planForm.symbol) return "Enter a symbol.";
    if (!planForm.conid) return "Resolve symbol to get ConID.";
    if (planForm.quantity <= 0) return "Quantity must be positive.";
    const fields = priceFieldsFor(planForm.order_type);
    if (fields.includes("stop_price") && !(planForm.stop_price && planForm.stop_price > 0))
      return "Enter a stop trigger.";
    if (fields.includes("limit_price") && !(planForm.limit_price && planForm.limit_price > 0))
      return "Enter a limit price.";
    return null;
  }

  function modifyDisabledReason(): string | null {
    if (!editingOrder) return null;
    if (modifyForm.quantity <= 0) return "Quantity must be positive.";
    if (!canModifyOrderType(editingOrder.order_type)) return null;
    const fields = priceFieldsFor(editingOrder.order_type as TwsOrderType);
    if (fields.includes("stop_price") && !(modifyForm.stop_price && modifyForm.stop_price > 0))
      return "Enter a stop trigger.";
    if (fields.includes("limit_price") && !(modifyForm.limit_price && modifyForm.limit_price > 0))
      return "Enter a limit price.";
    return null;
  }

  const adapterState = status?.adapter_state ?? "not_initialized";
  const connected = status?.connected === true;
  const reconciled = connected && recon != null;
  const canDraft = reconciled;
  const isPending =
    adapterState === "connecting" ||
    connectMutation.isPending ||
    disconnectMutation.isPending;
  const summary = recon ?? status?.reconciliation_summary;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--bg-0)] text-foreground">
      <header className="m-2 mb-1.5 flex min-h-10 items-center gap-3 rounded-md border border-border bg-[var(--bg-1)] px-3">
        <BackToOrbitButton />
        <div className="h-5 w-px bg-border" />
        <p className="hidden text-[9px] font-medium uppercase tracking-[0.26em] text-[var(--text-3)] sm:block">
          Orbit Module
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold">TWS Execution Assistant</h1>
          <span className="rounded bg-[var(--glow-cyan)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--clr-cyan)]">
            Broker cockpit
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <span
            className={cn(
              "hidden rounded px-1.5 py-0.5 text-[9px] font-semibold sm:inline-flex",
              streamConnected
                ? "bg-[var(--glow-green)] text-[var(--clr-green)]"
                : "bg-[var(--bg-2)] text-[var(--text-3)]",
            )}
          >
            Stream {streamConnected ? "connected" : "disconnected"}
          </span>
          {connected ? (
            <>
              <span className="hidden items-center gap-1.5 text-[11px] font-semibold text-[var(--clr-green)] sm:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--clr-green)]" />
                Paper TWS connected
              </span>
              <button
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--clr-orange)]/50 px-3 text-[11px] font-medium text-[var(--clr-orange)] transition-colors hover:bg-[var(--glow-orange)] hover:border-[var(--clr-orange)] active:scale-[0.96] disabled:opacity-50"
                disabled={isPending}
                onClick={() => disconnectMutation.mutate()}
              >
                <Power className="h-3.5 w-3.5" strokeWidth={1.7} />
                {isPending ? "Disconnecting..." : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="h-7 rounded-md border border-[var(--clr-cyan)] px-3 text-[11px] font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96] disabled:opacity-50"
              disabled={isPending}
              onClick={() => connectMutation.mutate(form)}
            >
              {isPending ? "Connecting..." : "Connect TWS / IB Gateway"}
            </button>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1 pb-1">
        {connected ? (
          <div className="flex divide-x divide-border overflow-hidden rounded-md border border-border bg-[var(--bg-1)] text-[11px]">
            <div className="flex items-center gap-1.5 px-4 py-2.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--clr-green)]" strokeWidth={1.7} />
              <span className="font-semibold text-[var(--clr-green)]">Reconciled</span>
            </div>
            <div className="flex items-center gap-1.5 px-4 py-2.5">
              <span className="font-data font-medium text-[var(--text-1)]">{summary?.position_count ?? 0}</span>
              <span className="text-[var(--text-2)]">{(summary?.position_count ?? 0) === 1 ? "position" : "positions"}</span>
            </div>
            <div className="flex items-center gap-1.5 px-4 py-2.5">
              <span className="font-data font-medium text-[var(--text-1)]">{summary?.open_order_count ?? 0}</span>
              <span className="text-[var(--text-2)]">{(summary?.open_order_count ?? 0) === 1 ? "open order" : "open orders"}</span>
            </div>
            <div className="flex items-center gap-1.5 px-4 py-2.5">
              <Power className={cn("h-3.5 w-3.5 shrink-0", status?.kill_switch_active ? "text-[var(--clr-red)]" : "text-[var(--text-3)]")} strokeWidth={1.7} />
              <span className={status?.kill_switch_active ? "font-semibold text-[var(--clr-red)]" : "text-[var(--text-2)]"}>
                Kill switch {status?.kill_switch_active ? "active" : "inactive"}
              </span>
            </div>
            <div className="ml-auto flex items-center px-4 py-2.5">
              <span className="rounded-full border border-[var(--clr-cyan)]/40 bg-[var(--glow-cyan)] px-2 py-0.5 text-[10px] font-semibold text-[var(--clr-cyan)]">
                TWS only
              </span>
            </div>
            {isLiveSession && liveRequest && (
              <div className="flex items-center gap-2 border-l border-border px-4 py-2.5">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  livePolicy?.armed
                    ? "border border-[var(--clr-red)]/40 bg-[var(--clr-red)]/10 text-[var(--clr-red)]"
                    : "border border-[var(--clr-orange)]/40 bg-[var(--glow-orange)] text-[var(--clr-orange)]",
                )}>
                  {livePolicy?.armed ? "LIVE ARMED" : "LIVE LOCKED"}
                </span>
                {!livePolicy?.allowlisted ? (
                  <button
                    type="button"
                    className="h-6 rounded border border-[var(--clr-orange)]/50 px-2 text-[10px] font-semibold text-[var(--clr-orange)] hover:bg-[var(--clr-orange)]/10 disabled:opacity-50"
                    disabled={allowLiveMutation.isPending}
                    onClick={() => allowLiveMutation.mutate(liveRequest)}
                  >
                    Allow account
                  </button>
                ) : !livePolicy.armed ? (
                  <button
                    type="button"
                    className="h-6 rounded border border-[var(--clr-red)]/50 px-2 text-[10px] font-semibold text-[var(--clr-red)] hover:bg-[var(--clr-red)]/10 disabled:opacity-50"
                    disabled={armLiveMutation.isPending}
                    onClick={() => armLiveMutation.mutate(liveRequest)}
                  >
                    Arm live
                  </button>
                ) : (
                  <button
                    type="button"
                    className="h-6 rounded border border-border px-2 text-[10px] text-[var(--text-2)] hover:bg-[var(--bg-0)]"
                    disabled={disarmLiveMutation.isPending}
                    onClick={() => disarmLiveMutation.mutate()}
                  >
                    Disarm
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-[var(--bg-1)] px-3 py-2">
            {adapterState === "error" && (
              <p className="mb-2 text-xs text-[var(--clr-red)]">
                Connection failed. Check that TWS or IB Gateway is running on the host and port below.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-3)]">Host</span>
                <input
                  className="h-8 w-28 rounded border border-border bg-[var(--bg-0)] px-2.5 font-data text-[12px] outline-none transition-colors focus:border-[var(--clr-cyan)]"
                  value={form.host}
                  onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-3)]">Port</span>
                <input
                  type="number"
                  className="h-8 w-20 rounded border border-border bg-[var(--bg-0)] px-2.5 font-data text-[12px] outline-none transition-colors focus:border-[var(--clr-cyan)]"
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
                />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] text-[var(--text-3)]">Client ID</span>
                <input
                  type="number"
                  className="h-8 w-20 rounded border border-border bg-[var(--bg-0)] px-2.5 font-data text-[12px] outline-none transition-colors focus:border-[var(--clr-cyan)]"
                  value={form.client_id}
                  onChange={(e) => setForm((f) => ({ ...f, client_id: Number(e.target.value) }))}
                />
              </label>
              <button
                className="h-8 rounded-md border border-[var(--clr-cyan)] px-3 text-[12px] font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96] disabled:opacity-50"
                disabled={isPending}
                onClick={() => connectMutation.mutate(form)}
              >
                {isPending ? "Connecting..." : "Connect"}
              </button>
              {status?.api_server_available != null && (
                <span className="text-[11px] text-[var(--text-3)]">
                  API {status.api_server_available ? "reachable" : "not reachable"}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="grid h-[480px] shrink-0 gap-1.5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel
            title="Execution Plan"
            className="h-[480px]"
            accent={planMode === "scale_out" ? "purple" : planMode === "bracket" ? "orange" : planMode === "advanced" ? "blue" : "cyan"}
            sweep={sweeping}
            headerRight={
              <div className="flex shrink-0 rounded-full border border-border p-0.5 text-[9px] font-semibold">
                <button
                  type="button"
                  disabled={reviewLocked}
                  title={reviewLocked ? "Finish or cancel the current review to change plan type" : undefined}
                  className={cn(
                    "rounded-full px-2 py-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
                    planMode === "standard" ? "bg-[var(--clr-cyan)] text-[var(--bg-0)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]",
                  )}
                  onClick={() => selectPlanMode("standard")}
                >
                  Standard
                </button>
                <button
                  type="button"
                  disabled={reviewLocked}
                  title={reviewLocked ? "Finish or cancel the current review to change plan type" : undefined}
                  className={cn(
                    "rounded-full px-2 py-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
                    planMode === "scale_out" ? "bg-[var(--clr-purple)] text-[var(--bg-0)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]",
                  )}
                  onClick={() => selectPlanMode("scale_out")}
                >
                  Scale-Out
                </button>
                <button
                  type="button"
                  disabled={reviewLocked}
                  title={reviewLocked ? "Finish or cancel the current review to change plan type" : undefined}
                  className={cn(
                    "rounded-full px-2 py-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
                    planMode === "bracket" ? "bg-[var(--clr-orange)] text-[var(--bg-0)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]",
                  )}
                  onClick={() => selectPlanMode("bracket")}
                >
                  Bracket
                </button>
                <button
                  type="button"
                  disabled={reviewLocked}
                  title={reviewLocked ? "Finish or cancel the current review to change plan type" : undefined}
                  className={cn(
                    "rounded-full px-2 py-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
                    planMode === "advanced" ? "bg-[var(--clr-blue)] text-[var(--bg-0)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]",
                  )}
                  onClick={() => selectPlanMode("advanced")}
                >
                  Advanced
                </button>
              </div>
            }
          >
              {managedScaleOutPackage != null ? (
                <ScaleOutPackageManagerPanel
                  pkg={managedScaleOutPackage}
                  onCancelLot={(ids) => ids.forEach((id) => cancelOrderMutation.mutate(id))}
                  onModify={focusOrderForModify}
                  onClose={() => setManagedScaleOutPackageId(null)}
                />
              ) : managedBracketPackage != null ? (
                <BracketPackageManagerPanel
                  pkg={managedBracketPackage}
                  warnings={recon?.package_warnings ?? []}
                  onClose={() => setManagedBracketPackageId(null)}
                  onCancel={(id) => cancelOrderMutation.mutate(id)}
                  onModify={focusOrderForModify}
                />
              ) : advancedReject != null ? (
                <div className="flex h-full flex-col">
                  <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 pb-2">
                    <div className="rounded border border-[var(--clr-orange)]/40 bg-[var(--clr-orange)]/8 px-4 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--clr-orange)]">TWS Rejected</div>
                      <p className="mt-1 text-xs text-[var(--text-1)]">{advancedReject.reason}</p>
                    </div>
                    {advancedReject.override_codes.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Override codes</div>
                        <div className="flex flex-wrap gap-1.5">
                          {advancedReject.override_codes.map((code) => (
                            <span key={code} className="rounded bg-[var(--bg-0)] border border-border px-2 py-0.5 font-mono text-[10px] text-[var(--text-2)]">{code}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    <details className="rounded border border-border">
                      <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] select-none">Raw TWS response</summary>
                      <pre className="overflow-x-auto p-3 text-[10px] text-[var(--text-3)] font-mono">{JSON.stringify(advancedReject.raw, null, 2)}</pre>
                    </details>
                  </div>
                  <div className="shrink-0 flex flex-wrap items-center gap-3 pt-2">
                    <button
                      className="h-9 rounded-md bg-[var(--clr-orange)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                      disabled={overrideOrderMutation.isPending}
                      onClick={() => {
                        if (editingOrder) {
                          overrideOrderMutation.mutate({
                            intent: "modify",
                            order_id: editingOrder.order_id,
                            plan_id: null,
                            modify: modifyForm,
                            override_codes: advancedReject.override_codes,
                          });
                        } else if (currentPlan) {
                          overrideOrderMutation.mutate({
                            intent: "place",
                            order_id: null,
                            plan_id: currentPlan.plan_id,
                            modify: null,
                            override_codes: advancedReject.override_codes,
                          });
                        }
                      }}
                    >
                      {overrideOrderMutation.isPending ? "Submitting..." : "Override and submit"}
                    </button>
                    <button
                      className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] hover:bg-[var(--bg-1)] hover:text-[var(--text-1)]"
                      disabled={overrideOrderMutation.isPending}
                      onClick={() => {
                        setAdvancedReject(null);
                        queryClient.invalidateQueries({ queryKey: RECON_KEY });
                      }}
                    >
                      Cancel
                    </button>
                    {overrideOrderMutation.isError && submitErrorCode(overrideOrderMutation.error) !== "advanced_reject" && (
                      <p className="w-full text-xs text-[var(--clr-red)]">Override failed — check TWS connection and try again.</p>
                    )}
                  </div>
                </div>
              ) : editingOrder != null ? (() => {
                const editableFields = canModifyOrderType(editingOrder.order_type)
                  ? priceFieldsFor(editingOrder.order_type as TwsOrderType)
                  : [];
                const reason = modifyDisabledReason();
                // A scale-out leg's entry/target/stop must always share the same share
                // count — quantity edits need coordinating across the whole lot, which
                // isn't built yet. Price-only edits (this form's other fields) don't
                // have that constraint, so they stay open.
                const modifyQuantityLocked = parseScaleOutOrderRef(editingOrder.order_ref) != null;
                return (
                  <div className="flex h-full flex-col">
                    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
                      <div className="rounded border border-[var(--clr-orange)]/30 bg-[var(--bg-0)] px-4 py-3">
                        <div className="text-xs text-[var(--text-3)]">Modifying {editingOrder.order_type} order #{editingOrder.order_id}</div>
                        <div className="mt-0.5 font-data text-sm font-semibold">{editingOrder.symbol} {editingOrder.side}</div>
                      </div>
                      {!modifyReview ? (
                        <>
                          <label className="space-y-1.5">
                            <span className="text-xs font-medium text-[var(--text-2)]">
                              Quantity
                              {modifyQuantityLocked && (
                                <span className="ml-1.5 text-[10px] font-normal normal-case text-[var(--text-3)]">
                                  locked — must match the rest of this lot
                                </span>
                              )}
                            </span>
                            <input
                              type="number"
                              className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed disabled:opacity-50"
                              value={modifyForm.quantity}
                              disabled={modifyQuantityLocked}
                              title={modifyQuantityLocked ? "Quantity is locked for scale-out legs — entry, target, and stop must stay matched." : undefined}
                              onChange={(e) => setModifyForm((f) => ({ ...f, quantity: Number(e.target.value) }))}
                            />
                          </label>
                          {editableFields.includes("stop_price") && (
                            <label className="space-y-1.5">
                              <span className="text-xs font-medium text-[var(--text-2)]">Stop trigger</span>
                              <input
                                type="number" step="0.01"
                                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none transition-colors focus:border-[var(--clr-cyan)]"
                                placeholder="0.00"
                                value={modifyForm.stop_price ?? ""}
                                onChange={(e) => setModifyForm((f) => ({ ...f, stop_price: Number(e.target.value) || null }))}
                              />
                            </label>
                          )}
                          {editableFields.includes("limit_price") && (
                            <label className="space-y-1.5">
                              <span className="text-xs font-medium text-[var(--text-2)]">Limit price</span>
                              <input
                                type="number" step="0.01"
                                className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none transition-colors focus:border-[var(--clr-cyan)]"
                                placeholder="0.00"
                                value={modifyForm.limit_price ?? ""}
                                onChange={(e) => setModifyForm((f) => ({ ...f, limit_price: Number(e.target.value) || null }))}
                              />
                            </label>
                          )}
                        </>
                      ) : (
                        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                          <div className="space-y-0.5">
                            <div className="text-xs font-medium text-[var(--text-3)]">Quantity</div>
                            <div className="font-data text-sm text-[var(--text-2)] line-through">{editingOrder.quantity}</div>
                            <div className="font-data text-sm font-semibold text-[var(--text-1)]">{modifyForm.quantity}</div>
                          </div>
                          {editableFields.includes("stop_price") && (
                            <div className="space-y-0.5">
                              <div className="text-xs font-medium text-[var(--text-3)]">Stop trigger</div>
                              <div className="font-data text-sm text-[var(--text-2)] line-through">{editingOrder.stop_price?.toFixed(2) ?? "—"}</div>
                              <div className="font-data text-sm font-semibold text-[var(--text-1)]">{modifyForm.stop_price?.toFixed(2) ?? "—"}</div>
                            </div>
                          )}
                          {editableFields.includes("limit_price") && (
                            <div className="space-y-0.5">
                              <div className="text-xs font-medium text-[var(--text-3)]">Limit price</div>
                              <div className="font-data text-sm text-[var(--text-2)] line-through">{editingOrder.lmt_price?.toFixed(2) ?? "—"}</div>
                              <div className="font-data text-sm font-semibold text-[var(--text-1)]">{modifyForm.limit_price?.toFixed(2) ?? "—"}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 flex flex-col gap-3 pt-2">
                      {modifyOrderMutation.isError && (
                        <p className="text-xs text-[var(--clr-red)]">
                          {SUBMIT_ERROR_MESSAGES[submitErrorCode(modifyOrderMutation.error) ?? ""] ??
                            (isLiveSession
                              ? "Modify rejected — check that TWS is connected and live trading is armed."
                              : "Modify failed — check that TWS is connected and on a paper port.")}
                        </p>
                      )}
                      {!modifyReview ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            className="h-9 rounded-md border border-[var(--clr-cyan)] px-5 text-sm font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96] disabled:opacity-50"
                            disabled={!!reason}
                            onClick={() => { modifyOrderMutation.reset(); setModifyReview(true); }}
                          >
                            Review changes
                          </button>
                          <button
                            className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] hover:bg-[var(--bg-1)] hover:text-[var(--text-1)]"
                            onClick={() => { setEditingOrder(null); setModifyReview(false); modifyOrderMutation.reset(); }}
                          >
                            Cancel
                          </button>
                          {reason && <span className="text-xs text-[var(--text-3)]">{reason}</span>}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            className="h-9 rounded-md bg-[var(--clr-orange)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                            disabled={modifyOrderMutation.isPending}
                            onClick={() => modifyOrderMutation.mutate({ order_id: editingOrder.order_id, req: modifyForm })}
                          >
                            {modifyOrderMutation.isPending ? "Submitting..." : "Submit changes"}
                          </button>
                          <button
                            className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] hover:bg-[var(--bg-1)] hover:text-[var(--text-1)] disabled:opacity-50"
                            disabled={modifyOrderMutation.isPending}
                            onClick={() => setModifyReview(false)}
                          >
                            Back
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })() : paperSubmission != null ? (
                <div className="flex h-full flex-col">
                  {/* Top content — scrolls when taller than the panel */}
                  <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
                    {/* Hero band */}
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-[var(--clr-green)]/30 bg-[var(--bg-0)] px-4 py-4">
                      <span className="font-data text-2xl font-bold text-[var(--text-1)]">{paperSubmission.symbol}</span>
                      <span className={`font-data text-xl font-bold ${paperSubmission.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
                        {paperSubmission.side}
                      </span>
                      <span className="font-data text-xl font-semibold text-[var(--text-1)]">{paperSubmission.quantity}</span>
                      <span className="font-data text-xl font-semibold text-[var(--text-2)]">{paperSubmission.order_type}</span>
                      {paperSubmission.stop_price != null && (
                        <>
                          <span className="text-lg text-[var(--text-3)]">STP</span>
                          <span className="font-data text-2xl font-bold text-[var(--text-1)]">
                            {paperSubmission.stop_price.toFixed(2)}
                          </span>
                        </>
                      )}
                      {paperSubmission.limit_price != null && (
                        <>
                          <span className="text-lg text-[var(--text-3)]">@</span>
                          <span className="font-data text-2xl font-bold text-[var(--text-1)]">
                            {paperSubmission.limit_price.toFixed(2)}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Detail grid */}
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-[var(--text-3)]">Broker order ID</div>
                        <div className="font-data text-sm text-[var(--text-1)]">{paperSubmission.order_id}</div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-[var(--text-3)]">TWS status</div>
                        <div className="font-data text-sm font-semibold text-[var(--clr-green)]">{paperSubmission.status}</div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-[var(--text-3)]">Side</div>
                        <div className={`font-data text-sm font-semibold ${paperSubmission.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>{paperSubmission.side}</div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-[var(--text-3)]">Quantity</div>
                        <div className="font-data text-sm text-[var(--text-1)]">{paperSubmission.quantity}</div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-[var(--text-3)]">Order type</div>
                        <div className="font-data text-sm text-[var(--text-1)]">{paperSubmission.order_type}</div>
                      </div>
                      {paperSubmission.stop_price != null && (
                        <div className="space-y-0.5">
                          <div className="text-xs font-medium text-[var(--text-3)]">Stop trigger</div>
                          <div className="font-data text-sm text-[var(--text-1)]">{paperSubmission.stop_price.toFixed(2)}</div>
                        </div>
                      )}
                      {paperSubmission.limit_price != null && (
                        <div className="space-y-0.5">
                          <div className="text-xs font-medium text-[var(--text-3)]">Limit price</div>
                          <div className="font-data text-sm text-[var(--text-1)]">{paperSubmission.limit_price.toFixed(2)}</div>
                        </div>
                      )}
                    </div>

                    {/* Confirmation notice */}
                    <div className="flex items-start gap-3 rounded border border-[var(--clr-green)]/25 bg-[var(--glow-green)] px-4 py-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--clr-green)]" strokeWidth={1.7} />
                      <div>
                        <p className="text-xs font-semibold text-[var(--clr-green)]">Order sent to TWS paper account.</p>
                        <p className="mt-0.5 text-xs text-[var(--text-2)]">
                          Open Orders refreshes automatically. Use "Refresh Open Orders" to poll for fill status.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Bottom: actions — always visible */}
                  <div className="shrink-0 flex flex-wrap items-center gap-3 pt-2">
                    <button
                      className="h-9 rounded-md border border-[var(--clr-cyan)] px-5 text-sm font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96]"
                      onClick={() => { placeOrderMutation.reset(); setCurrentPlan(null); setPaperPreview(null); setPaperSubmission(null); setPlanForm(PLAN_DEFAULTS); }}
                    >
                      New order
                    </button>
                    <button
                      className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--bg-1)] hover:text-[var(--text-1)]"
                      onClick={() => queryClient.invalidateQueries({ queryKey: RECON_KEY })}
                    >
                      Refresh Open Orders
                    </button>
                  </div>
                </div>
              ) : paperPreview != null ? (
                <div className="flex h-full flex-col">
                  {/* Top content — scrolls when taller than the panel */}
                  <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
                    {/* Hero order summary */}
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-[var(--clr-cyan)]/20 bg-[var(--bg-0)] px-4 py-4">
                      <span className="font-data text-2xl font-bold text-[var(--text-1)]">{paperPreview.symbol}</span>
                      <span className={`font-data text-xl font-bold ${paperPreview.side === "BUY" ? "text-[var(--clr-green)]" : "text-[var(--clr-red)]"}`}>
                        {paperPreview.side}
                      </span>
                      <span className="font-data text-xl font-semibold text-[var(--text-1)]">{paperPreview.quantity}</span>
                      <span className="font-data text-xl font-semibold text-[var(--text-2)]">{paperPreview.order_type}</span>
                      {paperPreview.stop_price != null && (
                        <>
                          <span className="text-lg text-[var(--text-3)]">STP</span>
                          <span className="font-data text-2xl font-bold text-[var(--text-1)]">
                            {paperPreview.stop_price.toFixed(2)}
                          </span>
                        </>
                      )}
                      {paperPreview.limit_price != null && (
                        <>
                          <span className="text-lg text-[var(--text-3)]">@</span>
                          <span className="font-data text-2xl font-bold text-[var(--text-1)]">
                            {paperPreview.limit_price.toFixed(2)}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Detail grid */}
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                      {([
                        { label: "ConID", value: paperPreview.conid },
                        { label: "Side", value: paperPreview.side, tone: paperPreview.side === "BUY" ? "success" : "danger" },
                        { label: "Quantity", value: paperPreview.quantity },
                        { label: "Order type", value: paperPreview.order_type },
                        ...(paperPreview.stop_price != null ? [{ label: "Stop trigger", value: paperPreview.stop_price.toFixed(2) }] : []),
                        ...(paperPreview.limit_price != null ? [{ label: "Limit price", value: paperPreview.limit_price.toFixed(2) }] : []),
                        { label: "TIF", value: paperPreview.tif },
                      ] as { label: string; value: unknown; tone?: string }[]).map(({ label, value, tone }) => (
                        <div key={label} className="space-y-0.5">
                          <div className="text-xs font-medium text-[var(--text-3)]">{label}</div>
                          <div className={cn(
                            "font-data text-sm",
                            tone === "success" && "font-semibold text-[var(--clr-green)]",
                            tone === "danger" && "font-semibold text-[var(--clr-red)]",
                            !tone && "text-[var(--text-1)]",
                          )}>{String(value)}</div>
                        </div>
                      ))}
                    </div>

                    {/* Notional */}
                    {paperPreview.limit_price != null && (
                      <div className="flex items-center justify-between rounded border border-border/50 bg-[var(--bg-0)] px-4 py-3">
                        <span className="text-xs text-[var(--text-3)]">
                          {paperPreview.quantity} × {paperPreview.limit_price.toFixed(2)}
                        </span>
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Notional</div>
                          <div className="font-data text-base font-semibold text-[var(--text-1)]">
                            ${(paperPreview.quantity * paperPreview.limit_price).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Safety notice */}
                    <div className={cn("flex items-start gap-3 rounded px-4 py-3", isLiveSession ? "border border-[var(--clr-red)]/25 bg-[var(--clr-red)]/5" : "border border-[var(--clr-green)]/25 bg-[var(--glow-green)]")}>
                      <CheckCircle2 className={cn("mt-0.5 h-4 w-4 shrink-0", isLiveSession ? "text-[var(--clr-red)]" : "text-[var(--clr-green)]")} strokeWidth={1.7} />
                      <div>
                        <p className={cn("text-xs font-semibold", isLiveSession ? "text-[var(--clr-red)]" : "text-[var(--clr-green)]")}>
                          {isLiveSession ? "This is a LIVE order." : "This is a PAPER order only."}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--text-2)]">
                          {isLiveSession
                            ? "It will be routed to the armed live TWS account."
                            : "It will be routed to your TWS paper account and will not impact live trading."}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Bottom: errors + actions — always visible */}
                  <div className="shrink-0 flex flex-col gap-3 pt-2">
                    {placeOrderMutation.isError && (() => {
                      const code = submitErrorCode(placeOrderMutation.error);
                      if (code === "unknown_outcome") {
                        return (
                          <div className="rounded border border-[var(--clr-amber,#d97706)]/40 bg-[var(--bg-0)] p-3 space-y-1.5">
                            <p className="text-xs font-semibold text-[var(--clr-amber,#d97706)]">
                              Outcome unknown — do not retry yet.
                            </p>
                            <p className="text-xs text-[var(--text-2)]">
                              The order may have reached TWS. Check Open Orders below before retrying to avoid a duplicate position.
                            </p>
                            <button
                              className="h-7 rounded border border-border px-2.5 text-[11px] text-[var(--text-2)] hover:bg-[var(--bg-1)]"
                              onClick={() => queryClient.invalidateQueries({ queryKey: RECON_KEY })}
                            >
                              Refresh Open Orders
                            </button>
                          </div>
                        );
                      }
                      const msg = SUBMIT_ERROR_MESSAGES[code ?? ""] ??
                        (isLiveSession
                          ? "Live order rejected — check that TWS is connected and live trading is armed."
                          : "Order rejected — check that TWS is connected and on a paper port.");
                      return <p className="text-xs text-[var(--clr-red)]">{msg}</p>;
                    })()}
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className="h-9 rounded-md bg-[var(--clr-green)] px-5 text-sm font-semibold text-[var(--bg-0)] transition-colors hover:opacity-90 active:scale-[0.96] disabled:opacity-50"
                        disabled={placeOrderMutation.isPending}
                        onClick={() => placeOrderMutation.mutate(paperPreview.plan_id)}
                      >
                        {placeOrderMutation.isPending ? "Placing order..." : "Place order"}
                      </button>
                      <button
                        className="h-9 rounded-md border border-border px-4 text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--bg-1)] hover:text-[var(--text-1)] disabled:opacity-50"
                        disabled={placeOrderMutation.isPending}
                        onClick={() => { placeOrderMutation.reset(); setCurrentPlan(null); setPaperPreview(null); setPaperSubmission(null); }}
                      >
                        Edit ticket
                      </button>
                    </div>
                  </div>

                </div>
              ) : planMode === "scale_out" ? (
                <ScaleOutLadderPanel
                  canDraft={canDraft}
                  isLiveSession={isLiveSession}
                  connected={status?.connected === true}
                  initialConid={planForm.conid}
                  initialSymbol={planForm.symbol}
                  onInstrumentResolved={(instrument) => {
                    setPlanForm((f) => ({ ...f, symbol: instrument.symbol, conid: instrument.conid, limit_price: null, stop_price: null }));
                    setSelectedExchange(instrument.primary_exchange);
                    setSelectedCompanyName(instrument.company_name);
                  }}
                  onChartLines={handlePanelChartLines}
                  onReviewLocked={handlePanelReviewLocked}
                />
              ) : planMode === "bracket" ? (
                <BracketBuilderPanel
                  canDraft={canDraft}
                  isLiveSession={isLiveSession}
                  connected={status?.connected === true}
                  initialConid={planForm.conid}
                  initialSymbol={planForm.symbol}
                  onInstrumentResolved={(instrument) => {
                    setPlanForm((f) => ({ ...f, symbol: instrument.symbol, conid: instrument.conid, limit_price: null, stop_price: null }));
                    setSelectedExchange(instrument.primary_exchange);
                    setSelectedCompanyName(instrument.company_name);
                  }}
                  onChartLines={handlePanelChartLines}
                  onReviewLocked={handlePanelReviewLocked}
                />
              ) : planMode === "advanced" ? (
                <AdvancedOrderPanel
                  canDraft={canDraft}
                  isLiveSession={isLiveSession}
                  connected={status?.connected === true}
                  initialConid={planForm.conid}
                  initialSymbol={planForm.symbol}
                  onInstrumentResolved={(instrument) => {
                    setPlanForm((f) => ({ ...f, symbol: instrument.symbol, conid: instrument.conid, limit_price: null, stop_price: null }));
                    setSelectedExchange(instrument.primary_exchange);
                    setSelectedCompanyName(instrument.company_name);
                  }}
                  onReviewLocked={handlePanelReviewLocked}
                />
              ) : (
                <div className="relative flex h-full flex-col">
                  <div className={cn("flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2", !canDraft && "opacity-45")}>
                    {/* Row 1: Symbol (hero) · ConID · Side */}
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-[var(--text-2)]">Symbol</span>
                        <div className="relative">
                          <input
                            className="h-11 w-full rounded border border-border bg-[var(--bg-0)] px-3 pr-9 text-sm font-semibold uppercase outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                            placeholder="e.g. NVDA"
                            value={planForm.symbol}
                            disabled={!canDraft}
                            onChange={(e) => handleSymbolChange(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && runSearch()}
                          />
                          <button
                            type="button"
                            className="absolute right-2.5 top-3 text-[var(--text-3)] hover:text-[var(--clr-cyan)] disabled:cursor-not-allowed"
                            disabled={!canDraft || !planForm.symbol || searchMutation.isPending}
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
                                  onClick={() => {
                                    setPlanForm((f) => ({ ...f, conid: r.conid, limit_price: null, stop_price: null }));
                                    setSelectedExchange(r.primary_exchange || r.exchange);
                                    setSelectedCompanyName(r.company_name);
                                    setSearchResults([]);
                                  }}
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
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-[var(--text-2)]">ConID</span>
                        <input
                          type="number"
                          className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                          placeholder="Search symbol to resolve"
                          value={planForm.conid || ""}
                          disabled={!canDraft}
                          onChange={(e) => setPlanForm((f) => ({ ...f, conid: Number(e.target.value) }))}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-[var(--text-2)]">Side</span>
                        <select
                          className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                          value={planForm.side}
                          disabled={!canDraft}
                          onChange={(e) => setPlanForm((f) => ({ ...f, side: e.target.value as ExecutionPlanSide }))}
                        >
                          <option value="BUY">BUY</option>
                          <option value="SELL">SELL</option>
                        </select>
                      </label>
                    </div>

                    {/* Row 2: Quantity · Order type · Limit price (hero) */}
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-[var(--text-2)]">Quantity</span>
                        <input
                          type="number"
                          className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                          value={planForm.quantity}
                          disabled={!canDraft}
                          onChange={(e) => setPlanForm((f) => ({ ...f, quantity: Number(e.target.value) }))}
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-xs font-medium text-[var(--text-2)]">Order type</span>
                        <select
                          className="h-9 w-full rounded border border-border bg-[var(--bg-0)] px-3 text-sm outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                          value={planForm.order_type}
                          disabled={!canDraft}
                          onChange={(e) => setPlanForm((f) => ({ ...f, order_type: e.target.value as ExecutionPlanOrderType, limit_price: null, stop_price: null }))}
                        >
                          {(Object.keys(TWS_ORDER_CAPABILITIES) as ExecutionPlanOrderType[]).map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </label>
                      {priceFieldsFor(planForm.order_type).includes("stop_price") && (
                        <label className="space-y-1.5">
                          <span className="text-xs font-medium text-[var(--text-2)]">Stop trigger</span>
                          <input
                            type="number"
                            step="0.01"
                            className="h-11 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm font-semibold outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                            placeholder="0.00"
                            value={planForm.stop_price ?? ""}
                            disabled={!canDraft}
                            onChange={(e) => setPlanForm((f) => ({ ...f, stop_price: Number(e.target.value) || null }))}
                          />
                        </label>
                      )}
                      {priceFieldsFor(planForm.order_type).includes("limit_price") && (
                        <label className="space-y-1.5">
                          <span className="text-xs font-medium text-[var(--text-2)]">Limit price</span>
                          <input
                            type="number"
                            step="0.01"
                            className="h-11 w-full rounded border border-border bg-[var(--bg-0)] px-3 font-data text-sm font-semibold outline-none transition-colors focus:border-[var(--clr-cyan)] disabled:cursor-not-allowed"
                            placeholder="0.00"
                            value={planForm.limit_price ?? ""}
                            disabled={!canDraft}
                            onChange={(e) => setPlanForm((f) => ({ ...f, limit_price: Number(e.target.value) || null }))}
                          />
                        </label>
                      )}
                    </div>

                    {/* Notional value */}
                    {planForm.limit_price != null && planForm.limit_price > 0 && planForm.quantity > 0 && (
                      <div className="flex items-center justify-between rounded border border-border/50 bg-[var(--bg-0)] px-4 py-3">
                        <span className="text-xs text-[var(--text-3)]">
                          {planForm.quantity} × {planForm.limit_price.toFixed(2)}
                        </span>
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Notional</div>
                          <div className="font-data text-base font-semibold text-[var(--text-1)]">
                            ${(planForm.quantity * planForm.limit_price).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    )}

                  </div>

                  {/* Bottom: errors + action — always visible */}
                  <div className="shrink-0 flex flex-col gap-3 pt-2">
                    {currentPlan?.status === "invalid" && currentPlan.validation_errors.length > 0 && (
                      <ul className="space-y-1">
                        {currentPlan.validation_errors.map((e, i) => (
                          <li key={i} className="text-xs text-[var(--clr-red)]">- {e}</li>
                        ))}
                      </ul>
                    )}
                    {reviewMutation.isError && currentPlan?.status !== "invalid" && (
                      <p className="text-xs text-[var(--clr-red)]">
                        {SUBMIT_ERROR_MESSAGES[submitErrorCode(reviewMutation.error) ?? ""] ??
                          "Review failed — check that TWS is connected and on a paper port."}
                      </p>
                    )}
                    {(() => {
                      const reason = saveDraftDisabledReason();
                      return (
                        <div className="flex items-center gap-3">
                          <button
                            className="h-9 rounded-md border border-[var(--clr-cyan)] px-4 text-sm font-semibold text-[var(--clr-cyan)] transition-colors hover:bg-[var(--clr-cyan)]/10 active:scale-[0.96] disabled:opacity-50"
                            disabled={!canDraft || reviewMutation.isPending || reason != null}
                            onClick={() => { placeOrderMutation.reset(); reviewMutation.mutate(planForm); }}
                          >
                            {reviewMutation.isPending ? "Reviewing..." : "Review order"}
                          </button>
                          {canDraft && reason != null && (
                            <span className="text-xs text-[var(--text-3)]">{reason}</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {!canDraft && (
                    <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--clr-orange)]/40 bg-[var(--glow-orange)] text-[var(--clr-orange)]">
                        <LockKeyhole className="h-5 w-5" strokeWidth={1.6} />
                      </div>
                      <div>
                        <div className="text-[14px] font-semibold text-[var(--clr-orange)]">
                          Connect and reconcile before drafting
                        </div>
                        <p className="mt-0.5 max-w-md text-[11px] leading-4 text-[var(--text-2)]">
                          You must connect to TWS / IB Gateway and load reconciliation before creating or reviewing a plan.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          <aside className="h-[480px]">
            <section className="flex h-full min-w-0 flex-col rounded-md border border-border bg-[var(--bg-1)] shadow-sm">
              <div className="shrink-0 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <h2 className="max-w-[45%] shrink-0 truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--clr-cyan)]">
                    {selectedCompanyName || planForm.symbol || "Chart"}
                  </h2>
                  <div className="min-w-0 flex-1">
                    <EntitlementGuidanceNote key={planForm.conid} reason={entitlementGuidanceReason} exchange={selectedExchange} />
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <div className="mr-1.5 flex items-center gap-1">
                      <span className="text-[9px] text-[var(--text-3)]">Lines</span>
                      <ToggleSwitch
                        checked={showPlanLines}
                        onChange={() => setShowPlanLines((v) => !v)}
                        title="Show plan prices as draggable lines on the chart"
                      />
                    </div>
                    {TWS_TIMEFRAMES.map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setActiveTimeframe(tf)}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[9px] transition-colors",
                          activeTimeframe === tf
                            ? "bg-[var(--glow-cyan)] font-semibold text-[var(--clr-cyan)]"
                            : "text-[var(--text-3)] hover:text-[var(--text-2)]",
                        )}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>
                {panelLinesMismatch && (
                  <p className="mt-1 text-[9px] text-[var(--text-3)]">
                    Plan lines hidden — the builder&apos;s symbol differs from the charted symbol.
                  </p>
                )}
                {editingLinesMismatch && (
                  <p className="mt-1 text-[9px] text-[var(--text-3)]">
                    Plan lines hidden — the order being modified is a different symbol than the charted one.
                  </p>
                )}
              </div>
              {planForm.conid > 0 && connected && (
                <QuoteStrip quote={displayedQuote} exchange={selectedExchange} loading={quoteLoading} />
              )}
              <div className="flex flex-1 gap-2 p-3">
                <div className="flex flex-1 overflow-hidden rounded border border-border/60 bg-[var(--bg-0)]">
                  {barsLoading ? (
                    <div className="flex h-full w-full items-center justify-center text-[11px] text-[var(--text-3)] animate-pulse">
                      Loading bars…
                    </div>
                  ) : barsData && barsData.bars.length > 0 ? (
                    <TwsCandleChart bars={barsData.bars} liveBar={liveBar} planLines={chartLines} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-center">
                      <div>
                        <div className="text-[12px] font-medium text-[var(--text-2)]">Chart unavailable</div>
                        <p className="mt-1 text-[11px] text-[var(--text-3)]">
                          {planForm.conid > 0 ? "No bars returned for this symbol." : "Select a symbol to load chart."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                {planForm.conid > 0 && connected && (
                  <div className="w-36 shrink-0 overflow-hidden rounded border border-border/60 bg-[var(--bg-0)] p-2">
                    <DepthPanel depth={depth} />
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>

        <div className="mt-4 grid gap-1.5 md:grid-cols-2">
          <Panel title="Positions">
            {recon && recon.positions.length > 0 ? (
              <div className="max-h-[160px] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-xs text-[var(--text-3)]">
                    <th className="pb-1.5 pr-4 font-medium">Symbol</th>
                    <th className="pb-1.5 pr-4 font-medium">ConID</th>
                    <th className="pb-1.5 pr-4 font-medium">Position</th>
                    <th className="pb-1.5 font-medium">Avg Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.positions.map((p) => (
                    <tr key={p.conid} className="border-t border-border">
                      <td className="py-1.5 pr-4 font-medium">{p.symbol}</td>
                      <td className="pr-4 font-data text-[var(--text-2)]">{p.conid}</td>
                      <td className={`pr-4 font-data ${p.position < 0 ? "text-[var(--clr-red)]" : ""}`}>
                        {p.position}
                      </td>
                      <td className="font-data text-[var(--text-2)]">{p.avg_cost.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <EmptyTableState label="No positions" />
            )}
          </Panel>

          <Panel title="Open Orders">
            {recon && recon.open_orders.length > 0 ? (
              <div className="max-h-[160px] overflow-y-auto">
                {recon.unmanaged_order_count > 0 && (
                  <p className="mb-2 text-xs text-[var(--clr-orange)]">
                    {recon.unmanaged_order_count} unmanaged
                  </p>
                )}
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
                    {scaleOutPackages.map((pkg) => (
                      <ScaleOutPackageRows
                        key={pkg.packageId}
                        pkg={pkg}
                        onManage={() => {
                          setAdvancedReject(null);
                          setEditingOrder(null);
                          setManagedBracketPackageId(null);
                          setManagedScaleOutPackageId(pkg.packageId);
                        }}
                      />
                    ))}
                    {bracketPackages.map((pkg) => (
                      <BracketPackageRows
                        key={pkg.packageId}
                        pkg={pkg}
                        onManage={() => {
                          setAdvancedReject(null);
                          setEditingOrder(null);
                          setManagedScaleOutPackageId(null);
                          setManagedBracketPackageId(pkg.packageId);
                        }}
                      />
                    ))}
                    {standaloneOrders.map((o) => (
                      <OrderRow
                        key={o.order_id}
                        order={o}
                        warnings={recon.package_warnings}
                        onCancel={(id) => cancelOrderMutation.mutate(id)}
                        onModify={focusOrderForModify}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyTableState label="No open orders" />
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}
