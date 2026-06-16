import { Button, useTheme } from '@mui/material';
import {
  ReactNode, RefObject, useCallback, useEffect, useId, useRef, useState,
} from 'react';
import type { ChartFrame } from './SvgChart';
import { readHashDomain, readHashNumber, writeHashParams } from './hashDomain';

// Reusable drag-to-zoom on the x (time) axis for the inline-SVG charts.
//
// The hook is deliberately decoupled from hover: it only owns the drag
// gesture → x-domain. A chart keeps its own mousemove hover and composes
// the two in JSX (`if (!zoom.dragging) hover(e)`), so there's no circular
// dependency between the zoomed domain and the hover layout.
//
// Data is fully client-side (SSR-seeded whole series), so zoom is a pure
// rescale — narrow the domain, the chart's `linearScale` does the rest.
// Resolution is still capped by the data's bucket (e.g. one point per
// day); zoom magnifies, it doesn't synthesize finer detail.
//
// Usage in a chart component (one that already takes `frame` + has an
// svgRef):
//   const zoom = useXZoom({ fullDomain: [tsMin, tsMax], frame, svgRef });
//   // build xScale + ticks from zoom.domain instead of [tsMin, tsMax]
//   <svg ref={svgRef}
//        onMouseDown={zoom.onMouseDown}
//        onMouseMove={(e) => { zoom.onMouseMove(e); if (zoom.dragging) setHover(null); else hover(e); }}
//        onMouseUp={zoom.onMouseUp}
//        onMouseLeave={() => { zoom.onMouseLeave(); setHover(null); }}
//        onDoubleClick={zoom.onDoubleClick}>
//     <ChartAxes .../>
//     <g transform={`translate(${m.left},${m.top})`}>
//       <ZoomViewport zoom={zoom}>{/* clipped paths/areas/lines */}</ZoomViewport>
//       {/* hover marker (unclipped, always in-bounds) */}
//     </g>
//   </svg>
//   <ZoomResetButton zoom={zoom} />   // absolute, anchors to the relative chart Box

interface Drag { startX: number; curX: number }

export interface XZoom {
  /** Effective x-domain to scale by — the zoomed window, or the full range. */
  domain: [number, number];
  zoomed: boolean;
  /** A zoom window OR an annotation marker is set (drives the Reset button). */
  active: boolean;
  dragging: boolean;
  /** Annotation marker x-value in the chart's x-unit, or null. */
  marker: number | null;
  reset: () => void;
  onMouseDown: (e: React.MouseEvent<SVGSVGElement>) => void;
  onMouseMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  onDoubleClick: () => void;
  // Consumed by <ZoomViewport> — not for direct use.
  _clipId: string;
  _selection: { x: number; width: number } | null;
  _marker: number | null;
  _frame: ChartFrame;
}

