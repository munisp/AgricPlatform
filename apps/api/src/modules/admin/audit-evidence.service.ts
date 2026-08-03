import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { AuditService, canonicalJSON, type AuditVerification } from '../../core/audit.service.js';

/**
 * Signed audit evidence pack (Wave COMP, NDPA accountability + regulator
 * spot-checks). Bundles a createdAt-bounded slice of the tamper-evident
 * audit chain, the chain-verification verdict for exactly that slice
 * (reusing the existing range walk), and a sha256 over the canonical
 * payload so the pack can be re-hashed and compared offline.
 */
export interface AuditEvidencePack {
  generatedAt: string;
  /** ISO-8601 createdAt bounds actually applied (null = unbounded). */
  range: { from: string | null; to: string | null };
  eventCount: number;
  events: AuditEvent[];
  /** Chain verification over exactly this slice (range walk). */
  verification: AuditVerification;
  /** Hash of the last event in the slice (chain head for this pack). */
  chainHead: string | null;
  /** sha256:… over the canonical {range, events, verification} payload. */
  payloadHash: string;
}

function parseBound(value: string | undefined, name: string): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new BadRequestException(`Invalid '${name}' bound — expected an ISO-8601 datetime`);
  }
  return new Date(parsed).toISOString();
}

@Injectable()
export class AuditEvidenceService {
  constructor(private readonly audit: AuditService) {}

  async evidencePack(from?: string, to?: string): Promise<AuditEvidencePack> {
    const fromBound = parseBound(from, 'from');
    const toBound = parseBound(to, 'to');
    if (fromBound && toBound && fromBound > toBound) {
      throw new BadRequestException("'from' must not be after 'to'");
    }
    const all = await this.audit.list();
    const events = all.filter(
      (event) =>
        (!fromBound || event.createdAt >= fromBound) && (!toBound || event.createdAt <= toBound)
    );
    // Reuse the existing ranged chain walk: the slice head's link to prior
    // history is trusted, every link and payload hash inside is verified.
    const verification = events.length
      ? await this.audit.verify({ fromId: events[0].id, toId: events[events.length - 1].id })
      : { valid: true, checked: 0 };
    const range = { from: fromBound, to: toBound };
    const payloadHash = `sha256:${createHash('sha256')
      .update(canonicalJSON({ range, events, verification }))
      .digest('hex')}`;
    return {
      generatedAt: new Date().toISOString(),
      range,
      eventCount: events.length,
      events,
      verification,
      chainHead: events.length ? (events[events.length - 1].hash ?? null) : null,
      payloadHash
    };
  }
}
