import { Search } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { InstrumentResult } from "./api";

export type ExecutionPlanFlowMode = "standard" | "scale_out" | "bracket" | "advanced";

const MODE_ACCENTS: Record<ExecutionPlanFlowMode, {
  border: string;
  glow: string;
  text: string;
  fill: string;
  focus: string;
  buttonText: string;
}> = {
  standard: {
    border: "border-[var(--clr-cyan)]/30",
    glow: "bg-[var(--glow-cyan)]",
    text: "text-[var(--clr-cyan)]",
    fill: "bg-[var(--clr-cyan)]",
    focus: "focus:border-[var(--clr-cyan)]",
    buttonText: "text-[#031018]",
  },
  scale_out: {
    border: "border-[var(--clr-purple)]/30",
    glow: "bg-[var(--glow-purple)]",
    text: "text-[var(--clr-purple)]",
    fill: "bg-[var(--clr-purple)]",
    focus: "focus:border-[var(--clr-purple)]",
    buttonText: "text-white",
  },
  bracket: {
    border: "border-[var(--clr-orange)]/30",
    glow: "bg-[var(--glow-orange)]",
    text: "text-[var(--clr-orange)]",
    fill: "bg-[var(--clr-orange)]",
    focus: "focus:border-[var(--clr-orange)]",
    buttonText: "text-[#160d02]",
  },
  advanced: {
    border: "border-[var(--clr-blue)]/30",
    glow: "bg-[var(--glow-blue)]",
    text: "text-[var(--clr-blue)]",
    fill: "bg-[var(--clr-blue)]",
    focus: "focus:border-[var(--clr-blue)]",
    buttonText: "text-white",
  },
};

export function flowModeAccent(mode: ExecutionPlanFlowMode) {
  return MODE_ACCENTS[mode];
}

export function FlowSheet({ mode, children }: { mode: ExecutionPlanFlowMode; children: ReactNode }): JSX.Element {
  const accent = MODE_ACCENTS[mode];
  return (
    <section className="relative rounded-xl border border-border bg-[var(--bg-1)] shadow-sm">
      <div className={cn("absolute inset-y-0 left-0 w-1", accent.fill)} />
      <div className="relative">{children}</div>
    </section>
  );
}

export function FlowRow({ children, className, id }: { children: ReactNode; className?: string; id?: string }): JSX.Element {
  return (
    <div
      id={id}
      className={cn("border-b border-border/70 px-4 py-3 last:border-b-0 sm:px-5", className)}
    >
      {children}
    </div>
  );
}

export function FlowField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">{label}</span>
      {children}
    </label>
  );
}

export function FlowValueInput(
  props: InputHTMLAttributes<HTMLInputElement> & { prefix?: string; suffix?: string },
): JSX.Element {
  const { prefix, suffix, className, ...inputProps } = props;
  return (
    <div className="flex h-9 items-center gap-1.5 border-b border-border/90 pb-1">
      {prefix && <span className="shrink-0 font-data text-[13px] text-[var(--text-3)]">{prefix}</span>}
      <input
        {...inputProps}
        className={cn(
          "min-w-0 flex-1 appearance-none bg-transparent font-data text-[15px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-4)] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          className,
        )}
      />
      {suffix && <span className="shrink-0 font-data text-[11px] text-[var(--text-3)]">{suffix}</span>}
    </div>
  );
}

export function FlowSegmented<T extends string>(props: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  getLabel?: (value: T) => string;
  compact?: boolean;
  className?: string;
}): JSX.Element {
  const { value, options, onChange, getLabel, compact = false, className } = props;
  return (
    <div className={cn(
      "group/segmented flex flex-wrap gap-1 rounded-full border border-border/80 bg-[var(--bg-0)] p-1",
      compact && "mx-auto w-[70%] justify-center",
      className,
    )}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-[background-color,color,box-shadow,transform] duration-150 ease-out enabled:cursor-pointer active:scale-[0.96]",
              active
                ? "bg-[var(--bg-3)] text-[var(--text-1)] shadow-sm group-hover/segmented:bg-transparent group-hover/segmented:text-[var(--text-3)] hover:bg-[var(--bg-3)] hover:text-[var(--text-1)]"
                : "text-[var(--text-3)] hover:bg-[var(--bg-2)] hover:text-[var(--text-1)]",
            )}
            onClick={() => onChange(option)}
          >
            {getLabel ? getLabel(option) : option}
          </button>
        );
      })}
    </div>
  );
}

