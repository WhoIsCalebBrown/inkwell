// Provider-free smoke test for the stable Inkwell HTTP contract.
// Run inside the container after a rebuild, or point PANEL_URL at a deployment.

const base = String(process.env.PANEL_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const checks = [
  ['ready', '/api/ready', 200, (body) => body.ok === true],
  ['empty thread search', '/api/threads', 200, (body) => Array.isArray(body.groups) && body.total === 0],
  ['browse thread index', '/api/threads/browse', 200, (body) => Array.isArray(body.groups)],
  ['known lines', '/api/lines', 200, (body) => body.lines && typeof body.lines === 'object'],
  ['invalid thread kind', '/api/thread/not-a-kind/1', 400, (body) => /unknown thread kind/i.test(body.error || '')],
  ['invalid volume id', '/api/volume/not-a-number', 400, (body) => /numeric/i.test(body.error || '')],
  ['invalid cover id', '/api/cover/not-a-number', 400, () => true],
];

const failures = [];
for (const [name, path, expectedStatus, assertion] of checks) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({}));
    if (response.status !== expectedStatus || !assertion(body)) {
      failures.push({ name, status: response.status, expectedStatus, body });
    }
  } catch (error) {
    failures.push({ name, error: error.message });
  }
}

console.log(JSON.stringify({ base, checks: checks.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
