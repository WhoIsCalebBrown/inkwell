// Captures raw Metron payloads to disk so field mapping can be written from
// observation rather than documentation.
//
// Metron blocks an IP at the TCP level for bursty traffic, so this goes through
// the same serialised client as everything else and stops at the first failure
// rather than retrying into a ban.
//
//   METRON_TOKEN=... node tools/capture-metron.mjs

import fs from 'node:fs';
import path from 'node:path';
import * as metron from '../metron.js';

const OUT = path.join(import.meta.dirname, '..', 'data', 'metron-samples');

const targets = [
  ['series-batman', () => metron.seriesByName('batman')],
  ['series-amazing-spider-man', () => metron.seriesByName('amazing spider-man')],
  ['arc-dark-web', () => metron.arcsByName('dark web')],
  ['arc-secret-wars', () => metron.arcsByName('secret wars')],
];

if (!metron.available()) {
  console.error('METRON_TOKEN is not set.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fetchOne] of targets) {
  try {
    const rows = await fetchOne();
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rows, null, 2));
    console.log(`  ${name}: ${rows.length} rows -> data/metron-samples/${name}.json`);
    if (rows.length) console.log(`    fields: ${Object.keys(rows[0]).join(', ')}`);
  } catch (error) {
    // One failure means the host is unhappy; stop rather than dig in deeper.
    console.error(`  ${name}: ${error.message}`);
    console.error('  Stopping so this does not turn into another block.');
    process.exit(1);
  }
}
