import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_SHARED_SECRET_MIN_LENGTH
} from '../auth/auth.config.js';

/**
 * V-26: key-versioned envelope mechanism for HMAC-signed payloads and
 * keyed (salted) hashes — the platform key-rotation capability.
 *
 * PROBLEM (dim06-#3): every signing secret / hashing salt was a single env
 * var with no key id. Rotating a secret instantly orphaned everything ever
 * signed/hashed with it (vouchers unverifiable, NIN dedupe broken), so
 * rotation was operationally impossible without data loss.
 *
 * MECHANISM: a key RING — one ACTIVE key (signs/hashes everything new)
 * plus a PREVIOUS acceptance window (verify-only). Signed payloads carry
 * the key id in the signature envelope (`<kid>:<hmac-hex>`); verification
 * accepts active+previous kids and rejects anything else (retired keys)
 * with an explicit reason. Rotation procedure: add the new key as active,
 * keep the old key in `previous` for the window, then remove it.
 *
 * Adopt per module via docs/security/key-rotation.md (the checklist); the
 * agent-banking voucher rail is the reference implementation.
 *
 * Env convention (per purpose, e.g. AGENT_VOUCHER):
 *   <NAME>_KEYS="kidA=secretA,kidB=secretB"   — first pair is ACTIVE, the
 *                                               rest are PREVIOUS (verify-only)
 *   <NAME>_SECRET="secretA"                   — legacy single-secret fallback,
 *                                               mapped to kid 'legacy'
 * Secrets must be base64url/base64/hex (no ',' or '=' inside a secret:
 * they are the pair separators). kids: [a-zA-Z0-9._-]{1,64}.
 */

export interface SigningKey {
  /** Key id — public, embedded in signature envelopes; never secret-bearing. */
  kid: string;
  secret: string;
}

export interface HmacKeyRing {
  /** Signs/hashes everything new. */
  active: SigningKey;
  /** Verify-only acceptance window (newest-first). */
  previous: SigningKey[];
  /** Human-readable purpose for error messages (e.g. 'agent-banking voucher signing'). */
  purpose: string;
}

export type HmacVerifyResult =
  | { ok: true; kid: string; mode: 'active' | 'previous' | 'legacy' }
  | { ok: false; reason: 'malformed' | 'retired-kid' | 'mismatch' };

const KID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENVELOPE_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,63}):([0-9a-f]{64})$/;
const BARE_HEX_PATTERN = /^[0-9a-f]{64}$/;

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function hexEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Signs data with the ring's ACTIVE key; the envelope carries the kid. */
export function hmacSign(ring: HmacKeyRing, data: string): string {
  return `${ring.active.kid}:${hmacHex(ring.active.secret, data)}`;
}

/**
 * Verifies a signature envelope against the ring.
 *
 * - `kid:hex` envelopes verify against the matching active/previous key;
 *   a kid that is in neither is a RETIRED (or foreign) key → rejected with
 *   reason 'retired-kid' so callers/alerts can distinguish rotation drift
 *   from tampering ('mismatch').
 * - bare-hex legacy signatures (pre-kid, already in the field) are
 *   accepted during the transition window when `legacyBareHex` is set —
 *   they are tried against every secret in the ring. Drop the option once
 *   all fielded signatures carry kids.
 */
export function hmacVerify(
  ring: HmacKeyRing,
  data: string,
  signature: string,
  options?: { legacyBareHex?: boolean }
): HmacVerifyResult {
  const envelope = ENVELOPE_PATTERN.exec(signature);
  if (envelope) {
    const [, kid, hex] = envelope;
    const key =
      ring.active.kid === kid
        ? ring.active
        : ring.previous.find((candidate) => candidate.kid === kid);
    if (!key) {
      return { ok: false, reason: 'retired-kid' };
    }
    if (!hexEqual(hmacHex(key.secret, data), hex)) {
      return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, kid, mode: key === ring.active ? 'active' : 'previous' };
  }
  if (options?.legacyBareHex && BARE_HEX_PATTERN.test(signature)) {
    for (const key of [ring.active, ...ring.previous]) {
      if (hexEqual(hmacHex(key.secret, data), signature)) {
        return { ok: true, kid: key.kid, mode: 'legacy' };
      }
    }
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: false, reason: 'malformed' };
}

/**
 * Dual-secret lookup for keyed HASHES (salts) — NIN/MSISDN doctrine.
 * Stored hashes carry no kid (the column stores bare hex), so verification
 * computes the HMAC under active+every previous salt and constant-time
 * compares. Returns which ring position matched so the caller can
 * OPPORTUNISTICALLY RE-HASH when the match is a previous salt (re-hash
 * with the active salt at next presentation; a batch re-hash job is
 * impossible by design — the plaintext is never persisted).
 */
