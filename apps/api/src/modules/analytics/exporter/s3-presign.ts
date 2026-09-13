/**
 * Minimal AWS Signature Version 4 presigner for S3 GET URLs (Stage 27,
 * innovation #20 "Lender Lens" scorecard exports).
 *
 * The repo pins `@aws-sdk/client-s3` only (no presigner package), so the
 * scorecard export signs its download URLs directly with node:crypto. The
 * implementation is deliberately narrow: path-style URLs against an
 * S3-compatible endpoint (the same deployment target as the lakehouse
 * exporter), GET only, UNSIGNED-PAYLOAD, host as the only signed header.
 *
 * Deterministic: identical (config, key, now) inputs produce an identical
 * URL — the unit tests pin this.
 */
import { createHash, createHmac } from 'node:crypto';

export interface PresignInput {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Lifetime of the signed URL in seconds (S3 maximum is 604800). */
  expiresSeconds: number;
  /** Signing instant. */
  now: Date;
}

/** RFC 3986 URI encoding (encodeURIComponent plus the five chars it skips). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Every path segment encoded, slashes preserved. */
function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/** 'YYYYMMDD' and 'YYYYMMDDTHHMMSSZ' without regexp escapes. */
function amzDates(now: Date): { dateStamp: string; amzDate: string } {
  const digits = now
    .toISOString()
    .split(/[^0-9]/)
    .join('');
  const dateStamp = digits.slice(0, 8);
  return { dateStamp, amzDate: `${dateStamp}T${digits.slice(8, 14)}Z` };
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Newline without a literal backslash escape (repo backslash-free doctrine). */
const NEWLINE = String.fromCharCode(10);

/** Strips the scheme (http:// or https://) without a regexp escape. */
function hostOf(endpoint: string): string {
  if (endpoint.startsWith('https://')) return endpoint.slice('https://'.length);
  if (endpoint.startsWith('http://')) return endpoint.slice('http://'.length);
  return endpoint;
}

/** Removes trailing slashes. */
function stripTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

/** Presigned path-style GET URL for one object. */
export function presignGetObject(input: PresignInput): string {
  const endpoint = stripTrailingSlashes(input.endpoint);
  const host = hostOf(endpoint);
  const { dateStamp, amzDate } = amzDates(input.now);
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const canonicalUri = `/${uriEncode(input.bucket)}/${encodeKey(input.key)}`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD'
  ].join(NEWLINE);
  const requestHash = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, requestHash].join(NEWLINE);

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
