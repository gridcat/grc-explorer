import { useEffect, useState } from 'react';
import { timeAgo } from '../lib/format';

// Per-row interval (rather than ticking the parent) keeps the rest of
// the table from reconciling every second. Storing the formatted string
// in state means React bails out when timeAgo's output is unchanged —
// most rows are in minute-granularity, so 29/30 ticks are no-ops.
// Pauses while the tab is hidden.
export function TimeAgo({ unixSec }: { unixSec: number }) {
  const [display, setDisplay] = useState(() => timeAgo(unixSec));
  useEffect(() => {
    setDisplay(timeAgo(unixSec));
    if (typeof document === 'undefined') return undefined;
    let id: ReturnType<typeof setInterval> | null = null;
    const refresh = () => setDisplay(timeAgo(unixSec));
    const start = () => { if (id === null) id = setInterval(refresh, 1000); };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    if (!document.hidden) start();
    const onVis = () => {
      if (document.hidden) stop();
      else { refresh(); start(); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [unixSec]);
  return <>{display}</>;
}