export function matchKeyedHash(
  ring: HmacKeyRing,
  data: string,
  storedHash: string
): { matched: boolean; matchedKid?: string; needsRehash: boolean } {
  if (!BARE_HEX_PATTERN.test(storedHash)) {
    return { matched: false, needsRehash: false };
  }
  if (hexEqual(hmacHex(ring.active.secret, data), storedHash)) {
    return { matched: true, matchedKid: ring.active.kid, needsRehash: false };
  }
  for (const key of ring.previous) {
    if (hexEqual(hmacHex(key.secret, data), storedHash)) {
      return { matched: true, matchedKid: key.kid, needsRehash: true };
    }
  }
  return { matched: false, needsRehash: false };
}

/** Hashes data with the ring's ACTIVE salt/key (bare hex — storage form). */
export function keyedHash(ring: HmacKeyRing, data: string): string {
  return hmacHex(ring.active.secret, data);
}

export interface ResolveKeyRingOptions {
  /** Env var holding `kid=secret,kid=secret` (first pair = active). */
  keysEnv: string;
  /** Legacy single-secret env var (fallback; mapped to kid 'legacy'). */
  legacyEnv: string;
  /** Clearly-labelled development default when neither var is set. */
  devDefault: string;
  /** kid used for the dev default / legacy fallback ring. */
  fallbackKid?: string;
  /** Human-readable purpose for error messages. */
  purpose: string;
  /** Production minimum secret length (default: PRODUCTION_SHARED_SECRET_MIN_LENGTH). */
  minLength?: number;
  /** Published dev defaults every production secret must not equal. */
  publishedDefaults?: string[];
}

export class KeyRingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRingConfigError';
  }
}

/** Parses `kid=secret,kid=secret` — secrets must not contain ',' or '='. */
export function parseKeyRingSpec(spec: string, purpose: string): SigningKey[] {
  const keys: SigningKey[] = [];
  const seenKids = new Set<string>();
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new KeyRingConfigError(
        `${purpose}: malformed key pair '${trimmed}' — expected kid=secret`
      );
    }
    const kid = trimmed.slice(0, eq).trim();
    const secret = trimmed.slice(eq + 1).trim();
    if (!KID_PATTERN.test(kid)) {
      throw new KeyRingConfigError(
        `${purpose}: kid '${kid}' must match ${KID_PATTERN.source} (public id, no secrets in kids)`
      );
    }
    if (seenKids.has(kid)) {
      throw new KeyRingConfigError(`${purpose}: duplicate kid '${kid}'`);
    }
    if (secret.length === 0) {
      throw new KeyRingConfigError(`${purpose}: empty secret for kid '${kid}'`);
    }
    if (secret.includes(',') || secret.includes('=')) {
      throw new KeyRingConfigError(
        `${purpose}: secret for kid '${kid}' contains a separator — encode secrets base64url/hex`
      );
    }
    seenKids.add(kid);
    keys.push({ kid, secret });
  }
  if (keys.length === 0) {
    throw new KeyRingConfigError(`${purpose}: no keys parsed`);
  }
  return keys;
}

/**
 * Resolves the key ring for a purpose; FAILS CLOSED (throws) in production
 * when no key material is configured, when any secret is a published
 * development default, or when any secret is below the strength floor —
 * same doctrine as assertProductionSecretStrength. Malformed specs throw in
 * EVERY environment (a misconfigured ring is a boot error, not a runtime
 * surprise).
 */
export function resolveHmacKeyRing(
  env: NodeJS.ProcessEnv,
  options: ResolveKeyRingOptions
): HmacKeyRing {
  const fallbackKid = options.fallbackKid ?? 'legacy';
  const keysSpec = env[options.keysEnv]?.trim();
  let active: SigningKey;
  let previous: SigningKey[];
  if (keysSpec) {
    const keys = parseKeyRingSpec(keysSpec, options.purpose);
    active = keys[0];
    previous = keys.slice(1);
  } else {
    const legacy = env[options.legacyEnv]?.trim();
    if (legacy) {
      active = { kid: fallbackKid, secret: legacy };
      previous = [];
    } else if (isProduction(env)) {
      throw new KeyRingConfigError(
        `${options.keysEnv} (or ${options.legacyEnv}) is required in production — refusing to run ${options.purpose} with the development default.`
      );
    } else {
      active = { kid: fallbackKid, secret: options.devDefault };
      previous = [];
    }
  }
  // Production strength gate on EVERY secret in the ring (active+previous):
  // a weak previous key is still a verification oracle for fielded payloads.
  if (isProduction(env)) {
    for (const key of [active, ...previous]) {
      const slot = `${options.keysEnv}[kid=${key.kid}]`;
      assertProductionSecretStrength({ ...env, [slot]: key.secret }, slot, {
        minLength: options.minLength ?? PRODUCTION_SHARED_SECRET_MIN_LENGTH,
        publishedDefaults: options.publishedDefaults ?? []
      });
    }
  }
  return { active, previous, purpose: options.purpose };
}
