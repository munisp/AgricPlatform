/**
 * Shared CORS origin configuration (GAP-L17): the credentialled global
 * policy and the embed feed policy read from the SAME allowlist so the two
 * regimes cannot diverge.
 */

/** Parses a comma-separated origin list, dropping empties. */
function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Credentialled browser-app origins (the Next.js PWA). Used by
 * bootstrap.ts for the global `enableCors({ credentials: true })` policy.
 */
export function configuredCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseOrigins(env.CORS_ORIGIN ?? 'http://localhost:3000');
}

/**
 * Origins allowed to read the anonymous embed feeds cross-origin
 * (GAP-L17). Defaults to the credentialled allowlist; third-party widget
 * hosts are added via EMBED_CORS_ORIGINS (comma-separated). The wildcard is
 * deliberately NOT supported: on a credentialled API an `ACAO: *` override
 * is both invalid (credentialed requests) and a divergent second policy, so
 * embed hosts must be configured explicitly (fail closed).
 */
export function configuredEmbedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...configuredCorsOrigins(env), ...parseOrigins(env.EMBED_CORS_ORIGINS)];
}
