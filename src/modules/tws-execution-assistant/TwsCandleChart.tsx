import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type HistogramData,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { readChartTheme } from "@/components/charts/chartTheme";
import type { BarSnapshot } from "./api";

const VOL_UP   = "rgba(0, 255, 136, 0.18)";
const VOL_DOWN = "rgba(255, 68, 102, 0.18)";

export interface PlanChartLine {
  id: string;                         // stable per source field, e.g. "plan-limit", "ladder-t0"
  price: number;                      // already rounded to 0.01 by the source
  kind: "entry" | "target" | "stop";  // entry=#00d4ff, target=theme.upColor, stop=theme.downColor
  label: string;                      // axis label: "Entry", "T1", "S1", "Target", "Stop"
  onDrag: (price: number) => void;    // pushes a dragged price back into the source form state
}

export function TwsCandleChart({ bars, liveBar, planLines }: {
  bars: BarSnapshot[];
  liveBar?: BarSnapshot | null;
  planLines?: PlanChartLine[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef    = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<Map<string, { line: IPriceLine; price: number }>>(new Map());
  const planLinesRef  = useRef<PlanChartLine[]>([]);
  const draggingIdRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const theme = readChartTheme();
    const CROSSHAIR = "rgba(0, 212, 255, 0.35)";

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.gridLines },
        horzLines: { color: theme.gridLines },
      },
      timeScale: { borderColor: theme.borderColor, timeVisible: true },
      rightPriceScale: { borderColor: theme.borderColor },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: CROSSHAIR, style: LineStyle.Dashed, labelBackgroundColor: "#0f1724" },
        horzLine: { color: CROSSHAIR, style: LineStyle.Dashed, labelBackgroundColor: "#0f1724" },
      },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: theme.upColor,
      downColor: theme.downColor,
      borderUpColor: theme.upColor,
      borderDownColor: theme.downColor,
      wickUpColor: theme.upColor,
      wickDownColor: theme.downColor,
    });

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current  = chart;
    candleRef.current = candle;
    volRef.current    = vol;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = candleRef.current = volRef.current = null;
      priceLinesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const candle = candleRef.current;
    const vol    = volRef.current;
    if (!candle || !vol) return;

    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.time as Time,
      open: b.open, high: b.high, low: b.low, close: b.close,
    }));
    const volData: HistogramData<Time>[] = bars.map((b) => ({
      time: b.time as Time,
      value: b.volume,
      color: b.close >= b.open ? VOL_UP : VOL_DOWN,
    }));

    candle.setData(candleData);
    vol.setData(volData);
    if (candleData.length > 0) chartRef.current?.timeScale().fitContent();
  }, [bars]);

  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    if (!candle || !vol || !liveBar) return;

    // Live ticks can race a symbol/timeframe switch that just reset the
    // series — skip a patch older than what's already plotted so
    // lightweight-charts never sees an out-of-order update() call.
    const lastPlotted = bars[bars.length - 1];
    if (lastPlotted && liveBar.time < lastPlotted.time) return;

    candle.update({
      time: liveBar.time as Time,
      open: liveBar.open, high: liveBar.high, low: liveBar.low, close: liveBar.close,
    });
    vol.update({
      time: liveBar.time as Time,
      value: liveBar.volume,
      color: liveBar.close >= liveBar.open ? VOL_UP : VOL_DOWN,
    });
  }, [liveBar, bars]);

  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;
    const lines = planLines ?? [];
    planLinesRef.current = lines;
    const theme = readChartTheme();
    const colorFor = (kind: PlanChartLine["kind"]) =>
      kind === "target" ? theme.upColor : kind === "stop" ? theme.downColor : "#00d4ff";

    const held = priceLinesRef.current;
    const seen = new Set<string>();
    for (const spec of lines) {
      seen.add(spec.id);
      const entry = held.get(spec.id);
      if (!entry) {
        held.set(spec.id, {
          price: spec.price,
          line: candle.createPriceLine({
            price: spec.price,
            color: colorFor(spec.kind),
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: spec.label,
          }),
        });
      } else if (entry.price !== spec.price && draggingIdRef.current !== spec.id) {
        // draggingIdRef guard: while a drag is in flight, a stale prop echo of the
        // previous rAF commit must not snap the line back a frame (Task 2).
        entry.line.applyOptions({ price: spec.price });
        entry.price = spec.price;
      }
    }
    for (const [id, entry] of held) {
      if (!seen.has(id)) {
        candle.removePriceLine(entry.line);
        held.delete(id);
      }
    }
  }, [planLines]);

  return <div ref={containerRef} className="h-full w-full" />;
}
