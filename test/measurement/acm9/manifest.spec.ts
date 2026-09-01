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

describe('ACM9 artifact protocol', () => {
  it('canonicalizes equivalent manifests and hashes their exact UTF-8 bytes', () => {
    const left = { z: null, a: { '😀': 'ok', value: 1.2 }, count: 500 };
    const right = { count: 500, a: { value: 1.2, '😀': 'ok' }, z: null };
    expect(canonicalJson(left)).toBe(
      '{"a":{"value":1.200,"😀":"ok"},"count":500,"z":null}',
    );
    expect(manifestHash(left)).toBe(manifestHash(right));
    expect(manifestHash(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses nearest-rank percentiles', () => {
    expect(nearestRank([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(nearestRank([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it('reserves a unique incomplete artifact before finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acm9-'));
    const reserved = await reserveArtifact(directory, 'baseline', 'run-a');
    await expect(
      reserveArtifact(directory, 'baseline', 'run-a'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    const initial = JSON.parse(await readFile(reserved.path, 'utf8'));
    expect(initial.status).toBe('INCOMPLETE');
    expect(initial.protocol_version).toBe('ACM9-MVP-v1');
    expect(initial.manifest_version).toBe('ACM9-MANIFEST-v1');
    expect(initial.created_at).toEqual(expect.any(String));
    expect(initial.updated_at).toEqual(expect.any(String));
    expect(initial.stop_reason).toBe('pending');
    const finalized = await finalizeArtifact(reserved, {
      status: 'PASS',
      stop_reason: 'completed',
    });
    expect(finalized.status).toBe('PASS');
  });

  it('preserves the first breach and gives it FAIL precedence over a mismatch', () => {
    expect(
      resolveStatus({
        breach: { gate: 'reporting-balanced', reason: 'p95' },
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
      protocol_version: 'ACM9-MVP-v1',
      fixture_manifest_hash: 'a',
      environment_manifest_hash: 'b',
    };
    expect(
      isCompatibleBaseline(baseline, {
        protocolVersion: 'ACM9-MVP-v1',
        fixtureHash: 'a',
        environmentHash: 'b',
      }),
    ).toBe(true);
    expect(
      isCompatibleBaseline(baseline, {
        protocolVersion: 'ACM9-MVP-v1',
        fixtureHash: 'x',
        environmentHash: 'b',
      }),
    ).toBe(false);
  });
});
