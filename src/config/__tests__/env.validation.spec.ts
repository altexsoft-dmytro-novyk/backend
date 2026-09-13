import { envValidationSchema } from '../env.validation';

// SEC-AUTH-01 closure (2026-09-12). The `Bearer <token:persona>` shorthand and
// the `Root` persona's self-provisioning survive only behind
// `ALLOW_TEST_SESSION_TOKENS` (`jwt-session-resolver.adapter.ts`). The flag
// must be REFUSED under `NODE_ENV=production`, not merely default to `false`,
// or a single misconfigured environment variable reopens the blocker's paths
// (1) and (2) in production.
interface FlagValidation {
  error?: { details: { path: (string | number)[] }[] };
  value: Record<string, unknown>;
}

function validateFlag(env: Record<string, string>) {
  const result: unknown = envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
  const { error, value } = result as FlagValidation;
  const flagErrors = (error?.details ?? []).filter(
    (detail) => detail.path[0] === 'ALLOW_TEST_SESSION_TOKENS',
  );
  return {
    flagErrors,
    value: value.ALLOW_TEST_SESSION_TOKENS,
  };
}

describe('envValidationSchema · ALLOW_TEST_SESSION_TOKENS (SEC-AUTH-01)', () => {
  it('refuses an explicit true under NODE_ENV=production', () => {
    const { flagErrors } = validateFlag({
      NODE_ENV: 'production',
      ALLOW_TEST_SESSION_TOKENS: 'true',
    });
    expect(flagErrors).toHaveLength(1);
  });

  it('defaults to false under NODE_ENV=production and accepts an explicit false', () => {
    expect(validateFlag({ NODE_ENV: 'production' })).toEqual({
      flagErrors: [],
      value: false,
    });
    expect(
      validateFlag({
        NODE_ENV: 'production',
        ALLOW_TEST_SESSION_TOKENS: 'false',
      }),
    ).toEqual({ flagErrors: [], value: false });
  });

  it.each(['development', 'test'])(
    'keeps the non-production default of true under NODE_ENV=%s',
    (nodeEnv) => {
      expect(validateFlag({ NODE_ENV: nodeEnv })).toEqual({
        flagErrors: [],
        value: true,
      });
    },
  );
});
