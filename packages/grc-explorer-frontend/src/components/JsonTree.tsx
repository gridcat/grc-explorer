import { Box } from '@mui/material';
import { useState } from 'react';

/**
 * Inline collapsible JSON tree with light type colouring.
 *
 *   strings  → primary.dark
 *   numbers  → secondary.dark
 *   booleans → success.main
 *   null     → text.disabled italic
 *   keys     → text.primary semibold
 *
 * Click any { } or [ ] header to fold/unfold the node. Initial fold
 * depth is configurable so the top-level structure is visible without
 * blowing the viewport on huge transactions.
 *
 * No external dep — react-json-view-lite + similar libs work fine but
 * pull in their own theming engine. The explorer's surface area is
 * small enough that a 100-line custom tree fits the design language
 * better than a third-party component.
 */
export function JsonTree({
  value,
  /** Rows nested deeper than this start collapsed. Default: 1. */
  initialOpenDepth = 1,
}: {
  value: unknown;
  initialOpenDepth?: number;
}) {
  return (
    <Box
      component="div"
      sx={{
        fontFamily: 'monospace',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: 'text.primary',
      }}
    >
      <Node value={value} depth={0} initialOpenDepth={initialOpenDepth} isLast />
    </Box>
  );
}

interface NodeProps {
  value: unknown;
  /** Object key or array index this node sits under (omitted at root). */
  label?: string;
  depth: number;
  initialOpenDepth: number;
  /** Last sibling? Controls whether we render a trailing comma. */
  isLast: boolean;
}

function Node({
  value, label, depth, initialOpenDepth, isLast,
}: NodeProps) {
  if (value === null) return <Leaf label={label} depth={depth} isLast={isLast} kind="null" raw="null" />;
  const t = typeof value;
  if (t === 'string') {
    return <Leaf label={label} depth={depth} isLast={isLast} kind="string" raw={JSON.stringify(value)} />;
  }
  if (t === 'number' || t === 'bigint') {
    return <Leaf label={label} depth={depth} isLast={isLast} kind="number" raw={String(value)} />;
  }
  if (t === 'boolean') {
    return <Leaf label={label} depth={depth} isLast={isLast} kind="boolean" raw={String(value)} />;
  }
  if (Array.isArray(value)) {
    return <Collapsible label={label} depth={depth} isLast={isLast} initialOpenDepth={initialOpenDepth} kind="array" entries={value.map((v, i) => [String(i), v] as [string, unknown])} />;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    return <Collapsible label={label} depth={depth} isLast={isLast} initialOpenDepth={initialOpenDepth} kind="object" entries={keys.map((k) => [k, obj[k]] as [string, unknown])} />;
  }
  return <Leaf label={label} depth={depth} isLast={isLast} kind="null" raw={String(value)} />;
}

const COLORS: Record<string, string> = {
  string: 'primary.dark',
  number: 'secondary.dark',
  boolean: 'success.main',
  null: 'text.disabled',
};

function Leaf({
  label, depth, isLast, kind, raw,
}: {
  label?: string; depth: number; isLast: boolean; kind: 'string' | 'number' | 'boolean' | 'null'; raw: string;
}) {
  return (
    <Box sx={{ pl: depth * 2 }}>
      {label !== undefined && (
        <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>{`"${label}": `}</Box>
      )}
      <Box
        component="span"
        sx={{
          color: COLORS[kind],
          fontStyle: kind === 'null' ? 'italic' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {raw}
      </Box>
      {!isLast && <Box component="span" sx={{ color: 'text.secondary' }}>,</Box>}
    </Box>
  );
}

function Collapsible({
  label, depth, isLast, initialOpenDepth, kind, entries,
}: {
  label?: string;
  depth: number;
  isLast: boolean;
  initialOpenDepth: number;
  kind: 'object' | 'array';
  entries: Array<[string, unknown]>;
}) {
  const [open, setOpen] = useState(depth < initialOpenDepth);
  const [openBracket, closeBracket] = kind === 'array' ? ['[', ']'] : ['{', '}'];
  const summary = kind === 'array'
    ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`;

  return (
    <Box sx={{ pl: depth * 2 }}>
      <Box
        component="span"
        onClick={() => setOpen((o) => !o)}
        sx={{
          cursor: 'pointer',
          userSelect: 'none',
          ':hover': { color: 'primary.main' },
        }}
      >
        <Box
          component="span"
          sx={{
            display: 'inline-block',
            width: 14,
            color: 'text.secondary',
            transition: 'transform 120ms',
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        >
          ▾
        </Box>
        {label !== undefined && (
          <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>{`"${label}": `}</Box>
        )}
        <Box component="span">{openBracket}</Box>
        {!open && (
          <>
            <Box component="span" sx={{ color: 'text.disabled', mx: 1 }}>{summary}</Box>
            <Box component="span">{closeBracket}</Box>
          </>
        )}
      </Box>
      {open && (
        <>
          <Box>
            {entries.map(([k, v], i) => (
              <Node
                key={k}
                label={kind === 'object' ? k : undefined}
                value={v}
                depth={depth + 1}
                initialOpenDepth={initialOpenDepth}
                isLast={i === entries.length - 1}
              />
            ))}
          </Box>
          <Box sx={{ pl: depth * 2 }}>
            <Box component="span">{closeBracket}</Box>
            {!isLast && <Box component="span" sx={{ color: 'text.secondary' }}>,</Box>}
          </Box>
        </>
      )}
    </Box>
  );
}