export function FlowGuidance({ children }: { children: ReactNode }): JSX.Element {
  return <p className="w-full text-[12px] leading-5 text-[var(--text-2)]">{children}</p>;
}

export function FlowSummary({ notional, children }: { notional: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">Estimated notional</div>
        <div className="mt-1 font-data text-[26px] font-semibold tabular-nums text-[var(--text-1)]">{notional}</div>
      </div>
      {children}
    </div>
  );
}

export function FlowActionButton({
  mode,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  mode: ExecutionPlanFlowMode;
}): JSX.Element {
  const accent = MODE_ACCENTS[mode];
  return (
    <button
      {...props}
      className={cn(
        "h-10 rounded-full px-4 text-[12px] font-semibold transition-[background-color,box-shadow,transform,opacity] duration-150 ease-out enabled:cursor-pointer hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-[var(--bg-2)] disabled:text-[var(--text-4)]",
        accent.fill,
        accent.buttonText,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FlowStatusBadge({
  mode,
  children,
}: {
  mode: ExecutionPlanFlowMode;
  children: ReactNode;
}): JSX.Element {
  const accent = MODE_ACCENTS[mode];
  return (
    <span className={cn("inline-flex rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]", accent.border, accent.glow, accent.text)}>
      {children}
    </span>
  );
}

export function FlowSymbolSearchRow({
  mode,
  symbol,
  placeholder,
  conid,
  companyName,
  exchange,
  currency = "USD",
  disabled,
  searchPending,
  onSymbolChange,
  onSearch,
  searchResults,
  onResolve,
  badge,
}: {
  mode: ExecutionPlanFlowMode;
  symbol: string;
  placeholder: string;
  conid: number;
  companyName?: string;
  exchange?: string;
  currency?: string;
  disabled: boolean;
  searchPending: boolean;
  onSymbolChange: (value: string) => void;
  onSearch: () => void;
  searchResults: InstrumentResult[];
  onResolve: (instrument: InstrumentResult) => void;
  badge?: ReactNode;
}): JSX.Element {
  const accent = MODE_ACCENTS[mode];
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <FlowField label="Ticker">
              <div className="flex items-center gap-2 border-b border-border/90 pb-1">
                <div className="relative min-w-0 flex-1">
                  {!symbol && (
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center text-[15px] font-medium uppercase tracking-[0.1em] text-[var(--text-3)] opacity-55">
                      {placeholder}
                    </span>
                  )}
                  <input
                    className={cn(
                      "min-w-0 w-full bg-transparent text-[28px] font-semibold uppercase tracking-[-0.03em] text-[var(--text-1)] outline-none disabled:cursor-not-allowed",
                      accent.focus,
                    )}
                    placeholder=""
                    value={symbol}
                    disabled={disabled}
                    onChange={(event) => onSymbolChange(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && onSearch()}
                  />
                </div>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[11px] font-semibold transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-0)] hover:shadow-sm active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45",
                    accent.border,
                    accent.text,
                  )}
                  disabled={disabled || !symbol || searchPending}
                  onClick={onSearch}
                >
                  <Search className="h-3.5 w-3.5" strokeWidth={1.9} />
                  Find
                </button>
              </div>
            </FlowField>
          </div>
          {badge}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-3)]">
          <span className="text-[var(--text-2)]">{companyName || symbol || "Search symbol"}</span>
          <span>•</span>
          <span>{exchange || "SMART"}</span>
          <span>•</span>
          <span>{currency}</span>
          <span>•</span>
          <span className="font-data uppercase">conid {conid || "resolve"}</span>
        </div>
        {searchResults.length > 1 && (
          <ul className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-[var(--bg-0)]">
            {searchResults.map((result) => (
              <li key={result.conid} className="border-b border-border/60 last:border-b-0">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] text-[var(--text-2)] transition-colors duration-150 ease-out enabled:cursor-pointer hover:bg-[var(--bg-1)]"
                  onClick={() => onResolve(result)}
                >
                  <span className="font-semibold text-[var(--text-1)]">{result.symbol}</span>
                  <span className="truncate text-[var(--text-3)]">
                    {result.company_name || result.sec_type} • {result.primary_exchange || result.exchange} • {result.currency}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
