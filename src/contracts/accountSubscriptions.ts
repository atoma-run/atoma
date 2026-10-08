import { z } from 'zod';

/**
 * PERSONAL PROVIDER SUBSCRIPTIONS — ACCOUNT-SELF-CARE SHAPES.
 * ===========================================================
 *
 * A connection belongs to one Atoma principal, never to an organisation.
 * The profile itself remains in the provider CLI's private credential store;
 * these shapes intentionally carry only state and bounded device-login data.
 * In particular, no access/refresh token, auth file path, account email or
 * vendor error text may cross the HTTP boundary.
 */

export const accountSubscriptionProviderSchema = z.enum(['claude', 'codex']);
export type AccountSubscriptionProvider = z.infer<typeof accountSubscriptionProviderSchema>;

/** Opaque generation id for one provider-owned profile directory. */
export const accountSubscriptionProfileIdSchema = z.string().uuid();

/** Device codes are rendered verbatim, so admit only the provider's safe ASCII alphabet. */
export const codexDeviceUserCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/, 'expected an ASCII device code');

/**
 * THE LONG-LIVED CLAUDE CODE TOKEN (`claude setup-token`), pasted by the
 * member. BETA, owner decision 2026-10-08: Anthropic's third-party approval
 * for routing claude.ai subscriptions has not been granted, and the product
 * offers the connection anyway while in beta
 * (`docs/personal-claude-beta-2026-10-08.md`). The shape is the one Claude
 * Code mints — an `sk-ant-oat` prefix, a two-digit generation, then printable
 * ASCII — so a pasted API key (`sk-ant-api…`) or a device code is refused by
 * spelling before any subprocess sees it. The value never crosses back over
 * HTTP: it is written to the private profile and read only at launch.
 */
export const claudeSubscriptionTokenSchema = z
  .string()
  .trim()
  .min(32)
  .max(1_024)
  .regex(/^sk-ant-oat\d{2}-[!-~]{20,}$/, 'expected a Claude Code long-lived token');

export const accountSubscriptionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reauth_required',
  'unavailable',
  'error',
]);
export type AccountSubscriptionState = z.infer<typeof accountSubscriptionStateSchema>;

export const accountSubscriptionReasonSchema = z.enum([
  'claude-cli-unavailable',
  'codex-cli-unavailable',
  'profile-permissions-unsupported',
  'authentication-required',
  'login-failed',
  'login-expired',
]);
export type AccountSubscriptionReason = z.infer<typeof accountSubscriptionReasonSchema>;

export const accountSubscriptionStatusSchema = z
  .object({
    provider: accountSubscriptionProviderSchema,
    state: accountSubscriptionStateSchema,
    connectedAt: z.string().datetime().nullable(),
    lastVerifiedAt: z.string().datetime().nullable(),
    reason: accountSubscriptionReasonSchema.nullable(),
  })
  .strict();
export type AccountSubscriptionStatus = z.infer<typeof accountSubscriptionStatusSchema>;

/** Device-code material is short-lived and never persisted by Atoma. */
export const codexSubscriptionAttemptSchema = z
  .object({
    attemptId: z.string().uuid(),
    state: z.enum(['connecting', 'error']),
    verificationUrl: z.string().url().nullable(),
    userCode: codexDeviceUserCodeSchema.nullable(),
    expiresAt: z.string().datetime(),
    reason: accountSubscriptionReasonSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.state === 'connecting') {
      if (attempt.verificationUrl === null || attempt.userCode === null || attempt.reason !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a connecting attempt requires device material and no failure reason',
        });
      }
      return;
    }
    if (attempt.verificationUrl !== null || attempt.userCode !== null || attempt.reason === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a failed attempt exposes no device material and requires a reason',
      });
    }
  });
export type CodexSubscriptionAttempt = z.infer<typeof codexSubscriptionAttemptSchema>;

export const accountSubscriptionsResponseSchema = z
  .object({
    claude: accountSubscriptionStatusSchema,
    codex: accountSubscriptionStatusSchema,
    codexAttempt: codexSubscriptionAttemptSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.claude.provider !== 'claude') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claude', 'provider'],
        message: 'expected the Claude provider',
      });
    }
    if (response.codex.provider !== 'codex') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codex', 'provider'],
        message: 'expected the Codex provider',
      });
    }
  });
export type AccountSubscriptionsResponse = z.infer<typeof accountSubscriptionsResponseSchema>;

/** Parsed at load time so docs/examples cannot drift from the wire contract. */
export const EXAMPLE_ACCOUNT_SUBSCRIPTIONS: AccountSubscriptionsResponse =
  accountSubscriptionsResponseSchema.parse({
    claude: {
      provider: 'claude',
      state: 'disconnected',
      connectedAt: null,
      lastVerifiedAt: null,
      reason: null,
    },
    codex: {
      provider: 'codex',
      state: 'disconnected',
      connectedAt: null,
      lastVerifiedAt: null,
      reason: null,
    },
    codexAttempt: null,
  });
