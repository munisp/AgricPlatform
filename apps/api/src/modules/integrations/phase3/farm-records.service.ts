import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import {
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  FARM_RECORD_REPOSITORY,
  INBOUND_EVENT_REPOSITORY
} from '../../../database/persistence.tokens.js';
import type {
  ExternalAccountLinkRepository,
  FarmRecord,
  FarmRecordRepository,
  FarmRecordType,
  InboundEventRepository
} from '../../../database/repositories/phase3.repository.js';
import {
  createFarmRecordClients,
  farmRecordsDriverEnabled,
  type FarmRecordClient,
  type NormalisedFarmRecord
} from '../drivers/farmos.clients.js';
import { payloadDedupeKey } from './phase3.utils.js';

const RECORD_TYPES: readonly FarmRecordType[] = ['crop_plan', 'harvest', 'field_map'];

/**
 * farmOS / LiteFarm farm-record sync (wave P5a, ACL adapter). Polling pulls
 * remote bundles per linked account and normalises them into
 * integrations.farm_records via the replay-safe upsert; the webhook path
 * accepts pushed records. The outbound member-verification push goes
 * through the same client. Everything is inert while FARM_RECORDS_DRIVER
 * is stub.
 */
@Injectable()
export class FarmRecordsService {
  private readonly logger = new Logger(FarmRecordsService.name);

  constructor(
    @Inject(EXTERNAL_ACCOUNT_LINK_REPOSITORY)
    private readonly links: ExternalAccountLinkRepository,
    @Inject(FARM_RECORD_REPOSITORY) private readonly records: FarmRecordRepository,
    @Inject(INBOUND_EVENT_REPOSITORY) private readonly inbound: InboundEventRepository,
    // @Optional: tests inject fake clients/env directly; Nest keeps the
    // env-derived defaults at runtime.
    @Optional() private readonly clients: FarmRecordClient[] = createFarmRecordClients(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return farmRecordsDriverEnabled(this.env) && this.clients.length > 0;
  }

  private clientFor(system: string): FarmRecordClient | undefined {
    return this.clients.find((client) => client.name === system);
  }

  /** Polls one linked account and upserts the normalised records. */
  async syncLink(linkId: string): Promise<number> {
    const link = await this.links.getById(linkId);
    if (link.revokedAt) {
      throw new BadRequestException('This external account link has been revoked');
    }
    const client = this.clientFor(link.system);
    if (!client) {
      throw new BadRequestException(
        `No live ${link.system} client configured (FARM_RECORDS_DRIVER is stub or unkeyed)`
      );
    }
    const fetched = await client.fetchRecords(link.externalId);
    return this.upsertNormalised(linkId, fetched);
  }

  /** Polls every active link for a member (or all members for admins). */
  async syncAll(userId?: string): Promise<{ syncedLinks: number; inserted: number }> {
    const active = await this.links.find({ ...(userId ? { userId } : {}), activeOnly: true });
    let inserted = 0;
    let syncedLinks = 0;
    for (const link of active) {
      if (!this.clientFor(link.system)) {
        continue;
      }
      try {
        inserted += await this.syncLink(link.id);
        syncedLinks += 1;
      } catch (error) {
        this.logger.warn(`farm-record sync failed for link ${link.id}: ${(error as Error).message}`);
      }
    }
    return { syncedLinks, inserted };
  }

  async recordsFor(userId: string): Promise<FarmRecord[]> {
    const userLinks = await this.links.find({ userId, activeOnly: true });
    const all: FarmRecord[] = [];
    for (const link of userLinks) {
      all.push(...(await this.records.find({ linkId: link.id })));
    }
    return all;
  }

  /** Outbound member verification status push to the remote system. */
  async pushVerification(linkId: string, verified: boolean): Promise<void> {
    const link = await this.links.getById(linkId);
    const client = this.clientFor(link.system);
    if (!client) {
      throw new BadRequestException(
        `No live ${link.system} client configured (FARM_RECORDS_DRIVER is stub or unkeyed)`
      );
    }
    await client.pushMemberVerification(link.externalId, verified);
  }

  /**
   * Webhook push receiver: ledgers the event (replay-safe), then upserts
   * the record when it maps to a known link. Returns whether the event was
   * new (false on replay). Audit C2: a replay whose ledgered event is still
   * unprocessed (the first attempt failed between ingest and markProcessed)
   * re-drives the side effects — the normalised upsert is idempotent — and
   * marks the event processed only on success; a failure propagates as a
   * 5xx so the provider keeps retrying instead of the event being lost.
   */
  async handleWebhook(
    system: 'farmos' | 'litefarm',
    payload: Record<string, unknown>,
    eventId?: string
  ): Promise<{ received: boolean; reprocessed?: boolean }> {
    const dedupeKey = eventId ?? payloadDedupeKey(payload);
    let event = await this.inbound.ingest({
      id: newId('evt'),
      system,
      eventType: String(payload['event'] ?? payload['type'] ?? 'record.pushed'),
      dedupeKey,
      payload,
      receivedAt: new Date().toISOString()
    });
    let reprocessed = false;
    if (!event) {
      const existing = await this.inbound.findOne({ system, dedupeKey });
      if (!existing || existing.processedAt) {
        return { received: false };
      }
      // Replay of an unprocessed event: re-drive the idempotent side effects.
      event = existing;
      reprocessed = true;
    }
    const externalAccountId = String(payload['account_id'] ?? payload['farm_id'] ?? '');
    const link = (await this.links.find({ system, activeOnly: true })).find(
      (candidate) => candidate.externalId === externalAccountId
    );
    const normalised = normalisePushedRecord(system, payload);
    if (link && normalised) {
      await this.upsertNormalised(link.id, [normalised]);
    }
    await this.inbound.markProcessed(event.id, new Date().toISOString());
    return reprocessed ? { received: true, reprocessed: true } : { received: true };
  }

  private async upsertNormalised(linkId: string, fetched: NormalisedFarmRecord[]): Promise<number> {
    const now = new Date().toISOString();
    return this.records.upsertMany(
      fetched.map((record) => ({
        id: newId('frec'),
        linkId,
        recordType: record.recordType,
        externalId: record.externalId,
        payload: record.payload,
        source: record.source,
        observedAt: record.observedAt,
        syncedAt: now
      }))
    );
  }
}

/** Normalises a pushed record payload; undefined when it cannot be mapped. */
export function normalisePushedRecord(
  system: 'farmos' | 'litefarm',
  payload: Record<string, unknown>
): NormalisedFarmRecord | undefined {
  const recordType = payload['record_type'] ?? payload['recordType'];
  const externalId = payload['record_id'] ?? payload['id'];
  if (
    typeof recordType !== 'string' ||
    !RECORD_TYPES.includes(recordType as FarmRecordType) ||
    externalId === undefined
  ) {
    return undefined;
  }
  const observed = new Date(String(payload['observed_at'] ?? payload['timestamp'] ?? ''));
  return {
    recordType: recordType as FarmRecordType,
    externalId: String(externalId),
    payload,
    source: system,
    observedAt: Number.isNaN(observed.getTime()) ? new Date().toISOString() : observed.toISOString()
  };
}
