import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ACM9_PROTOCOL = 'ACM9-MVP-v1';
export const ACM9_MANIFEST = 'ACM9-MANIFEST-v1';
export type RunRole = 'baseline' | 'final';
export type ArtifactStatus = 'PASS' | 'FAIL' | 'INCOMPLETE';

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
export type ReservedArtifact = { path: string; runId: string; role: RunRole };

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const numberJson = (value: number): string => {
  if (
    !Number.isFinite(value) ||
    (!Number.isSafeInteger(value) && Math.floor(value) === value)
  )
    throw new Error(
      'Manifest numbers must be finite safe integers or decimals',
    );
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
};

/** Canonical ACM9-MANIFEST-v1 JSON: compact UTF-8 JSON, sorted keys and fixed decimals. */
export const canonicalJson = (value: Json): string => {
  if (value === null) return 'null';
  if (typeof value === 'number') return numberJson(value);
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
};

export const manifestHash = (manifest: Json): string =>
  createHash('sha256')
    .update(Buffer.from(canonicalJson(manifest), 'utf8'))
    .digest('hex');
export const nearestRank = (values: number[], percentile: number): number => {
  if (values.length === 0)
    throw new Error('Cannot calculate a percentile of no samples');
  if (percentile <= 0 || percentile > 1)
    throw new Error('Percentile must be in (0, 1]');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentile) - 1];
};

export const resolveStatus = ({
  breach,
  comparable,
}: {
  breach: unknown | null;
  comparable: boolean;
}): ArtifactStatus =>
  breach !== null ? 'FAIL' : comparable ? 'PASS' : 'INCOMPLETE';

export const reserveArtifact = async (
  directory: string,
  role: RunRole,
  runId: string,
): Promise<ReservedArtifact> => {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `acm9-${role}-${runId}.json`);
  const handle = await open(path, 'wx');
  try {
    const timestamp = new Date().toISOString();
    await handle.writeFile(
      `${JSON.stringify({ run_id: runId, role, protocol_version: ACM9_PROTOCOL, manifest_version: ACM9_MANIFEST, status: 'INCOMPLETE', created_at: timestamp, updated_at: timestamp, stop_reason: 'pending' })}\n`,
      'utf8',
    );
  } finally {
    await handle.close();
  }
  return { path, role, runId };
};

export const readArtifact = async (
  path: string,
): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
export const finalizeArtifact = async (
  reserved: ReservedArtifact,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const current = await readArtifact(reserved.path);
  const final = { ...current, ...patch, updated_at: new Date().toISOString() };
  const temporary = `${reserved.path}.finalizing`;
  await writeFile(temporary, `${JSON.stringify(final)}\n`, 'utf8');
  await rename(temporary, reserved.path);
  return final;
};

export const isCompatibleBaseline = (
  baseline: Record<string, unknown> | null,
  expected: {
    protocolVersion: string;
    fixtureHash: string;
    environmentHash: string;
  },
): boolean =>
  baseline?.status === 'PASS' &&
  baseline.protocol_version === expected.protocolVersion &&
  baseline.fixture_manifest_hash === expected.fixtureHash &&
  baseline.environment_manifest_hash === expected.environmentHash;
