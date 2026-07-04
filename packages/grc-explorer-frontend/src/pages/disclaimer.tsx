import {
  Alert, AlertTitle, Box, Container, Divider, Grid, Typography,
} from '@mui/material';
import { Seo } from '@/components/Seo';
import { Layout } from '../layouts/Layout';
import { PageContents, PageContentsEntry } from '../components/PageContents/PageContents';
import { NextMuiLink } from '../components/NextMuiLink';

const CONTACT_EMAIL = 'gridcat@proton.me';
const GOVERNING_LAW = '[Operator’s principal place of business]';
const EFFECTIVE_DATE = '2026-05-07';

const capsMono = {
  fontFamily: 'var(--font-mono, monospace)',
  textTransform: 'uppercase',
  fontSize: 13,
  lineHeight: 1.6,
} as const;

const entries: PageContentsEntry[] = [
  { id: 'acceptance', label: 'Read this first' },
  { id: 'mirror', label: 'A passive mirror' },
  { id: 'immutable', label: 'On-chain data is permanent', indent: true },
  { id: 'not', label: 'What we are not' },
  { id: 'eligibility', label: 'Eligibility & sanctions' },
  { id: 'prohibited', label: 'Prohibited use' },
  { id: 'user-content', label: 'User-submitted content' },
  { id: 'takedown', label: 'Notice & action', indent: true },
  { id: 'privacy', label: 'Privacy and personal data' },
  { id: 'asis', label: 'Use at your own risk' },
  { id: 'accuracy', label: 'No accuracy guarantee', indent: true },
  { id: 'liability', label: 'No liability' },
  { id: 'no-advice', label: 'No financial advice' },
  { id: 'third-parties', label: 'Third-party services' },
  { id: 'indemnification', label: 'Indemnification' },
  { id: 'governing-law', label: 'Governing law' },
  { id: 'changes', label: 'Changes' },
  { id: 'contact', label: 'Contact' },
];

