import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const USAGE =
  'Usage: npm run measure:user-management:dira1 -- --role baseline|final [--baseline <path>]';

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

const baselineArtifact = baseline
  ? resolve(baseline)
  : process.env.DIRA1_BASELINE_ARTIFACT;
if (role === 'final' && !baselineArtifact)
  throw new Error(`DIRA1 final needs a PASS baseline artifact. ${USAGE}`);

const result = spawnSync(
  process.execPath,
  [
    'node_modules/jest/bin/jest.js',
    '--config',
    './test/jest-dira1.json',
    '--runInBand',
    'test/measurement/dira1/dira1-baseline.measurement-spec.ts',
  ],
  {
    env: {
      ...process.env,
      DIRA1_ROLE: role,
      ...(baselineArtifact ? { DIRA1_BASELINE_ARTIFACT: baselineArtifact } : {}),
      NODE_OPTIONS: '--experimental-vm-modules',
    },
    stdio: 'inherit',
  },
);
process.exitCode = result.status ?? 1;
