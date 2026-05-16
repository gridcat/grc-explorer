import {
  RefObject, useLayoutEffect, useState,
} from 'react';

/**
 * Shared overflow-detection for chart tooltips. Returns `true` when the
 * element referenced by `ref` would overflow its containing chart's
 * right edge — callers respond by applying a leftward transform so the
 * tooltip flips to the cursor's left side instead of being clipped by
 * the parent Card / Paper.
 *
 * `measure` is called after every render and returns the unflipped
 * right edge of the tooltip plus the chart's right-edge bound, both in
 * pixels and in the same coordinate space (typically the offsetParent's
 * client box). Returning `null` skips the update — useful for invisible
 * /unmounted tooltips or when refs aren't ready yet.
 *
 * State setter bails on identity equality, so a per-render no-op doesn't
 * cascade. The layout-read itself is one offsetWidth + one clientWidth
 * per render; cheap enough on cursor-move cadence.
 */
export function useFlipNearRightEdge<T extends HTMLElement>(
  ref: RefObject<T | null>,
  measure: (el: T) => { unflippedRight: number; bound: number } | null,
): boolean {
  const [flipLeft, setFlipLeft] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = measure(el);
    if (!m) return;
    setFlipLeft(m.unflippedRight > m.bound);
  });
  return flipLeft;
}
