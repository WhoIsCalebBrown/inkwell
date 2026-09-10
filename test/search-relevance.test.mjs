// Search ranking has been wrong in three separate ways, all of which looked
// plausible on screen: ComicVine's own search matches deck text and
// relationships, so "wolverine" returned Sabretooth and X-23; "x-men" was torn
// into "x" and "men" and returned characters called Ten; and because the only
// sort was by issue appearances -- which teams do not have -- the real X-Men
// lost to 3K X-Men. These assert what a reader means by typing a name.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storeUrl = new URL('../store.js', import.meta.url).href;

// A catalogue with exactly the shapes that used to rank wrongly.
const CATALOGUE = [
  { id: 1, name: 'Wolverine', resource_type: 'character', count_of_issue_appearances: 16933, image: { medium_url: 'x' } },
  { id: 2, name: 'Sabretooth', resource_type: 'character', count_of_issue_appearances: 3713, image: { medium_url: 'x' } },
  { id: 3, name: 'X-23', resource_type: 'character', count_of_issue_appearances: 2485, image: { medium_url: 'x' } },
  { id: 4, name: 'Wolverine Clone', resource_type: 'character', count_of_issue_appearances: 3, image: { medium_url: 'x' } },
  { id: 5, name: 'Batman', resource_type: 'character', count_of_issue_appearances: 25132, aliases: 'Bruce Wayne\nThe Dark Knight', image: { medium_url: 'x' } },
  { id: 6, name: 'Dick Grayson', resource_type: 'character', count_of_issue_appearances: 10236, image: { medium_url: 'x' } },
  { id: 7, name: 'X-Men', resource_type: 'team', image: { medium_url: 'x' } },
  { id: 8, name: '3K X-Men', resource_type: 'team', image: { medium_url: 'x' } },
  { id: 9, name: 'Wolverine Squad', resource_type: 'team', image: { medium_url: 'x' } },
  { id: 10, name: '"Green Lantern" Blackest Night', resource_type: 'story_arc', image: { medium_url: 'x' } },
];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// No COMICVINE_API_KEY: the remote half stays out of it, so this measures the
// ranking rather than the provider. Both sources are scored the same way.
async function withServer(run) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-search-'));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const store = await import(${JSON.stringify(storeUrl)});
      store.rememberObjects('search', ${JSON.stringify(CATALOGUE)});
      store.close();
    `], { cwd: root, env: { ...process.env, CONFIG_DIR: configDir }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seeding failed: ${stderr}`))));
  });

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CONFIG_DIR: configDir, MYLAR_CONFIG: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(500) });
        if (ready.ok) break;
      } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await run(async (q) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/threads?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5_000) });
      const { groups } = await response.json();
      return Object.fromEntries(groups.map((group) => [group.kind, group.items.map((item) => item.name)]));
    });
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test('a name search returns what is called that, not what is related to it', async () => {
  await withServer(async (search) => {
    const wolverine = await search('wolverine');
    assert.equal(wolverine.character?.[0], 'Wolverine');
    // The whole complaint: none of these are called Wolverine.
    for (const wrong of ['Sabretooth', 'X-23']) {
      assert.ok(!wolverine.character?.includes(wrong), `${wrong} is not called Wolverine`);
    }
    // A three-appearance clone is genuinely named Wolverine and still not who
    // anyone meant once the real one is on screen.
    assert.ok(!wolverine.character?.includes('Wolverine Clone'), 'an unknown variant outranked nothing');

    const batman = await search('batman');
    assert.equal(batman.character?.[0], 'Batman');
    assert.ok(!batman.character?.includes('Dick Grayson'), 'a Robin who wore the cowl is not Batman');
  });
});

test('an exact match decides which kinds are worth showing at all', async () => {
  await withServer(async (search) => {
    // The team is exactly what was asked for, so Teams belongs -- and the real
    // one leads, despite no team carrying an appearance count to sort on.
    const xmen = await search('x-men');
    assert.equal(xmen.team?.[0], 'X-Men');

    // Nothing is exactly called Wolverine except the character, so a Teams
    // shelf holding only Wolverine Squad is noise beside it.
    const wolverine = await search('wolverine');
    assert.ok(!wolverine.team, 'a partial-match section survived beside an exact match');
  });
});

test('an alias still reaches the character when nothing carries the name', async () => {
  await withServer(async (search) => {
    assert.equal((await search('bruce wayne')).character?.[0], 'Batman');
    // ComicVine prefixes an arc with its parent title in quotes; matching has
    // to see through that or an arc never matches its own name.
    assert.equal((await search('blackest night')).story_arc?.[0], 'Blackest Night');
  });
});
