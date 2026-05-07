import { Fab, Fade, useScrollTrigger } from '@mui/material';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { useTimeMachine } from '../hooks/useTimeMachine';

export function ScrollTopFab() {
  const tm = useTimeMachine();
  const trigger = useScrollTrigger({ disableHysteresis: true, threshold: 200 });
  const handleClick = () => {
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  // Lift above the bottom-fixed time-machine dock when it's in replay
  // mode (~110px on desktop, taller on mobile because the dock row
  // wraps). In live mode the dock collapses to a small left-side pill
  // so the FAB can sit at its normal corner offset.
  const liftPx = tm.isReplay
    ? { xs: 220, sm: 150, md: 130 }
    : { xs: 16, sm: 24 };
  return (
    <Fade in={trigger}>
      <Fab
        color="primary"
        size="medium"
        aria-label="Scroll to top"
        onClick={handleClick}
        sx={{
          position: 'fixed',
          bottom: liftPx,
          right: { xs: 16, sm: 24 },
          transition: 'bottom 200ms ease-out',
          zIndex: (theme) => theme.zIndex.tooltip,
        }}
      >
        <KeyboardArrowUpIcon />
      </Fab>
    </Fade>
  );
}
