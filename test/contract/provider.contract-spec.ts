import * as path from 'node:path';
import request from 'supertest';
import { Verifier } from '@pact-foundation/pact';
import {
  ContractWorld,
  FEATURE_KEYS,
  IDS,
  startProviderApp,
  type ProviderApp,
} from './fixtures';

/**
 * Provider verification for `people-management-frontend`.
 *
 * Replays every interaction the frontend recorded in
 * `services/frontend/pacts/` against a real app on a real migrated PostgreSQL.
 * This is the first test in the repository that checks the two services agree:
 * the Playwright suite asserts the UI against hand-written mocks and the e2e
 * suites assert the backend against its own fixtures, so until now both sides
 * could drift apart and stay green.
 *
 * Auth: no `requestFilter`. The recorded Authorization example is already the
 * `Bearer <token:<id>>` shorthand `jwt-session-resolver.adapter.ts` accepts,
 * naming the viewer these states seed, so requests replay as-is.
 *
 * That is not a stylistic choice. A requestFilter makes pact-js proxy the whole
 * verification through Express, and that proxy corrupted the JSON body of
 * `POST /auth/magic-link/consume`: through it the route answered 401, without
 * it 200, while the same request driven straight at the listener answered 200
 * either way. Keeping the proxy out removes a failure mode that looks exactly
 * like a provider bug.
 */
const PACT_FILE =
  process.env.PACT_FILE ??
  path.resolve(
    __dirname,
    '../../../frontend/pacts/people-management-frontend-people-management-backend.json',
  );

jest.setTimeout(180_000);

describe('Provider verification — people-management-backend', () => {
  let provider: ProviderApp;
  let world: ContractWorld;

  beforeAll(async () => {
    provider = await startProviderApp();
    world = new ContractWorld(provider.prisma);
  });

  afterAll(async () => {
    if (world) await world.cleanup();
    if (provider) await provider.app.close();
  });

  it('honours every interaction the frontend recorded', async () => {
    const verifier = new Verifier({
      provider: 'people-management-backend',
      providerBaseUrl: provider.baseUrl,
      pactUrls: [PACT_FILE],
      logLevel: 'warn',


      stateHandlers: {
        'no session, and the address may or may not belong to an active user':
          async () => {
            await world.reset();
            await world.cast();
          },

        'an unconsumed, unexpired magic-link token exists for an active user':
          async () => {
            await world.reset();
            await world.cast();
            // The consume request carries this exact raw token; only its
            // SHA-256 is stored, so the state has to plant the hash.
            await world.magicLinkToken(IDS.subject, 'a-valid-magic-link-token');
          },

        'an authenticated viewer holding user-management:list and at least one active employee':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.list]);
          },

        'an authenticated viewer holding user-management:create': async () => {
          await world.reset();
          await world.cast();
          await world.grant(IDS.viewer, [FEATURE_KEYS.create]);
        },

        // Reading another person's S1 card needs an audience over them; the
        // reporting edge is the cheapest one that grants it.
        'an authenticated viewer who may read the target employee S1 card':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
          },

        'an authenticated viewer holding S1 write access over the target employee':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
          },

        'an authenticated viewer who may read the target employee timeline':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.manualEvent(IDS.subject, IDS.event);
          },

        'an authenticated viewer holding timeline write access over the target employee':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.grant(IDS.viewer, [FEATURE_KEYS.timelineWrite]);
          },

        'an authenticated viewer holding timeline write access and a deletable manual event':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.grant(IDS.viewer, [FEATURE_KEYS.timelineWrite]);
            await world.manualEvent(IDS.subject, IDS.event);
          },

        'an authenticated viewer who may read the target employee current relationships':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer, IDS.relationship);
          },

        'an authenticated viewer who may read the target employee access journal':
          async () => {
            await world.reset();
            await world.cast();
            await world.reportsTo(IDS.subject, IDS.viewer);
            await provider.prisma.accessJournal.create({
              data: {
                actorUserId: IDS.viewer,
                subjectUserId: IDS.subject,
                kind: 'manager',
                before: undefined,
                after: { relationshipId: IDS.relationship, type: 'direct' },
                idempotencyKey: `pact-journal-${Date.now()}`,
              },
            });
          },

        // No pre-existing manager edge: the subject must be assignable, and a
        // second `direct` edge is a 409 by design.
        'an authenticated viewer holding organisation write access and an assignable target':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.orgWrite]);
          },

        'an authenticated viewer holding organisation write access and an existing manager edge':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.orgWrite]);
            await world.reportsTo(IDS.subject, IDS.viewer, IDS.relationship);
          },

        'an authenticated viewer holding organisation write access and a current People Partner':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.orgWrite]);
            // The contract's optimistic-concurrency token names this PP, so the
            // seeded edge has to point at exactly that user or the backend is
            // right to answer 409.
            await world.peoplePartnerOf(
              IDS.subject,
              IDS.currentPeoplePartner,
              IDS.relationship,
            );
          },

        'an authenticated viewer holding departure write access over an unblocked employee':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.departure]);
            await world.reportsTo(IDS.subject, IDS.viewer);
          },

        // The subject manages someone, which is exactly what blocks departure.
        'an authenticated viewer and an employee whose active responsibilities block departure':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.departure]);
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.reportsTo(IDS.target, IDS.subject);
          },

        'an authenticated viewer and a departure that has failed at least one attempt':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.departure]);
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.departure(IDS.subject, IDS.departure, {
              state: 'retry_wait',
              attempts: 1,
              lastError: 'downstream_unavailable',
            });
          },

        'an authenticated viewer and a departure in retry_wait': async () => {
          await world.reset();
          await world.cast();
          await world.grant(IDS.viewer, [FEATURE_KEYS.departure]);
          await world.reportsTo(IDS.subject, IDS.viewer);
          await world.departure(IDS.subject, IDS.departure, {
            state: 'retry_wait',
            attempts: 1,
          });
        },

        // Returns the blocker digest the contract's `fromProviderState`
        // placeholder is filled with. It cannot be a fixed example: the backend
        // derives it from the live blocker set and answers 409 to a stale one.
        // The only way to learn the current value is to ask for the departure
        // and read it off the 409 the blockers produce.
        'an authenticated viewer and an employee with re-parentable blockers':
          async () => {
            await world.reset();
            await world.cast();
            await world.grant(IDS.viewer, [FEATURE_KEYS.departure]);
            await world.reportsTo(IDS.subject, IDS.viewer);
            await world.reportsTo(IDS.target, IDS.subject);

            const blocked = await request(provider.app.getHttpServer())
              .post(`/api/v1/users/${IDS.subject}/departures`)
              .set('Authorization', `Bearer <token:${IDS.viewer}>`)
              .set('Idempotency-Key', '3b7d9e1a-2c4f-4a6b-8d0e-1f2a3b4c5d6e')
              .send({ effectiveDate: '2026-12-31', reason: 'Resignation' });

            return { blockerVersion: blocked.body?.expectedBlockerVersion };
          },
      },
    });

    await verifier.verifyProvider();
  });
});
