import {
  Box, List, ListItem, ListItemButton, ListItemText, Typography,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import { useMemo } from 'react';
import { useScrollSpy } from '../../hooks/useScrollSpy';

export interface PageContentsEntry {
  id: string;
  label: string;
  indent?: boolean;
}

interface PageContentsProps {
  entries: PageContentsEntry[];
}

const ContentsContainer = styled(Box)(({ theme }) => ({
  paddingTop: theme.spacing(7),
  position: 'sticky',
  top: theme.spacing(2),
  maxHeight: `calc(100vh - ${theme.spacing(4)})`,
  overflowY: 'auto',
}));

function getColor(isActive: boolean, indent: boolean | undefined): string {
  if (isActive) return 'primary.main';
  if (indent) return 'text.secondary';
  return 'text.primary';
}

/**
 * Side nav for the developer reference. ScrollSpy keeps the active
 * section highlighted as the reader scrolls. The sidebar itself sticks
 * within its column so the table of contents is always one glance away.
 */
export function PageContents({ entries }: PageContentsProps) {
  const ids = useMemo(() => entries.map((e) => e.id), [entries]);
  const active = useScrollSpy(ids);

  return (
    <ContentsContainer>
      <Typography
        variant="overline"
        sx={{
          display: 'block',
          pl: 2,
          pb: 1,
          color: 'text.secondary',
          letterSpacing: '0.1em',
        }}
      >
        On this page
      </Typography>
      <List disablePadding dense>
        {entries.map(({ id, label, indent }) => {
          const isActive = active === id;
          return (
            <ListItem key={id} disablePadding>
              <ListItemButton
                href={`#${id}`}
                selected={isActive}
                sx={{
                  pl: indent ? 4 : 2,
                  borderLeft: '2px solid',
                  borderColor: isActive ? 'primary.main' : 'transparent',
                  '&.Mui-selected': { backgroundColor: 'transparent' },
                  '&.Mui-selected:hover': { backgroundColor: 'action.hover' },
                }}
              >
                <ListItemText
                  primary={label}
                  slotProps={{
                    primary: {
                      variant: 'body2',
                      sx: {
                        color: getColor(isActive, indent),
                        fontWeight: isActive ? 600 : 400,
                      },
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </ContentsContainer>
  );
}
