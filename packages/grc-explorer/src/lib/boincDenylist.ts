import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from './log';

// Community-maintained list of CPIDs whose owners have asked us not
// to mirror their BOINC name. The file is checked into the repo so
// the audit trail is public, and the request mechanism is documented
// in /disclaimer (mail gridcat@gridcoin.club).
//
// The job re-reads the file on every tick — small file, no need for
// hot-reload signalling. Missing file means "no opt-outs yet" and is
// not an error.

const DENYLIST_PATH = path.join(__dirname, '../../config/boinc-name-denylist.json');

interface DenylistFile {
  cpids: string[];
}

export async function loadNameDenylist(): Promise<Set<string>> {
  try {
    const raw = await readFile(DENYLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as DenylistFile;
    if (!parsed || !Array.isArray(parsed.cpids)) return new Set();
    const set = new Set<string>();
    for (const c of parsed.cpids) {
      if (typeof c === 'string' && /^[0-9a-f]{32}$/i.test(c)) {
        set.add(c.toLowerCase());
      }
    }
    return set;
  } catch (err) {
    // ENOENT is expected on a fresh install. Other errors get a warn
    // so a malformed JSON in the wild gets flagged but doesn't crash
    // the importer.
    const { code } = err as NodeJS.ErrnoException;
    if (code !== 'ENOENT') {
      log.warn('loadNameDenylist failed', err);
    }
    return new Set();
  }
}
