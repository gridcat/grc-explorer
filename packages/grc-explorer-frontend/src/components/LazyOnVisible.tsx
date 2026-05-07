import { Box } from '@mui/material';
import {
  ReactNode, useEffect, useRef, useState,
} from 'react';

interface Props {
  children: ReactNode;
  /** How tall the placeholder is before mount. Pick something close to the
   *  real component's height to avoid a layout jump on reveal. */
  minHeight?: number | string;
  /**
   * Pre-mount distance — start rendering when the placeholder is this
   * many pixels from the viewport edge. Default 200 so the user almost
   * never sees the placeholder.
   */
  rootMargin?: string;
}

/**
 * Defer mounting of expensive children (recharts, big SSE panels) until
 * the user scrolls them near the viewport. Until then we render a
 * fixed-height empty placeholder, so the page lays out predictably and
 * the initial-paint cost is bounded by what's above the fold.
 *
 * Why this matters here: the home dashboard renders ~10 heavy panels
 * (each a recharts ResponsiveContainer + chart + SSE subscription +
 * API fetch on mount). Mounting them all at once on a fresh page load
 * pegs the main thread for several seconds.
 */
export function LazyOnVisible({ children, minHeight = 240, rootMargin = '200px' }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [rootMargin]);

  // Drop the placeholder min-height once the children mount so the box
  // sizes to its actual content. Reserving space permanently was causing
  // visible empty gaps below short panels (e.g. WealthDistribution on a
  // young testnet, where the chart is hidden and only the headline tiles
  // render). The drift-protection role this used to play is now covered
  // panel-by-panel — most notably padding the LiveBlockTicker / blocks
  // tables to a fixed row count so they don't shrink as data shifts.
  return (
    <Box ref={ref} sx={{ minHeight: visible ? undefined : minHeight }}>
      {visible ? children : null}
    </Box>
  );
}
