// The release path spans four files that must agree: the Dockerfile that gets
// built, the workflow that publishes it, the Compose file people deploy, and
// the Unraid template that pulls it. Nothing at runtime notices when they
// drift, and the failure lands on a stranger's server, so it is checked here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const composeDev = read('docker-compose.dev.yml');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
const template = read('unraid/inkwell.xml');

const IMAGE = 'ghcr.io/whoiscalebbrown/inkwell';

// Unraid template <Config> lines, as attribute maps.
const templateConfigs = [...template.matchAll(/<Config\s([^>]*?)>([^<]*)<\/Config>/g)].map(([, attrs, value]) => {
  const config = Object.fromEntries([...attrs.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, val]) => [key, val]));
  return { ...config, value: value.trim() };
});

test('the published image is named identically everywhere it is consumed', () => {
  // GHCR rejects an uppercase path, and the owner's login is mixed case.
  assert.equal(IMAGE, IMAGE.toLowerCase());
  assert.match(compose, new RegExp(`image:\\s*${IMAGE}:\\$\\{INKWELL_VERSION:-latest\\}`));
  assert.match(template, new RegExp(`<Repository>${IMAGE}:latest</Repository>`));
  // The workflow derives the name from the repository rather than repeating
  // it, so assert the derivation instead of the literal.
  assert.match(release, /name=ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}/);
});

test('the deployment Compose file pulls a release and the dev override builds', () => {
  assert.doesNotMatch(compose, /^\s*build:/m, 'the deployed Compose file must not build from source');
  assert.match(composeDev, /^\s*build:\s*\.$/m);
  // Without this, `up` on a machine with no local inkwell:dev would try the
  // registry for a tag that is never published.
  assert.match(composeDev, /pull_policy:\s*build/);
});

test('only a version tag publishes, and a prerelease never moves a stable tag', () => {
  const trigger = release.slice(release.indexOf('on:'), release.indexOf('permissions:'));
  assert.match(trigger, /tags:/);
  assert.doesNotMatch(trigger, /branches:/, 'a push to a branch must never publish a release');
  assert.match(trigger, /v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+/);

  // latest, {{major}} and {{major}}.{{minor}} are the tags a prerelease would
  // wrongly claim. Each is gated on the tag carrying no -suffix.
  const guard = /enable=\$\{\{ !contains\(github\.ref_name, '-'\) \}\}/g;
  assert.equal(release.match(guard)?.length, 2, 'both moving semver aliases must be gated on the tag not being a prerelease');
  assert.match(release, /latest=\$\{\{ !contains\(github\.ref_name, '-'\) \}\}/);
  assert.match(release, /type=semver,pattern=\{\{version\}\}/);
});

test('the release publishes both architectures and reuses the pull-request checks', () => {
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/, 'a tag must run the same checks a pull request runs');
  assert.match(release, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(ci, /workflow_call:/, 'CI must be callable, or the release would duplicate it');
  assert.match(ci, /platforms:\s*linux\/amd64,linux\/arm64/, 'CI must prove both architectures build before a tag does');
  // GITHUB_TOKEN only; a release must not depend on a hand-made secret.
  assert.match(release, /password:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(release, /secrets\.(?!GITHUB_TOKEN)[A-Z_]+/);
});

test('the image carries the metadata a registry and a rollback need', () => {
  for (const label of ['title', 'description', 'source', 'licenses']) {
    assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.${label}=`), `Dockerfile is missing the ${label} label`);
  }
  // version, revision and created can only be known at release time.
  assert.match(release, /uses:\s*docker\/metadata-action@v5/);
  assert.match(dockerfile, /^FROM node:\d+\.\d+\.\d+-alpine$/m, 'the base image must stay pinned to an exact version');
});

test('the Unraid template keeps /config on the host and lets Unraid see a new digest', () => {
  const appdata = templateConfigs.find((config) => config.Target === '/config');
  assert.equal(appdata?.Type, 'Path', '/config must be a host path, not a variable');
  assert.equal(appdata?.Mode, 'rw');
  assert.equal(appdata?.Required, 'true');
  assert.ok(appdata?.value.startsWith('/mnt/'), '/config must default to Unraid appdata on the array');

  const mylar = templateConfigs.find((config) => config.Target === '/run/mylar');
  assert.equal(mylar?.Mode, 'ro', "Mylar's appdata is an input, never something Inkwell writes to");

  // Unraid offers Update when the digest behind this tag changes. A pinned
  // version, or a digest, would never move.
  const repository = template.match(/<Repository>(.+?)<\/Repository>/)[1];
  assert.match(repository, /:latest$/);
  assert.doesNotMatch(repository, /@sha256:/);

  // Unraid replaces [PORT:n] with the host port published from container port
  // n. Naming the default host port instead silently breaks the WebUI link for
  // anyone who changes it.
  const containerPort = templateConfigs.find((config) => config.Type === 'Port')?.Target;
  assert.match(template, new RegExp(`<WebUI>http://\\[IP\\]:\\[PORT:${containerPort}\\]</WebUI>`));
  assert.match(compose, new RegExp(`net\\.unraid\\.docker\\.webui:\\s*http://\\[IP\\]:\\[PORT:${containerPort}\\]`));
  assert.equal(containerPort, '3000');

  // A blob URL serves HTML, so a template refresh would fetch a web page.
  assert.match(template, /<TemplateURL>https:\/\/raw\.githubusercontent\.com\/.+\.xml<\/TemplateURL>/);

  // Every variable the template offers must be one something actually reads:
  // the server, the store, or the entrypoint that owns /config.
  // Read the modules the image actually ships, taken from the Dockerfile so a
  // new runtime file is covered without editing this test.
  const shipped = dockerfile.match(/^COPY ((?:\S+\.js )+)\.\/$/m)[1].trim().split(/\s+/);
  const consumers = [...shipped, 'docker-entrypoint.sh'].map(read).join('\n');
  const unread = templateConfigs
    .filter((entry) => entry.Type === 'Variable')
    .map((entry) => entry.Target)
    .filter((name) => !new RegExp(`(process\\.env\\.${name}\\b|\\$\\{${name}:)`).test(consumers));
  assert.deepEqual(unread, [], 'the template offers variables nothing reads');
});
