import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import {
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  USER_REPOSITORY
} from '../../../database/persistence.tokens.js';
import type {
  ExternalAccountLink,
  ExternalAccountLinkRepository,
  ExternalSystem
} from '../../../database/repositories/phase3.repository.js';
import type { UserRepository } from '../../../database/repositories/user.repository.js';
import { AuditService } from '../../../core/audit.service.js';
import { DomainEventsService } from '../../../core/domain-events.service.js';

const EXTERNAL_SYSTEMS: readonly ExternalSystem[] = ['farmos', 'litefarm'];

export interface LinkExternalAccountInput {
  system: ExternalSystem;
  externalId: string;
  /** ISO-8601 timestamp of the farmer's explicit sharing consent (required). */
  consentAt: string;
}

/**
 * External account linking (wave P5a). Farmers explicitly link their farmOS
 * / LiteFarm account; the link records the consent timestamp and unlinking
 * soft-revokes it so downstream sync stops honouring the account while the
 * audit trail survives (NDPR revocation).
 */
@Injectable()
export class ExternalAccountsService {
  constructor(
    @Inject(EXTERNAL_ACCOUNT_LINK_REPOSITORY)
    private readonly links: ExternalAccountLinkRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService
  ) {}

  async link(userId: string, input: LinkExternalAccountInput): Promise<ExternalAccountLink> {
    await this.users.getById(userId);
    if (!EXTERNAL_SYSTEMS.includes(input.system)) {
      throw new BadRequestException(
        `Unsupported external system '${input.system}'. Expected one of: ${EXTERNAL_SYSTEMS.join(', ')}`
      );
    }
    if (!input.externalId?.trim()) {
      throw new BadRequestException('externalId is required');
    }
    const consentAt = new Date(input.consentAt);
    if (!input.consentAt || Number.isNaN(consentAt.getTime())) {
      throw new BadRequestException(
        'A valid consentAt timestamp is required — linking is consent-gated (NDPR)'
      );
    }
    const duplicate = (await this.links.find({ userId, system: input.system, activeOnly: true })).find(
      (existing) => existing.externalId === input.externalId
    );
    if (duplicate) {
      return duplicate; // idempotent re-link
    }
    const link: ExternalAccountLink = {
      id: newId('link'),
      userId,
      system: input.system,
      externalId: input.externalId.trim(),
      consentAt: consentAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    await this.links.create(link);
    await this.audit.record({
      actorId: userId,
      action: 'integrations.external_account.linked',
      entityType: 'external_account_link',
      entityId: link.id
    });
    await this.events.publish(
      'integrations.external_account.linked',
      { linkId: link.id, system: link.system },
      userId
    );
    return link;
  }

  /** Soft-revoke: revoked_at stops sync while preserving the audit trail. */
  async unlink(userId: string, linkId: string): Promise<ExternalAccountLink> {
    const link = await this.links.getById(linkId);
    if (link.userId !== userId) {
      throw new ForbiddenException('You may only unlink your own external accounts');
    }
    if (link.revokedAt) {
      return link; // idempotent unlink
    }
    const updated = await this.links.update(linkId, { revokedAt: new Date().toISOString() });
    await this.audit.record({
      actorId: userId,
      action: 'integrations.external_account.unlinked',
      entityType: 'external_account_link',
      entityId: linkId
    });
    await this.events.publish(
      'integrations.external_account.unlinked',
      { linkId, system: link.system },
      userId
    );
    return updated;
  }

  async listFor(userId: string): Promise<ExternalAccountLink[]> {
    return this.links.find({ userId });
  }
}
