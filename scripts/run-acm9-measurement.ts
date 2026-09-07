import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const USAGE =
  'Usage: npm run measure:access-control:acm9 -- --role baseline|final [--baseline <path>]';

const args = process.argv.slice(2);
let role: string | undefined;
let baseline: string | undefined;
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (value === undefined) throw new Error(USAGE);
  if (args[i] === '--role') role = value;
  else if (args[i] === '--baseline') baseline = value;
  else throw new Error(USAGE);
}
if (role === undefined || !['baseline', 'final'].includes(role))
  throw new Error(USAGE);

// The `final` role compares against a PASS baseline artifact, which the spec
// reads from ACM9_BASELINE_ARTIFACT. Accepting it as a flag keeps the whole
// invocation expressible through this script; an already-exported env var still
// wins nothing and loses nothing, so both spellings work.
const baselineArtifact = baseline
  ? resolve(baseline)
  : process.env.ACM9_BASELINE_ARTIFACT;
if (role === 'final' && !baselineArtifact)
  throw new Error(`ACM9 final needs a PASS baseline artifact. ${USAGE}`);

const result = spawnSync(
  process.execPath,
  [
    'node_modules/jest/bin/jest.js',
    '--config',
    './test/jest-acm9.json',
    '--runInBand',
    'test/measurement/acm9/acm9-baseline.measurement-spec.ts',
  ],
  {
    env: {
      ...process.env,
      ACM9_ROLE: role,
      ...(baselineArtifact ? { ACM9_BASELINE_ARTIFACT: baselineArtifact } : {}),
      NODE_OPTIONS: '--experimental-vm-modules',
    },
    stdio: 'inherit',
  },
);
process.exitCode = result.status ?? 1;
