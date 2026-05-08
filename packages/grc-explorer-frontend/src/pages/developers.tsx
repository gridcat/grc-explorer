import {
  Box, Container, Grid, Typography,
} from '@mui/material';
import { Layout } from '../layouts/Layout';
import { Contents } from '../routes/developers/Contents';
import {
  Addresses,
  Beacons,
  Blocks,
  Conventions,
  Cpids,
  Errors,
  Mempool,
  Metrics,
  MrcRequests,
  Network,
  Overview,
  Polls,
  Search,
  Status,
  Superblocks,
  Transactions,
} from '../routes/developers/Chapters';

/**
 * /developers — public API reference. Mirrors the chapter-per-section
 * shape used by stamp.gridcoin.club's docs: a sticky sidebar with
 * scroll-spy on the left, ordered chapters on the right.
 *
 * The reference is kept in sync with the routes by hand — there's no
 * generator. Any new endpoint or schema change ships with a chapter
 * edit, not a separate doc PR.
 */
export default function DevelopersPage() {
  return (
    <Layout showTimeMachine={false}>
      <Container maxWidth="xl" sx={{ flexGrow: 1 }}>
        <Grid container spacing={3}>
          <Grid
            size={{ sm: 3, xs: 12 }}
            sx={{ display: { xs: 'none', sm: 'flex' } }}
          >
            <Contents />
          </Grid>
          <Grid size={{ sm: 9, xs: 12 }}>
            <Box sx={{ pb: 2 }}>
              <Typography component="h1" variant="h4" sx={{ pb: 1 }}>
                API Reference
              </Typography>
              <Typography variant="body1" color="text.secondary">
                A public, auth-free JSON:API for the Gridcoin chain. Every
                block, transaction, address, claim, superblock, poll, and
                beacon view that powers the dashboard you&apos;re reading.
              </Typography>
            </Box>
            <Overview />
            <Conventions />
            <Errors />
            <Status />
            <Blocks />
            <Transactions />
            <Addresses />
            <Mempool />
            <Superblocks />
            <Cpids />
            <Polls />
            <Beacons />
            <MrcRequests />
            <Network />
            <Metrics />
            <Search />
          </Grid>
        </Grid>
      </Container>
    </Layout>
  );
}
