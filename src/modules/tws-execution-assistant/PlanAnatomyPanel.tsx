import { cn } from "@/lib/utils";

export type PlanAnatomyTone = "cyan" | "green" | "red" | "orange" | "purple" | "blue";

export interface PlanAnatomyStep {
  tone: PlanAnatomyTone;
  label: string;
  title: string;
  detail: string;
  metaLabel?: string;
  metaValue?: string;
}

export interface PlanAnatomyEffect {
  label: string;
  value: string;
  detail: string;
  tone?: PlanAnatomyTone;
}

export interface PlanAnatomyPanelProps {
  title: string;
  subtitle: string;
  badge: string;
  steps: PlanAnatomyStep[];
  effects: PlanAnatomyEffect[];
}

const toneClass: Record<PlanAnatomyTone, string> = {
  cyan: "border-[var(--clr-cyan)]/45 bg-[var(--glow-cyan)] text-[var(--clr-cyan)]",
  green: "border-[var(--clr-green)]/45 bg-[var(--glow-green)] text-[var(--clr-green)]",
  red: "border-[var(--clr-red)]/45 bg-[var(--glow-red)] text-[var(--clr-red)]",
  orange: "border-[var(--clr-orange)]/45 bg-[var(--glow-orange)] text-[var(--clr-orange)]",
  purple: "border-[var(--clr-purple)]/45 bg-[var(--glow-purple)] text-[var(--clr-purple)]",
  blue: "border-[var(--clr-blue)]/45 bg-[var(--glow-blue)] text-[var(--clr-blue)]",
};

const toneTextClass: Record<PlanAnatomyTone, string> = {
  cyan: "text-[var(--clr-cyan)]",
  green: "text-[var(--clr-green)]",
  red: "text-[var(--clr-red)]",
  orange: "text-[var(--clr-orange)]",
  purple: "text-[var(--clr-purple)]",
  blue: "text-[var(--clr-blue)]",
};

export function PlanAnatomyPanel({ title, subtitle, badge, steps, effects }: PlanAnatomyPanelProps) {
  return (
    <section className="rounded border border-border/70 bg-[var(--bg-0)]/55 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-[var(--text-1)]">{title}</h3>
          <p className="mt-1 max-w-[62ch] text-[11px] leading-4 text-[var(--text-3)]">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--clr-orange)]/35 bg-[var(--glow-orange)] px-2 py-0.5 text-[10px] font-semibold text-[var(--clr-orange)]">
          {badge}
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        {steps.map((step) => (
          <div
            key={step.label}
            className="grid grid-cols-[2.7rem_minmax(0,1fr)_auto] items-center gap-2 rounded border border-border/55 bg-[var(--bg-1)]/80 px-2.5 py-2"
          >
            <div className={cn("flex h-8 w-8 items-center justify-center rounded border font-data text-[9px] font-bold", toneClass[step.tone])}>
              {step.label}
            </div>
            <div className="min-w-0">
              <div className="truncate font-data text-[11px] font-semibold text-[var(--text-1)]">{step.title}</div>
              <p className="mt-0.5 text-[10px] leading-4 text-[var(--text-3)]">{step.detail}</p>
            </div>
            {step.metaLabel && step.metaValue && (
              <div className="hidden min-w-20 text-right sm:block">
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{step.metaLabel}</div>
                <div className="mt-0.5 font-data text-[10px] font-semibold text-[var(--text-2)]">{step.metaValue}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {effects.map((effect) => (
          <div key={effect.label} className="rounded border border-border/55 bg-[var(--bg-1)]/65 px-2.5 py-2">
            <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{effect.label}</div>
            <div
              className={cn(
                "mt-1 font-data text-[11px] font-semibold",
                effect.tone ? toneTextClass[effect.tone] : "text-[var(--text-1)]",
              )}
            >
              {effect.value}
            </div>
            <p className="mt-0.5 text-[10px] leading-4 text-[var(--text-3)]">{effect.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
