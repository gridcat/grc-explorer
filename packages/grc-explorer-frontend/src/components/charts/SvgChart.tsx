import { Box, useTheme } from '@mui/material';
import {
  ReactNode, useEffect, useMemo, useRef, useState,
} from 'react';
import { useFlipNearRightEdge } from './useFlipNearRightEdge';

/**
 * Inline-SVG chart primitives. Replaces recharts for the dashboard's
 * high-traffic panels.
 *
 * Why bother:
 * - Recharts mounts a ResizeObserver per <ResponsiveContainer> and a
 *   deep component tree (60+ props per Cell/Line). With 4-5 panels live
 *   on the dashboard, the cumulative re-render cost on every SSE tick
 *   was pegging the main thread.
 * - These primitives render a single <svg> per chart with hand-rolled
 *   scales, no observers, no inline styles per cell. A 145-point area
 *   chart becomes 3 <path> elements — essentially free.
 * - Tooltips are implemented as a single absolutely-positioned <div> on
 *   the parent, fed by mousemove on the SVG. One event handler, one
 *   element, no recharts-style event-bus tree.
 */

const DEFAULT_HEIGHT = 240;

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_MARGIN: ChartMargin = {
  top: 12, right: 12, bottom: 28, left: 44,
};

export interface ChartFrame {
  width: number;
  height: number;
  margin: ChartMargin;
  innerWidth: number;
  innerHeight: number;
}

/**
 * Wraps an SVG with measured-width responsiveness via ResizeObserver,
 * but exactly *one* ResizeObserver per chart, and only on the host
 * <Box> — no observer per inner element like recharts does. The SVG
 * itself uses width="100%" with a viewBox so most resizes don't need
 * a re-render anyway; we measure only to compute correct tick spacing.
 */
export function ChartFrameProvider({
  height = DEFAULT_HEIGHT,
  margin = DEFAULT_MARGIN,
  children,
}: {
  height?: number;
  margin?: ChartMargin;
  children: (frame: ChartFrame) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Sensible default so the first paint isn't a 0-width SVG. Real
  // measurement replaces it on the next tick.
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth);
      return undefined;
    }
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      if (w > 0) setWidth(Math.floor(w));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const frame: ChartFrame = {
    width,
    height,
    margin,
    innerWidth: Math.max(0, width - margin.left - margin.right),
    innerHeight: Math.max(0, height - margin.top - margin.bottom),
  };

  return (
    <Box ref={ref} sx={{ width: '100%', position: 'relative' }}>
      {children(frame)}
    </Box>
  );
}

/** Linear scale `[domainMin..domainMax] → [rangeMin..rangeMax]`. */
/**
 * Build an SVG `path` `d` string from a list of (x, y) pixel pairs.
 * `M x,y L x,y …` — every sparkline / line chart in this repo wants
 * the same shape, so centralising the join saves a regex worth of
 * concatenation per render and one place to evolve smoothing later.
 *
 * Skips non-finite points (sparse series with gaps render as multi-
 * segment paths) so callers don't have to pre-filter.
 */
export function buildLinePath(points: ReadonlyArray<readonly [number, number]>): string {
  let out = '';
  let needsMove = true;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { needsMove = true; continue; }
    out += needsMove ? `M${x.toFixed(2)},${y.toFixed(2)}` : ` L${x.toFixed(2)},${y.toFixed(2)}`;
    needsMove = false;
  }
  return out;
}

export function linearScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): (value: number) => number {
  const dSpan = domainMax - domainMin || 1;
  const rSpan = rangeMax - rangeMin;
  return (v) => rangeMin + ((v - domainMin) / dSpan) * rSpan;
}

/**
 * Pick ~`count` evenly-spaced ticks for a Y axis. No d3 dependency —
 * domain shapes here are mostly small (60 bars, 145 5min buckets) so a
 * hand-rolled tick chooser is plenty.
 *
 * `integer: true` snaps the step to a whole number, so an integer-valued
 * series like "transactions per block" doesn't produce ticks like
 * 0.5/1.5/2.5 that all round to the same printed label and read as
 * "0 0 1 2 2" on the axis. With `integer`, a tiny range (max ≤ 5) just
 * yields one tick per integer value, which is what people expect.
 */
