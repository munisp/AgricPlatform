import { isProduction } from '../common/auth/auth.config.js';

/**
 * Dev-only fallback signing secret. NEVER acceptable in production — the
 * fail-closed check below refuses to boot rather than sign vet health
 * records with a publicly known key.
 */
export const DEV_VET_SIGNING_SECRET = 'dev-only-vet-health-signing-secret';

/**
 * Vet health-record signing secret resolution (wave L1b, ALTP F2/F3.4).
 * Mirrors the fail-closed posture of resolveAttendanceSecret:
 * NODE_ENV=production without VET_SIGNING_SECRET aborts boot instead of
 * issuing forgeable vet signatures. Outside production a fixed dev-only
 * secret keeps local development and tests deterministic.
 *
 * Operators must provision `VET_SIGNING_SECRET` (>= 16 chars, high entropy)
 * via the deployment secret store; the variable is documented here only and
 * intentionally not committed anywhere else.
 */
export function resolveVetSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.VET_SIGNING_SECRET;
  if (secret && secret.length >= 16) {
    return secret;
  }
  if (isProduction(env)) {
    throw new Error(
      'FATAL: NODE_ENV=production requires VET_SIGNING_SECRET (>= 16 chars) so ' +
        'animal health records are signed with a secret key. Refusing to start ' +
        'with the dev-only fallback secret.'
    );
  }
  return DEV_VET_SIGNING_SECRET;
}

/**
 * Government disease-notification webhook (blueprint F5.1 — confirmed
 * outbreak flags are pushed to the state veterinary authority). Returns the
 * configured endpoint URL, or undefined when unconfigured; the adapter fails
 * closed in that case (no simulated delivery).
 */
export function resolveDiseaseNotificationUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const url = env.DISEASE_NOTIFICATION_URL;
  return url && url.startsWith('https://') ? url : undefined;
}
