import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from '../common/auth/auth.config.js';

/**
 * Dev-only fallback signing secret. NEVER acceptable in production — the
 * fail-closed check below refuses to boot rather than sign attendance codes
 * with a publicly known key.
 */
export const DEV_ATTENDANCE_SECRET = 'dev-only-attendance-signing-secret';

/**
 * QR attendance signing secret resolution (Wave P3). Mirrors the fail-closed
 * posture of resolvePersistenceMode: NODE_ENV=production without
 * ATTENDANCE_SIGNING_SECRET aborts boot instead of issuing forgeable
 * attendance codes. Outside production a fixed dev-only secret keeps local
 * development and tests deterministic.
 *
 * Operators must provision `ATTENDANCE_SIGNING_SECRET` (>= 32 chars, high
 * entropy) via the deployment secret store; the variable is documented here
 * only and intentionally not committed anywhere else. Production rejects
 * the published dev-only fallback even when it is explicitly configured
 * (audit A3-2 — its length passes naive floor checks but its entropy is
 * zero because it is committed in this repository).
 */
export function resolveAttendanceSecret(env: NodeJS.ProcessEnv = process.env): string {
  assertProductionSecretStrength(env, 'ATTENDANCE_SIGNING_SECRET', {
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_ATTENDANCE_SECRET]
  });
  const secret = env.ATTENDANCE_SIGNING_SECRET;
  if (secret && secret.length >= 16) {
    return secret;
  }
  if (isProduction(env)) {
    throw new Error(
      'FATAL: NODE_ENV=production requires ATTENDANCE_SIGNING_SECRET (>= 16 chars) so ' +
        'event attendance QR codes are signed with a secret key. Refusing to start ' +
        'with the dev-only fallback secret.'
    );
  }
  return DEV_ATTENDANCE_SECRET;
}