export function niceTicks(min: number, max: number, count = 5, integer = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [min, max];
  }
  const span = max - min;
  const rough = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * mag);
  let step = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - rough) < Math.abs(step - rough)) step = c;
  }
  if (integer) {
    // Snap to the smallest integer that's >= the chosen step. Always at
    // least 1 so we never end up with 0.5-spaced ticks when the data is
    // discrete.
    step = Math.max(1, Math.ceil(step));
  }
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[0] !== min) ticks.unshift(min);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

/**
 * Axes + gridlines, drawn as a small group of <line>/<text> elements.
 * Caller passes the formatted tick labels — we don't second-guess their
 * domain meaning here.
 */
export function ChartAxes({
  frame,
  yTicks,
  xTicks,
  yFormat,
  xFormat,
}: {
  frame: ChartFrame;
  yTicks: number[];
  xTicks: { value: number; x: number }[];
  yFormat: (v: number) => string;
  xFormat: (v: number) => string;
}) {
  const theme = useTheme();
  const grid = theme.palette.divider;
  const text = theme.palette.text.secondary;
  const ySpan = (yTicks[yTicks.length - 1] ?? 1) - (yTicks[0] ?? 0);
  const yScale = linearScale(yTicks[0] ?? 0, yTicks[yTicks.length - 1] ?? 1, frame.innerHeight, 0);
  return (
    <g>
      {yTicks.map((v) => {
        const y = yScale(v) + frame.margin.top;
        return (
          <g key={`y-${v}`}>
            <line
              x1={frame.margin.left}
              x2={frame.margin.left + frame.innerWidth}
              y1={y}
              y2={y}
              stroke={grid}
              strokeDasharray="3 3"
            />
            <text
              x={frame.margin.left - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={11}
              fill={text}
            >
              {yFormat(ySpan === 0 ? 0 : v)}
            </text>
          </g>
        );
      })}
      {xTicks.map((t) => (
        <text
          key={`x-${t.value}`}
          x={frame.margin.left + t.x}
          y={frame.margin.top + frame.innerHeight + 16}
          textAnchor="middle"
          fontSize={11}
          fill={text}
        >
          {xFormat(t.value)}
        </text>
      ))}
    </g>
  );
}

/**
 * Lightweight bar-chart canvas. Renders a list of bars + axes + an
 * optional hover tooltip. Drop-in replacement for recharts BarChart in
 * the dashboard's high-traffic panels.
 */
export function BarChartCanvas({
  frame,
  data,
  getValue,
  fill,
  yFormat,
  xFormat,
  yMinHint,
  integerTicks = false,
  tooltipContent,
}: {
  frame: ChartFrame;
  data: Array<Record<string, unknown>>;
  getValue: (d: Record<string, unknown>) => number;
  fill: string;
  yFormat: (v: number) => string;
  xFormat: (d: Record<string, unknown>, i: number) => string;
  /** Optional minimum-of-axis hint when the data domain doesn't include 0. */
  yMinHint?: number;
  /** Snap Y-axis ticks to integers (avoids "0 0 1 2 2" duplicates on
   *  small integer-valued series like txs-per-block). */
  integerTicks?: boolean;
  tooltipContent?: (d: Record<string, unknown>, i: number) => ReactNode;
}) {
  const theme = useTheme();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Scales + tick layout depend only on data shape + frame geometry,
  // never on hoverIdx. Memo so a per-pixel mousemove (which sets
  // hoverIdx) doesn't recompute niceTicks/linearScale every frame.
  const layout = useMemo(() => {
    if (frame.width === 0 || data.length === 0) return null;
    let yMax = yMinHint ?? 0;
    for (const d of data) {
      const v = getValue(d);
      if (v > yMax) yMax = v;
    }
    const yTicks = niceTicks(0, yMax || 1, 5, integerTicks);
    const yScale = linearScale(0, yTicks[yTicks.length - 1] ?? 1, frame.innerHeight, 0);
    const barSlot = frame.innerWidth / data.length;
    const barW = Math.max(1, barSlot * 0.7);
    const barOffset = (barSlot - barW) / 2;
    // Render at most ~10 x-tick labels; otherwise the axis text overlaps.
    const xLabelCount = Math.min(10, data.length);
    const xLabelStep = Math.max(1, Math.floor(data.length / xLabelCount));
    const xTicks = data
      .map((d, i) => ({ value: i, x: i * barSlot + barSlot / 2, raw: d }))
      .filter((t) => t.value % xLabelStep === 0);
    return {
      yTicks, yScale, barSlot, barW, barOffset, xTicks,
    };
  }, [data, frame.width, frame.innerWidth, frame.innerHeight, getValue, integerTicks, yMinHint]);

  if (!layout) return null;
  const {
    yTicks, yScale, barSlot, barW, barOffset, xTicks,
  } = layout;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * frame.width - frame.margin.left;
    if (localX < 0 || localX > frame.innerWidth) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.floor(localX / barSlot);
    setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
  };

  return (
    <>
      <svg
        ref={svgRef}
        width="100%"
        height={frame.height}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        style={{ display: 'block' }}
      >
        <ChartAxes
          frame={frame}
          yTicks={yTicks}
          xTicks={xTicks.map((t) => ({ value: t.value, x: t.x }))}
          yFormat={yFormat}
          xFormat={(v) => xFormat(data[v as number] ?? {}, v as number)}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          {data.map((d, i) => {
            const v = getValue(d);
            const y = yScale(v);
            const h = frame.innerHeight - y;
            const x = i * barSlot + barOffset;
            const isHover = hoverIdx === i;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, h)}
                fill={fill}
                opacity={isHover ? 1 : 0.85}
                rx={1.5}
              />
            );
          })}
          {hoverIdx !== null && (
            <line
              x1={hoverIdx * barSlot + barSlot / 2}
              x2={hoverIdx * barSlot + barSlot / 2}
              y1={0}
              y2={frame.innerHeight}
              stroke={theme.palette.text.secondary}
              strokeDasharray="3 3"
              opacity={0.5}
            />
          )}
        </g>
      </svg>
      {hoverIdx !== null && tooltipContent && (
        <ChartTooltip
          visible
          x={frame.margin.left + hoverIdx * barSlot + barSlot / 2}
          y={frame.margin.top}
          content={tooltipContent(data[hoverIdx], hoverIdx)}
        />
      )}
    </>
  );
}

