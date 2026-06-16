import { Button, Snackbar } from '@mui/material';
import LinkIcon from '@mui/icons-material/Link';
import { useCallback, useState } from 'react';

// Page-level "share this view" affordance. Copies the current full URL —
// which, on chart pages, carries the zoom window in the fragment
// (`#z=min-max`) and any `?year=` slice — so a recipient lands on the
// exact same view. Lives in the breadcrumb row, not per-chart: the
// shareable unit is the page URL, which is page-level state.
export function CopyLinkButton() {
  const [open, setOpen] = useState(false);

  const copy = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = window.location.href;
    const done = () => setOpen(true);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => {
        // Clipboard API can reject (insecure context / permissions);
        // still surface the snackbar so the user isn't left guessing.
        done();
      });
    } else {
      done();
    }
  }, []);

  return (
    <>
      <Button
        size="small"
        variant="text"
        startIcon={<LinkIcon sx={{ fontSize: 18 }} />}
        onClick={copy}
        sx={{
          flexShrink: 0,
          py: 0.25,
          px: 1,
          minWidth: 0,
          fontSize: 12,
          textTransform: 'none',
          color: 'text.secondary',
        }}
      >
        Copy link
      </Button>
      <Snackbar
        open={open}
        autoHideDuration={2000}
        onClose={() => setOpen(false)}
        message="Link copied"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  );
}