export function useXZoom(opts: {
  fullDomain: [number, number];
  frame: ChartFrame;
  svgRef: RefObject<SVGSVGElement | null>;
  /** Minimum drag width (px) to count as a zoom rather than a click. */
  minPixels?: number;
  /** When set, the zoom window is mirrored to the URL fragment under this
   *  key (`#<key>=min_max`) so the view is shareable / deep-linkable. */
  urlKey?: string;
}): XZoom {
  const {
    fullDomain, frame, svgRef, minPixels = 6, urlKey,
  } = opts;
  const clipId = `zoomclip-${useId().replace(/:/g, '')}`;
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [marker, setMarker] = useState<number | null>(null);
  const markerKey = urlKey ? `${urlKey}m` : undefined;

  // Coerce to numbers: some charts pass through epoch/BIGINT columns that
  // serialize as numeric STRINGS (the `Point.ts: number` interfaces lie).
  // String subtraction coerces, but the `d0 + …` in finish() would
  // concatenate instead of add, producing a garbage domain that maps every
  // point off-screen (empty chart on zoom). Normalising here fixes it for
  // every consumer.
  const domain: [number, number] = zoom ?? [Number(fullDomain[0]), Number(fullDomain[1])];
  // Refs so the event handlers stay stable and never read a stale domain.
  const dragRef = useRef<Drag | null>(drag);
  dragRef.current = drag;
  const domainRef = useRef(domain);
  domainRef.current = domain;

  // Auto-reset when the data range moves out from under an active zoom —
  // e.g. switching to a different year in a per-year detail chart reuses
  // this hook's state, and the old year's zoom window no longer overlaps
  // the new year's data (→ empty chart). Only resets on a genuine range
  // change-over, never on a live tip extension (which keeps overlapping).
  useEffect(() => {
    const fMin = Number(fullDomain[0]);
    const fMax = Number(fullDomain[1]);
    setZoom((z) => (z && (z[0] > fMax || z[1] < fMin) ? null : z));
  }, [fullDomain]);

  // Deep-link sync (opt-in via urlKey). Read the window from the fragment
  // once on mount; only apply it if it overlaps the data (a stale link
  // shouldn't blank the chart). The write pass is skipped on mount so a
  // shared link's fragment isn't clobbered before the read applies it.
  const writeReady = useRef(false);
  useEffect(() => {
    if (!urlKey || !markerKey) return;
    const d = readHashDomain(urlKey);
    if (d) {
      const fMin = Number(fullDomain[0]);
      const fMax = Number(fullDomain[1]);
      if (!(d[0] > fMax || d[1] < fMin)) setZoom(d);
    }
    const m = readHashNumber(markerKey);
    if (m !== null) setMarker(m);
    // Mount-only: re-reading on fullDomain/urlKey change would re-apply a
    // stale window after a year switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!urlKey || !markerKey) return;
    if (!writeReady.current) { writeReady.current = true; return; }
    writeHashParams({
      [urlKey]: zoom ? `${Math.round(zoom[0])}_${Math.round(zoom[1])}` : null,
      [markerKey]: marker !== null ? String(Math.round(marker)) : null,
    });
  }, [zoom, marker, urlKey, markerKey]);

  const localX = useCallback((e: React.MouseEvent<SVGSVGElement>): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * frame.width - frame.margin.left;
    return Math.max(0, Math.min(frame.innerWidth, x));
  }, [svgRef, frame.width, frame.margin.left, frame.innerWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const x = localX(e);
    if (x === null) return;
    setDrag({ startX: x, curX: x });
  }, [localX]);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const x = localX(e);
    if (x === null) return;
    setDrag((d) => (d ? { startX: d.startX, curX: x } : d));
  }, [localX]);

  const finish = useCallback(() => {
    const d = dragRef.current;
    setDrag(null);
    if (!d || frame.innerWidth <= 0) return;
    const x0 = Math.min(d.startX, d.curX);
    const x1 = Math.max(d.startX, d.curX);
    const [d0, d1] = domainRef.current;
    const span = d1 - d0;
    if (span <= 0) return;
    if (x1 - x0 < minPixels) {
      // A click (negligible drag) drops / toggles the annotation marker
      // at that x — distinct from drag-to-zoom.
      const clickX = (x0 + x1) / 2;
      const value = d0 + (clickX / frame.innerWidth) * span;
      setMarker((m) => {
        if (m !== null && Math.abs(((m - d0) / span) * frame.innerWidth - clickX) < 6) {
          return null; // click on the marker → clear it
        }
        return value;
      });
      return;
    }
    const newMin = d0 + (x0 / frame.innerWidth) * span;
    const newMax = d0 + (x1 / frame.innerWidth) * span;
    if (newMax > newMin) setZoom([newMin, newMax]);
  }, [minPixels, frame.innerWidth]);

  const reset = useCallback(() => { setZoom(null); setMarker(null); }, []);

  const selection = drag && Math.abs(drag.curX - drag.startX) >= 1
    ? { x: Math.min(drag.startX, drag.curX), width: Math.abs(drag.curX - drag.startX) }
    : null;

  return {
    domain,
    zoomed: zoom !== null,
    active: zoom !== null || marker !== null,
    dragging: drag !== null,
    marker,
    reset,
    onMouseDown,
    onMouseMove,
    onMouseUp: finish,
    onMouseLeave: finish,
    onDoubleClick: reset,
    _clipId: clipId,
    _selection: selection,
    _marker: marker,
    _frame: frame,
  };
}

// Clips its children to the chart's inner plot area (so zoomed-out-of-view
// path segments don't overflow) and paints the live drag-selection band.
// Render it INSIDE the chart's `translate(margin)` group, wrapping the
// data paths.
export function ZoomViewport({ zoom, children }: { zoom: XZoom; children: ReactNode }) {
  const theme = useTheme();
  const { innerWidth, innerHeight } = zoom._frame;
  return (
    <>
      <defs>
        <clipPath id={zoom._clipId}>
          <rect x={0} y={0} width={innerWidth} height={innerHeight} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${zoom._clipId})`}>{children}</g>
      {zoom._selection && (
        <rect
          x={zoom._selection.x}
          y={0}
          width={zoom._selection.width}
          height={innerHeight}
          fill={theme.palette.primary.main}
          fillOpacity={0.12}
          stroke={theme.palette.primary.main}
          strokeOpacity={0.4}
          strokeWidth={1}
          pointerEvents="none"
        />
      )}
      <ChartMarker zoom={zoom} />
    </>
  );
}

// The annotation marker — a vertical line + a small pin head at the x the
// author clicked. Drawn from zoom.domain + _marker (same linear mapping
// the chart's xScale uses), so it needs no per-chart wiring; only shows
// while the marker is inside the current (possibly zoomed) window.
function ChartMarker({ zoom }: { zoom: XZoom }) {
  const theme = useTheme();
  if (zoom._marker === null) return null;
  const { innerWidth, innerHeight } = zoom._frame;
  const [d0, d1] = zoom.domain;
  const span = d1 - d0;
  if (span <= 0) return null;
  const x = ((zoom._marker - d0) / span) * innerWidth;
  if (x < 0 || x > innerWidth) return null;
  const color = theme.palette.secondary.main;
  return (
    <g pointerEvents="none">
      <line x1={x} x2={x} y1={0} y2={innerHeight} stroke={color} strokeWidth={1.5} strokeDasharray="2 3" />
      <polygon points={`${x - 4},0 ${x + 4},0 ${x},6`} fill={color} />
    </g>
  );
}

// Floating "Reset" affordance — shown while a zoom window OR an
// annotation marker is set; clears both. Anchors to the nearest
// positioned ancestor (the ChartFrameProvider Box is position: relative),
// so just render it alongside the chart's <svg>.
export function ZoomResetButton({ zoom }: { zoom: { active: boolean; reset: () => void } }) {
  if (!zoom.active) return null;
  return (
    <Button
      size="small"
      variant="outlined"
      onClick={zoom.reset}
      sx={{
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 2,
        py: 0.25,
        px: 1,
        minWidth: 0,
        fontSize: 12,
        bgcolor: 'background.paper',
      }}
    >
      Reset
    </Button>
  );
}