/**
 * Tooltip rendered as one <div> overlay on the chart frame. Caller
 * controls visibility/content; this just positions it next to the
 * cursor without colliding with the SVG boundary.
 */
export function ChartTooltip({
  visible,
  x,
  y,
  content,
}: {
  visible: boolean;
  x: number;
  y: number;
  content: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Flip the tooltip to the cursor's left when it would overflow the
  // chart's right edge — otherwise the parent Card / Paper clips it.
  const flipLeft = useFlipNearRightEdge(ref, (el) => {
    if (!visible) return null;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent || el.offsetWidth === 0) return null;
    return { unflippedRight: x + 8 + el.offsetWidth, bound: parent.clientWidth };
  });
  if (!visible) return null;
  return (
    <Box
      ref={ref}
      sx={{
        position: 'absolute',
        left: x,
        top: y,
        // Flip places the right edge 8px before `x` instead. Same y
        // anchor either way (tooltip rises above the cursor).
        transform: flipLeft
          ? 'translate(calc(-100% - 8px), -100%)'
          : 'translate(8px, -100%)',
        pointerEvents: 'none',
        bgcolor: 'background.paper',
        color: 'text.primary',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1,
        py: 0.5,
        fontSize: 12,
        boxShadow: 2,
        whiteSpace: 'nowrap',
        zIndex: 1,
      }}
    >
      {content}
    </Box>
  );
}

/**
 * Horizontal swatch + label row shared by chart legends. Every
 * dashboard chart has the same `<Box width=10 height=10 borderRadius=0.5
 * />` + `<Typography variant="caption">` pair; this centralises it so
 * the swatch shape stays consistent across panels.
 */
export function ChartLegend({
  items,
  spacing = 2,
  size = 10,
  flexWrap = 'wrap',
}: {
  items: ReadonlyArray<{ label: string; color: string }>;
  spacing?: number;
  size?: number;
  flexWrap?: 'wrap' | 'nowrap';
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap,
        gap: spacing,
        alignItems: 'center',
        rowGap: 0.5,
      }}
    >
      {items.map((it) => (
        <Box key={it.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{
            width: size, height: size, bgcolor: it.color, borderRadius: 0.5,
          }}
          />
          <Box component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
            {it.label}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
