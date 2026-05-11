// Manual trigger for the nightly BOINC user-stats import. Useful when
// the user wants names available now instead of waiting for the next
// scheduled tick (worst case ~1h to start, ~20h before a successful
// import is allowed to repeat).
//
// Usage:
//   npm run boinc:fetch
//   npm run boinc:fetch -- --force       # ignore the 20h cooldown
//   npm run boinc:fetch -- --project X   # restrict to one project
//   npm run boinc:fetch -- --help
//
// Runs in the same process as the explorer, so it shares the same
// ClickHouse / Redis / Meili clients and respects the wipe-lock the
// scheduler also honors.

import { config } from '../config';
import { log } from '../lib/log';
import {
  redis, redisStreams, redisSub, redisPub,
} from '../lib/redis';
import { BoincStatsImportJob } from '../services/jobs/BoincStatsImportJob';

interface Args {
  force: boolean;
  project: string | null;
  help: boolean;
}

function printHelp(): void {
  console.log(`Usage: npm run boinc:fetch -- [options]

Manually trigger the BOINC user-stats import job. Streams each
whitelisted project's user.gz export and upserts CPID → display-name
rows into project_users. Indexed for global search via the
cpid_names Meili index.

Options:
  --force                Ignore the 20h re-import cooldown (per project).
  --project NAME         Restrict to one whitelisted project (substring
                         match on project_name, case-insensitive).
  -h, --help             Show this message and exit.

Network: ${config.NETWORK}
`);
}

function parseArgs(argv: string[]): Args {
  let force = false;
  let project: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--project') {
      const value = argv[i + 1];
      if (!value) throw new Error('--project requires a project name (substring match)');
      project = value;
      i += 1;
    } else if (arg.startsWith('--project=')) {
      [, project] = arg.split('=', 2);
    } else {
      throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
  }
  return { force, project, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  log.info(`fetchBoincNames: starting (force=${args.force}, project=${args.project ?? 'all'})`);
  const job = new BoincStatsImportJob({
    force: args.force,
    projectFilter: args.project,
  });
  await job.tick();
  log.info('fetchBoincNames: done');
}

main()
  .catch((err) => {
    log.error('fetchBoincNames failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close every Redis socket lib/redis.ts opened so node can exit
    // cleanly. Same dance wipeExplorer / rebuildWallets do.
    await Promise.all([
      redis.quit(),
      redisStreams.quit(),
      redisSub.quit(),
      redisPub.quit(),
    ]);
  });
