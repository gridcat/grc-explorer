import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { readHashDomain, readHashNumber, writeHashParams } from './hashDomain';

// Drag-to-zoom + click-to-annotate for recharts charts, matching the
// inline-SVG charts' gestures (see useXZoom). Recharts hands us the
// x-axis value under the cursor via the chart's mouse callbacks
// (`activeLabel`): a drag clamps the x-axis domain to that range (painted
// with a <ReferenceArea>); a click (no drag) drops/toggles an annotation
// marker (painted with a <ReferenceLine x={marker} />).

// Minimal structural shape of the recharts mouse-callback state — enough
// to read the active x value without depending on recharts' internal types.
interface RechartsMouseState { activeLabel?: string | number }

export interface RechartsXZoom {
  domain: [number, number] | undefined;
  refLeft: number | null;
  refRight: number | null;
  zoomed: boolean;
  /** A zoom window OR a marker is set (drives the Reset button). */
  active: boolean;
  /** Annotation marker x-value, or null. */
  marker: number | null;
  onMouseDown: (s: RechartsMouseState | null) => void;
  onMouseMove: (s: RechartsMouseState | null) => void;
  onMouseUp: () => void;
  reset: () => void;
}

export function useRechartsXZoom(urlKey?: string): RechartsXZoom {
  const [refLeft, setRefLeft] = useState<number | null>(null);
  const [refRight, setRefRight] = useState<number | null>(null);
  const [domain, setDomain] = useState<[number, number] | undefined>(undefined);
  const [marker, setMarker] = useState<number | null>(null);
  const leftRef = useRef<number | null>(null);
  leftRef.current = refLeft;
  const rightRef = useRef<number | null>(null);
  rightRef.current = refRight;
  const markerKey = urlKey ? `${urlKey}m` : undefined;

  // Deep-link sync (opt-in via urlKey): read zoom + marker from the URL
  // fragment on mount, mirror them back on change. Skip the mount write so
  // a shared link's fragment isn't cleared before the read applies it.
  const writeReady = useRef(false);
  useEffect(() => {
    if (!urlKey || !markerKey) return;
    const d = readHashDomain(urlKey);
    if (d) setDomain(d);
    const m = readHashNumber(markerKey);
    if (m !== null) setMarker(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!urlKey || !markerKey) return;
    if (!writeReady.current) { writeReady.current = true; return; }
    writeHashParams({
      [urlKey]: domain ? `${Math.round(domain[0])}_${Math.round(domain[1])}` : null,
      [markerKey]: marker !== null ? String(Math.round(marker)) : null,
    });
  }, [domain, marker, urlKey, markerKey]);

  const onMouseDown = useCallback((s: RechartsMouseState | null) => {
    if (s?.activeLabel == null) return;
    const v = Number(s.activeLabel);
    if (Number.isFinite(v)) { setRefLeft(v); setRefRight(v); }
  }, []);

  const onMouseMove = useCallback((s: RechartsMouseState | null) => {
    if (leftRef.current === null || s?.activeLabel == null) return;
    const v = Number(s.activeLabel);
    if (Number.isFinite(v)) setRefRight(v);
  }, []);

  const onMouseUp = useCallback(() => {
    const l = leftRef.current;
    const r = rightRef.current;
    setRefLeft(null);
    setRefRight(null);
    if (l === null || r === null) return;
    if (l === r) {
      // Click (no drag) → drop / toggle the annotation marker.
      setMarker((m) => (m === l ? null : l));
      return;
    }
    setDomain([Math.min(l, r), Math.max(l, r)]);
  }, []);

  const reset = useCallback(() => { setDomain(undefined); setMarker(null); }, []);

  return {
    domain,
    refLeft,
    refRight,
    zoomed: domain !== undefined,
    active: domain !== undefined || marker !== null,
    marker,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    reset,
  };
}
