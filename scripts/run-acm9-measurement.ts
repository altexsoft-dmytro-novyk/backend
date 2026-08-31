import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--role' || !['baseline', 'final'].includes(args[1])) {
  throw new Error('Usage: npm run measure:access-control:acm9 -- --role baseline|final');
}

const result = spawnSync(
  process.execPath,
  ['node_modules/jest/bin/jest.js', '--config', './test/jest-acm9.json', '--runInBand', 'test/measurement/acm9/acm9-baseline.measurement-spec.ts'],
  { env: { ...process.env, ACM9_ROLE: args[1], NODE_OPTIONS: '--experimental-vm-modules' }, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