export default function DisclaimerPage() {
  return (
    <>
      <Seo
        title="Disclaimer · Gridcoin Block Explorer"
        description="Data-accuracy disclaimer and terms for the Gridcoin block explorer."
        path="/disclaimer"
      />
    <Layout showTimeMachine={false}>
      <Container maxWidth="xl" sx={{ flexGrow: 1 }}>
        <Grid container spacing={3}>
          <Grid
            size={{ sm: 3, xs: 12 }}
            sx={{ display: { xs: 'none', sm: 'flex' } }}
          >
            <PageContents entries={entries} />
          </Grid>
          <Grid size={{ sm: 9, xs: 12 }}>
            <Box sx={{ pb: 2 }}>
              <Typography component="h1" variant="h4" sx={{ pb: 1 }}>
                Terms of Service
              </Typography>
              <Typography variant="body1" color="text.secondary">
                The contract, the disclaimer, and the acceptable-use
                policy for using this Gridcoin blockchain explorer.
                Read it before relying on anything you see here.
              </Typography>
            </Box>

            <Box id="acceptance" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Read this first
              </Typography>
              <Typography gutterBottom variant="body1">
                These Terms cover your use of this Gridcoin blockchain
                explorer (the &ldquo;Service&rdquo; from here on),
                including the web UI, the JSON:API, the Server-Sent
                Events feed, and any other component shipped under
                the same name. The Service is open-source software
                published under the MIT licence; the source lives at
                {' '}
                <NextMuiLink
                  href="https://github.com/gridcat/grc-explorer"
                  rel="external noopener"
                  prose
                >
                  github.com/gridcat/grc-explorer
                </NextMuiLink>
                .
              </Typography>
              <Typography gutterBottom variant="body1">
                By using the Service in any form you agree to these
                Terms. If you do not agree, do not use it. Where the
                law requires capital letters or specific phrasing for
                enforceability we have used them; everywhere else we
                have tried to keep the prose plain.
              </Typography>
            </Box>

            <Box id="mirror" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                A passive mirror
              </Typography>
              <Typography gutterBottom variant="body1">
                This explorer is a passive mirror of the public Gridcoin
                blockchain. It indexes blocks, transactions, addresses,
                claims, beacons, polls, superblocks, and other records
                that have already been published to the network, and
                presents them in a more readable form. We do not author,
                curate, moderate, or endorse the content stored on the
                chain.
              </Typography>

              <Typography variant="h6" component="h3" id="immutable" sx={{ pt: 2, pb: 1 }}>
                On-chain data is permanent
              </Typography>
              <Typography gutterBottom variant="body1">
                The Gridcoin blockchain is a permissionless,
                distributed ledger maintained by independent nodes
                worldwide. Once a transaction has been confirmed by the
                network, nobody (including the operators of this
                explorer) can rewrite, redact, or delete it.
              </Typography>
              <Typography gutterBottom variant="body1">
                If you encounter content here that you believe is
                illegal, offensive, or otherwise objectionable, please
                be aware that it lives on the chain itself. The only
                thing under our control is whether <em>this</em>
                {' '}
                explorer chooses to display it. We may, at our sole
                discretion, omit, redact, replace, or filter individual
                records from this explorer&rsquo;s display, but the
                underlying chain is outside our control and other
                explorers and Gridcoin nodes will continue to surface
                the same data.
              </Typography>
            </Box>

            <Box id="not" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                What we are not
              </Typography>
              <Typography gutterBottom variant="body1">
                Neither the operator of this explorer nor the
                maintainers of the underlying software are, in any
                jurisdiction:
              </Typography>
              <Box component="ul" sx={{ pl: 3, mt: 0 }}>
                <Typography component="li" variant="body1" gutterBottom>
                  a registered Money Services Business, money
                  transmitter, virtual-asset service provider,
                  Crypto-Asset Service Provider under EU MiCA, or
                  payment institution;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  a custodian, exchange, broker, dealer, or trading
                  venue;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  a blockchain analytics, AML/CFT screening,
                  transaction-risk-scoring, sanctions-tagging, or
                  forensic-investigation provider; the explorer
                  displays chain state and does not flag, score, or
                  vet addresses;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  a Qualified Trust Service Provider under eIDAS, a
                  notary, a witness, or a certifying authority;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  a provider of legal, tax, accounting, or investment
                  advice.
                </Typography>
              </Box>
              <Typography gutterBottom variant="body1">
                We publish open-source software and run one mirror of
                a public chain. Anyone can run their own.
              </Typography>
            </Box>

            <Box id="eligibility" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Eligibility &amp; sanctions
              </Typography>
              <Typography gutterBottom variant="body1">
                By using the Service you represent and warrant that:
              </Typography>
              <Box component="ul" sx={{ pl: 3, mt: 0 }}>
                <Typography component="li" variant="body1" gutterBottom>
                  you are at least 18 years old (or the legal age of
                  majority in your jurisdiction, whichever is greater);
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  you are not a resident of, located in, or a national
                  of any country or region subject to comprehensive
                  sanctions imposed by the United Nations, European
                  Union, United Kingdom, Switzerland, or United
                  States, and you are not on any of those
                  authorities&rsquo; sanctions lists;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  using the Service is lawful in your jurisdiction; and
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  you have legal capacity to be bound by these Terms.
                </Typography>
              </Box>
            </Box>

            <Box id="prohibited" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Prohibited use
              </Typography>
              <Typography gutterBottom variant="body1">
                You agree not to use the Service:
              </Typography>
              <Box component="ul" sx={{ pl: 3, mt: 0 }}>
                <Typography component="li" variant="body1" gutterBottom>
                  to launch, assist, or facilitate denial-of-service
                  against this explorer, the JSON:API, the SSE feed,
                  the Gridcoin network, or any third-party dependency,
                  including by automated traffic patterns that exceed
                  posted rate limits;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  to scrape, mirror, or republish the explorer&rsquo;s
                  output beyond the limits set by the public API; if
                  you need bulk access, run your own indexer against a
                  full Gridcoin node;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  to harass, dox, threaten, or otherwise target
                  identifiable individuals via the search, indexing,
                  or display features of the explorer;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  to evade sanctions, export controls, or any other
                  trade-restriction regime applicable to you;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  to misrepresent the explorer&rsquo;s output as
                  &ldquo;qualified&rdquo;, &ldquo;certified&rdquo;,
                  or otherwise carrying any presumption of legal
                  weight beyond what eIDAS Article 41(1) provides for
                  non-qualified electronic timestamps;
                </Typography>
                <Typography component="li" variant="body1" gutterBottom>
                  to circumvent display-moderation decisions made
                  under the discretion described above (for example,
                  by re-injecting redacted records back into derived
                  feeds presented as the explorer&rsquo;s output).
                </Typography>
              </Box>
              <Typography gutterBottom variant="body1">
                The operator may rate-limit, gate, or terminate any
                access for actual, suspected, or pattern-of-conduct
                violations of this section, with or without notice.
              </Typography>
            </Box>

            <Box id="user-content" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                User-submitted content
              </Typography>
              <Typography gutterBottom variant="body1">
                Gridcoin transactions can carry user-supplied payloads:
                claim contracts, polls, beacons, free-form messages,
                and other contract types. We display this content as
                it was recorded on-chain, including its original
                casing, formatting, and language.
              </Typography>
              <Typography gutterBottom variant="body1">
                We do not pre-screen submissions, we cannot edit or
                remove individual records from the chain, and we make
                no representation about the truth, legality, or
                appropriateness of any user-supplied content. The
                explorer&rsquo;s display is a rendering of public
                chain state; the chain itself is not under the
                operator&rsquo;s control.
              </Typography>

              <Typography variant="h6" component="h3" id="takedown" sx={{ pt: 2, pb: 1 }}>
                Notice &amp; action
              </Typography>
              <Typography gutterBottom variant="body1">
                If you believe content surfaced by this explorer is
                illegal in your jurisdiction, infringes your
                intellectual-property rights, defames you, contains
                personal data about you that you wish to be removed
                from this explorer&rsquo;s display, or otherwise
                warrants moderation, write to
                {' '}
                <NextMuiLink href={`mailto:${CONTACT_EMAIL}`} prose>
                  {CONTACT_EMAIL}
                </NextMuiLink>
                {' '}
                with: the URL of the page on which the content is
                shown, the on-chain reference (transaction id, block
                height, address, payload), a description of why it
                should be moderated, and (for IP and personal-data
                cases) a statement of your authority to make the
                request.
              </Typography>
              <Typography gutterBottom variant="body1">
                The operator will review credible notices and may, at
                its sole discretion, omit, redact, replace, or filter
                the affected record from this explorer&rsquo;s
                display. Removal from the explorer does not remove
                the data from the Gridcoin chain itself, which is
                outside the operator&rsquo;s control.
              </Typography>
            </Box>

            <Box id="privacy" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Privacy and personal data
              </Typography>
              <Typography gutterBottom variant="body1">
                The explorer collects the bare minimum needed to
                operate. There are no accounts, no email addresses,
                no real names, and no submissions that could carry
                personal data. Operational logs (IP address,
                user-agent, request timing) are retained on a rolling
                window for security, abuse prevention, and capacity
                planning, then deleted.
              </Typography>
              <Typography gutterBottom variant="body1">
                <b>Personal data on the chain.</b>
                {' '}
                Wallet addresses can be linkable to identifiable
                persons in some cases, and free-form chain payloads
                can contain identifiers. Per the European Data
                Protection Board&rsquo;s Guidelines 02/2025 on
                processing personal data through blockchain
                technologies, the operator of this explorer may be a
                controller of personal data for the act of indexing,
                searching, and displaying public chain content.
              </Typography>
              <Typography gutterBottom variant="body1">
                <b>Right to erasure.</b>
                {' '}
                Where you have a right to erasure under GDPR Article
                17 or an equivalent regime, the operator can remove
                the affected record from this explorer&rsquo;s local
                index and from search results, subject to the
                legitimate-interest balancing in Article 17(3) (for
                example, the public interest in being able to verify
                a chain history). The operator <i>cannot</i> remove
                the record from the Gridcoin chain — the chain is
                permissionless, decentralised, and not under the
                operator&rsquo;s control. Other explorers and other
                Gridcoin nodes will continue to surface the same
                data. To exercise erasure rights against this
                explorer&rsquo;s display, contact
                {' '}
                <NextMuiLink href={`mailto:${CONTACT_EMAIL}`} prose>
                  {CONTACT_EMAIL}
                </NextMuiLink>
                .
              </Typography>
              <Typography gutterBottom variant="body1">
                <b>BOINC display names.</b>
                {' '}
                To make researcher pages legible, the explorer mirrors
                BOINC project user-stats from each whitelisted
                project&rsquo;s public {' '}
                <code>stats/user.gz</code>
                {' '}
                export. These exports are published by the projects
                themselves and contain the display name a user chose
                to publish in their BOINC profile. The explorer
                resolves a CPID to that name on the CPID detail page
                and in global search. If you wish to have your name
                excluded from this resolution while keeping it
                published on the BOINC project itself, write to
                {' '}
                <NextMuiLink href={`mailto:${CONTACT_EMAIL}`} prose>
                  {CONTACT_EMAIL}
                </NextMuiLink>
                {' '}
                with your CPID; we add it to a community-maintained
                denylist and the next ingest cycle replaces the name
                with &ldquo;Anonymous&rdquo;.
              </Typography>
              <Typography gutterBottom variant="body1">
                <b>Lawful requests.</b>
                {' '}
                The operator will respond to lawful requests from
                competent authorities to the extent technically
                possible. The operator does not collect submitter
                identifiers and so has no submitter PII to disclose;
                the on-chain record is outside the operator&rsquo;s
                technical control.
              </Typography>
            </Box>

            <Box id="asis" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Use at your own risk
              </Typography>
              <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
                The explorer is provided <strong>&quot;as is&quot;</strong> and
                <strong> &quot;as available&quot;</strong>, without warranty
                of any kind (express, implied, or statutory), including,
                without limitation, warranties of merchantability, fitness
                for a particular purpose, accuracy, completeness, title, or
                non-infringement.
              </Alert>
              <Typography gutterBottom variant="body2" component="p" sx={capsMono}>
                Without limiting the foregoing, the operator
                disclaims any warranty that the service will be
                uninterrupted, error-free, secure, free of malware,
                resilient against blockchain forks or
                reorganisations, or that any defect will be
                corrected. The operator does not warrant the
                operation, security, or continuity of the Gridcoin
                network, of any wallet daemon, fiat-rate provider,
                search backend, hosting provider, or any other
                third-party dependency.
              </Typography>

              <Typography variant="h6" component="h3" id="accuracy" sx={{ pt: 2, pb: 1 }}>
                No accuracy guarantee
              </Typography>
              <Typography gutterBottom variant="body1">
                We do not guarantee that the data shown is correct,
                current, complete, or free from indexing errors,
                transient outages, chain-reorg artefacts, or
                misclassifications. Balances, magnitudes, fee charts,
                and aggregate metrics may diverge from the true chain
                state for short or long periods.
              </Typography>
              <Typography gutterBottom variant="body1">
                Do not rely on this explorer for financial, legal,
                accounting, tax, or operational decisions. Cross-check
                anything that matters against a trusted Gridcoin full
                node before acting on it.
              </Typography>
            </Box>

            <Box id="liability" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                No liability
              </Typography>
              <Typography gutterBottom variant="body2" component="p" sx={capsMono}>
                To the maximum extent permitted by applicable law,
                the operators, contributors, and hosts of this
                service shall not be liable for any direct, indirect,
                incidental, special, consequential, exemplary, or
                punitive damages (including, without limitation, lost
                profits, lost data, lost case outcomes, lost
                opportunities, business interruption, or service
                disruption) arising out of or in connection with your
                use of, or inability to use, this explorer, even if
                advised of the possibility of such damages.
              </Typography>
              <Typography gutterBottom variant="body2" component="p" sx={capsMono}>
                Without limiting the foregoing, the operator will not
                be liable for: (i) damages arising from reliance on
                explorer output in any dispute, transaction,
                proceeding, or publication; (ii) failures, forks,
                reorgs, or attacks on the Gridcoin network; (iii)
                outages or errors of any wallet, search backend,
                hosting provider, or other third-party dependency;
                (iv) consequences of moderation decisions, including
                omitting, redacting, replacing, or filtering any
                record from this explorer&rsquo;s display.
              </Typography>
              <Typography gutterBottom variant="body1">
                Nothing in these Terms excludes or limits liability
                that cannot lawfully be excluded or limited,
                including liability for death or personal injury
                caused by negligence, fraud, fraudulent
                misrepresentation, or any non-waivable
                consumer-protection right under the law of your
                habitual residence. You access and use the service at
                your sole risk and are solely responsible for any
                loss or harm that may result.
              </Typography>
            </Box>

            <Box id="no-advice" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                No financial advice
              </Typography>
              <Typography gutterBottom variant="body1">
                Nothing on this site constitutes financial,
                investment, trading, tax, legal, or any other form of
                professional advice. Magnitudes, balances, fee
                charts, leaderboards, and metrics are presented for
                informational and research purposes only. You are
                solely responsible for any decisions you make using
                this information.
              </Typography>
            </Box>

            <Box id="third-parties" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Third-party services
              </Typography>
              <Typography gutterBottom variant="body1">
                The explorer interfaces with third-party software
                (Gridcoin Research wallet, search backends, hosting
                providers, analytics, and others). Their availability,
                behaviour, and licensing terms are governed by their own
                publishers; we make no representations about them and
                accept no responsibility for their conduct or output.
              </Typography>
            </Box>

            <Box id="indemnification" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Indemnification
              </Typography>
              <Typography gutterBottom variant="body1">
                You will defend, indemnify, and hold harmless the
                operator, the explorer maintainers, the
                gridcoin.club family contributors, and their
                respective agents from and against any claim, demand,
                investigation, proceeding, loss, damage, cost, or
                expense (including reasonable legal fees) arising out
                of or relating to: (a) your use of the Service; (b)
                your breach of these Terms; (c) your violation of any
                law, regulation, or third-party right; or (d) any
                use of explorer output to harm, harass, or defame any
                third party.
              </Typography>
            </Box>

            <Box id="governing-law" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Governing law
              </Typography>
              <Typography gutterBottom variant="body1">
                These Terms, and any dispute arising out of them or
                out of your use of the Service, are governed by the
                laws of {GOVERNING_LAW}, without regard to
                conflict-of-laws principles. The courts of
                {' '}
                {GOVERNING_LAW}
                {' '}
                have exclusive jurisdiction.
              </Typography>
              <Typography gutterBottom variant="body1">
                If you are a consumer habitually resident in the
                European Union, the United Kingdom, or another
                jurisdiction whose consumer-protection law cannot
                lawfully be displaced by contract, you also retain the
                protections of the mandatory law of your residence
                and may bring claims in the courts of your residence
                to the extent that law requires.
              </Typography>
            </Box>

            <Box id="changes" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Changes
              </Typography>
              <Typography gutterBottom variant="body1">
                These Terms may be updated from time to time. The
                current version is always the one served at this URL,
                with the effective date below. Your continued use of
                the explorer after a change constitutes acceptance of
                the updated Terms.
              </Typography>
            </Box>

            <Box id="contact" sx={{ pb: 4 }}>
              <Typography variant="h5" component="h2" sx={{ pb: 2 }}>
                Contact
              </Typography>
              <Typography gutterBottom variant="body1">
                General queries, abuse reports, IP-infringement
                notices, defamation notices, EDPB Article 17 erasure
                requests, lawful-process correspondence, and DSA
                Article 11 / 12 / 16 contact:{' '}
                <NextMuiLink href={`mailto:${CONTACT_EMAIL}`} prose>
                  {CONTACT_EMAIL}
                </NextMuiLink>
                . The operator accepts service of process and
                authority correspondence in English at this address.
              </Typography>
            </Box>

            <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
              <AlertTitle>Heads up</AlertTitle>
              The explorer is approaching its public mainnet launch.
              These Terms are effective from the date below and apply
              both to the current testnet preview and to the public
              mainnet release.
            </Alert>

            <Divider sx={{ my: 4 }} />
            <Typography variant="caption" color="text.secondary" component="p">
              Effective date: {EFFECTIVE_DATE}
            </Typography>
          </Grid>
        </Grid>
      </Container>
    </Layout>
    </>
  );
}
