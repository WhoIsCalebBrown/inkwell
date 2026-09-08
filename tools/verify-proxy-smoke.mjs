// Root-host reverse-proxy regression test. It proves Nginx can reach the
// production image, preserve Host/Origin for write CSRF protection, and leave
// an explicit trusted-proxy policy optional. It is intentionally separate from
// the normal smoke because it needs the nginx image.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const suffix = `${process.pid}-${Date.now()}`;
const image = `inkwell-proxy-smoke:${suffix}`;
const app = `inkwell-proxy-app-${suffix}`;
const proxy = `inkwell-proxy-nginx-${suffix}`;
const network = `inkwell-proxy-net-${suffix}`;
const volume = `inkwell-proxy-config-${suffix}`;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-proxy-smoke-'));
const placeholderMylar = path.join(root, 'config', 'mylar-placeholder');
const placeholderKomf = path.join(root, 'config', 'komf-placeholder.yml');

function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function dockerAvailable() {
  return spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url) {
  let last;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) { last = error; }
    await pause(250);
  }
  throw new Error(`proxy never answered: ${last?.message}`);
}

if (!dockerAvailable()) throw new Error('Docker daemon is unavailable.');

const nginxConfig = `server {
  listen 80;
  location / {
    # The smoke reaches the proxy on loopback but models the dedicated public
    # hostname a TLS terminator presents to Inkwell.
    proxy_set_header Host inkwell.example.com;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_pass http://inkwell:3000;
  }
}
`;

try {
  fs.writeFileSync(path.join(configDir, 'default.conf'), nginxConfig);
  docker(['build', '--pull=false', '-t', image, '.']);
  docker(['network', 'create', network]);
  docker([
    'run', '-d', '--name', app, '--network', network, '--network-alias', 'inkwell',
    '-e', 'PUID=12345', '-e', 'PGID=12346', '-e', 'UMASK=002',
    '-e', 'MYLAR_URL=http://mylar.invalid/api', '-e', 'MYLAR_API_KEY=test', '-e', 'COMICVINE_API_KEY=test',
    '-v', `${volume}:/config`, '-v', `${placeholderMylar}:/run/mylar:ro`,
    '-v', `${placeholderKomf}:/run/komf/application.yml:ro`, image,
  ]);
  docker(['run', '-d', '--name', proxy, '--network', network, '-p', '127.0.0.1::80',
    '-v', `${path.join(configDir, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`, 'nginx:alpine']);
  const port = docker(['port', proxy, '80/tcp']).match(/:(\d+)$/m)?.[1];
  assert.ok(port, 'could not discover proxy port');
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/ready`);

  const headers = {
    Host: 'inkwell.example.com', Origin: 'https://inkwell.example.com',
    'Content-Type': 'application/json', 'X-Inkwell': '1',
  };
  const completed = await fetch(`${base}/api/setup/complete`, {
    method: 'POST', headers, body: JSON.stringify({ acknowledgeTrustedLan: true }),
  });
  assert.equal(completed.status, 201, await completed.text());
  const write = await fetch(`${base}/api/cache/clear`, { method: 'POST', headers });
  assert.equal(write.status, 200, await write.text());
  console.log('Nginx root-host reverse-proxy smoke test passed.');
} finally {
  for (const name of [proxy, app]) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  spawnSync('docker', ['network', 'rm', network], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  spawnSync('docker', ['image', 'rm', '-f', image], { encoding: 'utf8' });
  fs.rmSync(configDir, { recursive: true, force: true });
}
