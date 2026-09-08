// Production-image clean-install regression test. It intentionally uses the
// Dockerfile rather than the developer Compose project so it can run in CI
// before image publishing. It exercises both a Docker volume and the bind
// mount layout Unraid/NAS users need.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suffix = `${process.pid}-${Date.now()}`;
const image = `inkwell-smoke:${suffix}`;
// A second build stands in for the next release: same source, different image.
const nextImage = `inkwell-smoke-next:${suffix}`;
const uid = '12345';
const gid = '12346';
const volume = `inkwell-smoke-config-${suffix}`;
const bindDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-bind-smoke-'));
const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-restore-smoke-'));
const placeholderMylar = path.join(root, 'config', 'mylar-placeholder');
const placeholderKomf = path.join(root, 'config', 'komf-placeholder.yml');
const containers = [];

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { encoding: 'utf8' });
  return result.status === 0;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReady(name) {
  const port = docker(['port', name, '3000/tcp']).match(/:(\d+)$/m)?.[1];
  assert.ok(port, `could not discover published port for ${name}`);
  const url = `http://127.0.0.1:${port}/api/ready`;
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body.ok) return;
      lastError = new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    await pause(500);
  }
  throw new Error(`container ${name} never became ready: ${lastError?.message}`);
}

function start(name, configMount, from = image) {
  containers.push(name);
  docker([
    'run', '-d', '--name', name,
    '--read-only', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::3000',
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', 'UMASK=002',
    '-v', `${configMount}:/config`,
    '-v', `${placeholderMylar}:/run/mylar:ro`,
    '-v', `${placeholderKomf}:/run/komf/application.yml:ro`,
    from,
  ]);
}

function stop(name) {
  docker(['stop', '-t', '20', name]);
  docker(['rm', name]);
  containers.splice(containers.indexOf(name), 1);
}

function writeMarker(name) {
  docker([
    'exec', '-u', `${uid}:${gid}`, name, 'node', '--input-type=module', '-e',
    "const store = await import('./store.js'); store.write('docker-smoke', { survives: true }); store.close();",
  ]);
}

function readMarker(name) {
  const output = docker([
    'exec', '-u', `${uid}:${gid}`, name, 'node', '--input-type=module', '-e',
    "const store = await import('./store.js'); console.log(JSON.stringify(store.read('docker-smoke'))); store.close();",
  ]);
  assert.match(output, /"survives":true/);
}

async function verifyPersistentMount(label, mount) {
  const first = `inkwell-smoke-${label}-first-${suffix}`;
  start(first, mount);
  await waitForReady(first);
  const pidUid = docker(['exec', first, 'sh', '-c', "awk '/^Uid:/{print $2}' /proc/1/status"]);
  assert.equal(pidUid, uid, `${label}: Node did not run as configured PUID`);
  writeMarker(first);
  stop(first);

  // A boring stop-and-copy restore is the public backup contract. Exercise it
  // against the bind layout used by Unraid/NAS, including SQLite's companion
  // WAL/SHM files if a platform leaves them behind after a clean stop.
  if (label === 'bind') {
    fs.cpSync(bindDir, restoreDir, { recursive: true, force: true });
    fs.rmSync(bindDir, { recursive: true, force: true });
    fs.mkdirSync(bindDir, { recursive: true });
    fs.cpSync(restoreDir, bindDir, { recursive: true, force: true });
  }

  const second = `inkwell-smoke-${label}-second-${suffix}`;
  start(second, mount);
  await waitForReady(second);
  readMarker(second);
  stop(second);
}

// The whole promise of the release path: pressing Update on Unraid, or running
// `docker compose pull && docker compose up -d`, replaces the image and
// recreates the container while /config stays exactly where it is. The label
// makes the second build a genuinely different image, the way a release is.
async function verifyImageReplacement(mount) {
  docker(['build', '--pull=false', '--label', `org.opencontainers.image.version=0.0.0-next-${suffix}`, '-t', nextImage, '.']);
  assert.notEqual(
    docker(['image', 'inspect', '--format', '{{.Id}}', nextImage]),
    docker(['image', 'inspect', '--format', '{{.Id}}', image]),
    'the replacement build produced the same image, so this proves nothing',
  );

  const updated = `inkwell-smoke-updated-${suffix}`;
  start(updated, mount, nextImage);
  await waitForReady(updated);
  readMarker(updated);
  stop(updated);
}

if (!dockerAvailable()) {
  throw new Error('Docker daemon is unavailable. Start Docker or grant this user daemon access before running this smoke test.');
}

try {
  docker(['build', '--pull=false', '-t', image, '.']);
  await verifyPersistentMount('volume', volume);
  await verifyPersistentMount('bind', bindDir);
  await verifyImageReplacement(bindDir);
  assert.ok(fs.existsSync(path.join(bindDir, 'cache.db')), 'bind mount did not receive SQLite database');
  const owner = fs.statSync(path.join(bindDir, 'cache.db'));
  assert.equal(String(owner.uid), uid, 'bind-mounted SQLite database has the wrong UID');
  assert.equal(String(owner.gid), gid, 'bind-mounted SQLite database has the wrong GID');
  console.log('Docker clean-install, persistence, non-root, bind-mount backup/restore, image replacement, volume, and bind-mount smoke tests passed.');
} finally {
  for (const name of containers) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  }
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  spawnSync('docker', ['image', 'rm', '-f', image, nextImage], { encoding: 'utf8' });
  fs.rmSync(bindDir, { recursive: true, force: true });
  fs.rmSync(restoreDir, { recursive: true, force: true });
}
