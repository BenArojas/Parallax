import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { readChartTheme } from "@/components/charts/chartTheme";
import type { BarSnapshot } from "./api";

const VOL_UP   = "rgba(0, 255, 136, 0.18)";
const VOL_DOWN = "rgba(255, 68, 102, 0.18)";

export function TwsCandleChart({ bars, liveBar }: { bars: BarSnapshot[]; liveBar?: BarSnapshot | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef    = useRef<ISeriesApi<"Histogram"> | null>(null);

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

  return <div ref={containerRef} className="h-full w-full" />;
}
