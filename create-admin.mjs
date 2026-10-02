// Run inside the Inkwell container with /config mounted, before enabling
// INKWELL_ACCESS_MODE=multi. Password input is never a command-line argument.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { createFirstAdmin } from './membership.js';
import { close } from './store.js';

const rl = createInterface({ input: stdin, output: stdout });
if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
try {
  const username = await rl.question('Admin username: ');
  const displayName = await rl.question('Display name (optional): ');
  execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
  const password = await rl.question('Password (5–256 characters): ');
  execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
  stdout.write('\n');
  await createFirstAdmin(username, displayName, password);
  stdout.write('Administrator created. You can now enable INKWELL_ACCESS_MODE=multi.\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] }); } catch { /* terminal may have closed */ }
  rl.close();
  close();
}
