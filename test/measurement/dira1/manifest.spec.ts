import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  finalizeArtifact,
  manifestHash,
  nearestRank,
  reserveArtifact,
  resolveStatus,
  isCompatibleBaseline,
} from './manifest';

describe('DIRA1 artifact protocol', () => {
  it('canonicalizes equivalent manifests and hashes their exact UTF-8 bytes', () => {
    const left = { z: null, a: { gate: 'default-first-page', value: 1.2 }, count: 500 };
    const right = { count: 500, a: { value: 1.2, gate: 'default-first-page' }, z: null };
    expect(canonicalJson(left)).toBe(
      '{"a":{"gate":"default-first-page","value":1.200},"count":500,"z":null}',
    );
    expect(manifestHash(left)).toBe(manifestHash(right));
    expect(manifestHash(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses nearest-rank percentiles', () => {
    expect(nearestRank([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(nearestRank([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it('reserves a unique incomplete artifact before finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dira1-'));
    const reserved = await reserveArtifact(directory, 'baseline', 'run-a');
    await expect(
      reserveArtifact(directory, 'baseline', 'run-a'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    const initial = JSON.parse(await readFile(reserved.path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(initial.status).toBe('INCOMPLETE');
    expect(initial.protocol_version).toBe('DIRA1-MVP-v1');
    expect(initial.manifest_version).toBe('DIRA1-MANIFEST-v1');
    const finalized = await finalizeArtifact(reserved, {
      status: 'PASS',
      stop_reason: 'completed',
    });
    expect(finalized.status).toBe('PASS');
  });

  it('preserves the first breach and gives it FAIL precedence over a mismatch', () => {
    expect(
      resolveStatus({
        breach: { gate: 'filtered-deep-page', reason: 'p95_ms' },
        comparable: false,
      }),
    ).toBe('FAIL');
    expect(resolveStatus({ breach: null, comparable: false })).toBe(
      'INCOMPLETE',
    );
    expect(resolveStatus({ breach: null, comparable: true })).toBe('PASS');
  });

  it('requires matching protocol fixture and environment hashes for a final baseline', () => {
    const baseline = {
      status: 'PASS',
      protocol_version: 'DIRA1-MVP-v1',
      fixture_manifest_hash: 'a',
      environment_manifest_hash: 'b',
    };
    expect(
      isCompatibleBaseline(baseline, {
        protocolVersion: 'DIRA1-MVP-v1',
        fixtureHash: 'a',
        environmentHash: 'b',
      }),
    ).toBe(true);
    expect(
      isCompatibleBaseline(baseline, {
        protocolVersion: 'DIRA1-MVP-v1',
        fixtureHash: 'x',
        environmentHash: 'b',
      }),
    ).toBe(false);
  });
});
