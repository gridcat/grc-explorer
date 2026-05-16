import { Box, Stack, Typography } from '@mui/material';
import { ReactNode, useRef } from 'react';
import { useFlipNearRightEdge } from './useFlipNearRightEdge';

// Themed recharts tooltip. The default `<Tooltip />` recharts ships is
// a flat white card with no border-radius or shadow — fine in light
// mode, ugly against a dark MUI Paper. Every recharts-using page in
// the explorer wants the same MUI-tokened surface, so the styling
// lives here and pages just feed in the title + rows.
//
// Two pieces:
//
//   * `RechartsTooltipBox` — pure presentational. Title + a list of
//     `{ label, value, color? }` rows. Reuse directly when you have
//     enough payload to materialise the rows yourself.
//
//   * `makeRechartsTooltip` — recharts adapter. Wraps `formatRows` so
//     the recharts payload type doesn't leak into every caller, returns
//     a component you pass straight into `<Tooltip content={...}/>`.
//
// Pair with a themed cursor so the crosshair / hover band picks up
// the active palette too:
//
//   line/scatter:  cursor={{ stroke: theme.palette.divider, strokeDasharray: '3 3' }}
//   bar:           cursor={{ fill: theme.palette.action.hover }}

export interface TooltipRow {
  /** Short label shown in muted text on the left of the row. */
  label: string;
  /** Pre-formatted value; the page owns the units / precision. */
  value: ReactNode;
  /** Optional series swatch — matches the bar/line stroke for legibility on stacked charts. */
  color?: string;
}

// Default cursor offset recharts uses. Mirror it on the flipped side so
// the tooltip never overlaps the data point itself.
const RECHARTS_OFFSET = 10;

export function RechartsTooltipBox({
  title,
  rows,
}: {
  title?: ReactNode;
  rows: TooltipRow[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Recharts only clamps the tooltip against the chart's right wall,
  // which a MUI Card's `overflow: hidden` then clips. DOM-based detect
  // (not via viewBox/coordinate props — recharts doesn't thread those
  // through reliably across chart types).
  const flipLeft = useFlipNearRightEdge(ref, (el) => {
    const chartWrapper = el.closest('.recharts-wrapper') as HTMLElement | null;
    const tooltipWrapper = el.parentElement;
    if (!chartWrapper || !tooltipWrapper || el.offsetWidth === 0) return null;
    // tooltipWrapper.offsetLeft is recharts' computed left for the
    // unflipped tooltip (cursor.x + offset).
    return {
      unflippedRight: tooltipWrapper.offsetLeft + el.offsetWidth,
      bound: chartWrapper.clientWidth,
    };
  });

  if (rows.length === 0) return null;
  return (
    <Box
      ref={ref}
      sx={{
        bgcolor: 'background.paper',
        color: 'text.primary',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        fontSize: 12,
        boxShadow: 2,
        minWidth: 140,
        // Cancel recharts' rightward offset (offsetLeft = cursor + 10)
        // and shift our right edge to sit `offset` left of the cursor
        // — total displacement is -100% (own width) - 2 × offset.
        transform: flipLeft ? `translateX(calc(-100% - ${RECHARTS_OFFSET * 2}px))` : undefined,
      }}
    >
      {title !== undefined && title !== null && title !== '' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
          {title}
        </Typography>
      )}
      <Stack spacing={0.25}>
        {rows.map((r) => (
          <Stack key={r.label} direction="row" sx={{ alignItems: 'center', gap: 0.75 }}>
            {r.color && (
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: 0.5,
                  bgcolor: r.color,
                  flex: '0 0 auto',
                }}
              />
            )}
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
              {r.label}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {r.value}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

// Recharts hands its custom content component these props.
interface RechartsPayloadEntry {
  name?: string;
  value?: number | string;
  dataKey?: string;
  color?: string;
  payload?: Record<string, unknown>;
}

interface RechartsContentProps {
  active?: boolean;
  payload?: RechartsPayloadEntry[];
  label?: number | string;
}

/**
 * Build a recharts `content` component from a per-payload formatter.
 * The formatter returns `{ title, rows }` (or null to suppress the
 * tooltip for that hover). Returning null is useful for scatter
 * charts where you want to hide the tooltip on empty regions.
 *
 * The returned box auto-flips to the cursor's left when it would
 * overflow the chart's right edge — no extra wiring required.
 */
export function makeRechartsTooltip(
  formatRows: (
    payload: RechartsPayloadEntry[],
    label: number | string | undefined,
  ) => { title?: ReactNode; rows: TooltipRow[] } | null,
) {
  return function TooltipContent({ active, payload, label }: RechartsContentProps) {
    if (!active || !payload || payload.length === 0) return null;
    const data = formatRows(payload, label);
    if (!data) return null;
    return <RechartsTooltipBox title={data.title} rows={data.rows} />;
  };
}
