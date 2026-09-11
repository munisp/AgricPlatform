import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { CreditRepayment, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CERTIFICATE_REPOSITORY,
  CONSENT_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PASSPORT_DISCLOSURE_REPOSITORY,
  CREDIT_PASSPORT_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  GEO_CREDIT_SHADOW_REPOSITORY,
  VSLA_LOAN_REPOSITORY,
  VSLA_MEMBER_REPOSITORY,
  VSLA_SHARE_OUT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CertificateRepository } from '../../database/repositories/certificate.repository.js';
import type { ConsentRepository } from '../../database/repositories/consent.repository.js';
import type {
  CreditLoanRepository,
  CreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import type {
  CreditPassportCredentialRepository,
  CreditPassportDisclosureRepository
} from '../../database/repositories/credit-passport.repository.js';
import type { GeoCreditShadowRepository } from '../../database/repositories/geo-credit-shadow.repository.js';
import type {
  VslaLoanRepository,
  VslaMemberRepository,
  VslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { UsersService } from '../users/users.service.js';
import { initialsOf } from '../livestock-passport/livestock-passport.service.js';
import {
  formatPassportCode,
  parsePassportCode,
  resolveCodeSecret,
  signPassportCode,
  verifyPassportCode
} from './passport-code.js';
import {
  computeCredentialHash,
  credentialHashPayloadOf,
  GENESIS_PREV_HASH,
  verifyCredentialChain,
  type CertificatesSectionData,
  type CredentialChainVerification,
  type CreditPassportCredential,
  type CreditPassportDisclosure,
  type CreditPassportPayload,
  type GeoFactorSectionData,
  type PassportSection,
  type RepaymentSectionData,
  type VslaSectionData
} from './credit-passport.types.js';

/** Partner-API scope the consent-scoped disclosure satisfies. */
export const CREDIT_PASSPORT_READ_SCOPE = 'credit-passport:read';

/** NDPA consent purpose recorded when a farmer shares their passport. */
export const CREDIT_PASSPORT_SHARE_CONSENT_PURPOSE = 'credit_passport_sharing';

/** Disclosure lifetime bounds (hours): 1h minimum, 90 days maximum, 72h default. */
export const DISCLOSURE_MIN_HOURS = 1;
export const DISCLOSURE_MAX_HOURS = 2160;
export const DISCLOSURE_DEFAULT_HOURS = 72;

export interface SharePassportInput {
  /** Partner organisation / client id the farmer discloses the credential to. */
  partnerId: string;
  expiresInHours?: number;
}

/** Full farmer-facing document: active credential + recomputed chain. */
export interface CreditPassportDocument {
  credential: CreditPassportCredential;
  chain: CredentialChainVerification;
  /** QR-code-ready payload: encode `verifyPath` (or an absolute URL of it). */
  qr: { code: string; verifyPath: string };
}

/**
 * Redacted public verification view — NO holder PII beyond initials, no kobo
 * amounts, no certificate codes: per-section basis badges + coarse counts
 * only (PII minimality invariant, mirrored from livestock-passport).
 */
export interface PublicCreditPassportVerification {
  verified: true;
  passportCode: string;
  status: CreditPassportCredential['status'];
  version: number;
  holderInitials: string;
  sections: {
    repayment?: { basis: string; decisional: boolean; loanCount: number; onTimeRatio: number };
    certificates?: { basis: string; decisional: boolean; count: number };
    vsla?: { basis: string; decisional: boolean; groupsJoined: number };
    geoFactor?: { basis: string; decisional: false; factorScore: number | null };
  };
  chain: { versionCount: number; valid: boolean; headHash?: string };
  qr: { code: string; verifyPath: string };
  disclaimers: string[];
}

/** Partner-facing document (behind scope + disclosure check): full payload. */
export interface PartnerCreditPassportView {
  credential: CreditPassportCredential;
  chain: CredentialChainVerification;
  disclosure: { id: string; expiresAt: string };
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for credit passports');
  }
  return actor;
}

/**
 * Credit Passport (Stage 27, Innovation 7): a portable, verifiable farmer
 * credit credential. The passport COMPOSES the existing domains — credit
 * repayment history (credit suite), VSLA discipline (vsla-carbon), learning
 * certificates (learning) and the shadow geo credit factor
 * (credit/geo-verification) — through their repositories at compose time;
 * nothing is re-implemented here (livestock-passport doctrine). The
 * credential itself is an append-only per-farmer hash chain: recomputation
 * on material change appends a new version linked to the superseded head,
 * so the document is tamper-evident without DB triggers.
 *
 * Honesty doctrine: every section carries a provenance badge. Repayment,
 * certificates and VSLA are LIVE (read from the owning repositories); the
 * geo factor is SHADOW and always non-decisional (the geo-credit module's
 * hard design constraint). A section whose source is unavailable is
 * emitted with an honest 'unavailable' badge or omitted — never fabricated.
 */
@Injectable()
export class CreditPassportService {
  private readonly codeSecret: string;

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    private readonly telemetry: TelemetryService,
    @Inject(CREDIT_PASSPORT_REPOSITORY)
    private readonly credentials: CreditPassportCredentialRepository,
    @Inject(CREDIT_PASSPORT_DISCLOSURE_REPOSITORY)
    private readonly disclosures: CreditPassportDisclosureRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(CERTIFICATE_REPOSITORY) private readonly certificates: CertificateRepository,
    @Inject(VSLA_MEMBER_REPOSITORY) private readonly vslaMembers: VslaMemberRepository,
    @Inject(VSLA_SHARE_OUT_REPOSITORY) private readonly vslaShareOuts: VslaShareOutRepository,
    @Inject(VSLA_LOAN_REPOSITORY) private readonly vslaLoans: VslaLoanRepository,
    @Inject(GEO_CREDIT_SHADOW_REPOSITORY) private readonly geoShadow: GeoCreditShadowRepository,
    @Inject(CONSENT_REPOSITORY) private readonly consents: ConsentRepository
  ) {
    this.codeSecret = resolveCodeSecret();
  }

  /* --------------------------- farmer surface --------------------------- */

  /**
   * The farmer's current passport. Auto-issues version 1 on first read and
   * auto-appends a new chain version whenever the composed payload changed
   * materially (payload hash differs from the active head) — recompute-on-
   * material-change per the spec; unchanged reads return the stored head.
   */
  async getMine(actor: User | null): Promise<CreditPassportDocument> {
    const caller = requireActor(actor);
    return this.telemetry.withSpan('credit_passport.assemble', { 'user.id': caller.id }, async () => {
      const started = Date.now();
      const credential = await this.issueOrRefresh(caller);
      this.telemetry.record('credit_passport.assembly_latency_ms', Date.now() - started);
      const chain = verifyCredentialChain(caller.id, await this.credentials.listByUserId(caller.id));
      return { credential, chain, qr: this.qrFor(credential) };
    });
  }

  /**
   * Consent-scoped share: records the NDPA consent and creates an expiring
   * disclosure that authorises the named partner to read THIS credential
   * version through the partner API (scope credit-passport:read).
   */
  async share(actor: User | null, input: SharePassportInput): Promise<CreditPassportDisclosure> {
    const caller = requireActor(actor);
    const partnerId = input.partnerId?.trim();
    if (!partnerId) {
      throw new BadRequestException('partnerId is required — disclosures name one partner');
    }
    const hours = input.expiresInHours ?? DISCLOSURE_DEFAULT_HOURS;
    if (
      !Number.isInteger(hours) ||
      hours < DISCLOSURE_MIN_HOURS ||
      hours > DISCLOSURE_MAX_HOURS
    ) {
      throw new BadRequestException(
        `expiresInHours must be an integer between ${DISCLOSURE_MIN_HOURS} and ${DISCLOSURE_MAX_HOURS}`
      );
    }
    const { credential } = await this.getMine(caller);

    const now = new Date();
    const nowIso = now.toISOString();
    // NDPA consent recorded in identity consent storage (same record the
    // partner-api consent checks use), in the same service action.
    await this.consents.create({
      id: newId('consent'),
      userId: caller.id,
      purpose: CREDIT_PASSPORT_SHARE_CONSENT_PURPOSE,
      granted: true,
      source: 'credit_passport.share',
      grantedAt: nowIso
    });
    const disclosure: CreditPassportDisclosure = {
      id: newId('crpd'),
      credentialId: credential.id,
      userId: caller.id,
      disclosedTo: partnerId,
      scope: CREDIT_PASSPORT_READ_SCOPE,
      consentRecordedAt: nowIso,
      expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
      createdAt: nowIso
    };
    await this.disclosures.create(disclosure);
    await this.audit.record({
      actorId: caller.id,
      action: 'credit_passport.shared',
      entityType: 'credit_passport_disclosure',
      entityId: disclosure.id,
      metadata: { credentialId: credential.id, disclosedTo: partnerId, expiresAt: disclosure.expiresAt }
    });
    await this.events.publish(
      'credit_passport.disclosure.shared',
      {
        disclosureId: disclosure.id,
        credentialId: credential.id,
        userId: caller.id,
        disclosedTo: partnerId,
        expiresAt: disclosure.expiresAt
      },
      caller.id
    );
    this.telemetry.increment('credit_passport.shares_total');
    return disclosure;
  }

  /** Disclosures the farmer has granted (most recent first). */
  async listMyDisclosures(actor: User | null): Promise<CreditPassportDisclosure[]> {
    const caller = requireActor(actor);
    const records = await this.disclosures.find({ userId: caller.id });
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Farmer (or admin) revocation — terminal. Verification and partner reads
   * fail closed from this point; the chain rows are retained for audit.
   */
  async revoke(actor: User | null): Promise<CreditPassportCredential> {
    const caller = requireActor(actor);
    const credential = await this.credentials.findActiveByUserId(caller.id);
    if (!credential) {
      throw new NotFoundException('No active credit passport to revoke');
    }
    const revokedAt = new Date().toISOString();
    const updated = await this.credentials.update(credential.id, {
      status: 'revoked',
      revokedAt
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'credit_passport.revoked',
      entityType: 'credit_passport_credential',
      entityId: credential.id,
      metadata: { userId: caller.id, version: credential.version }
    });
    await this.events.publish(
      'credit_passport.credential.revoked',
      { credentialId: credential.id, userId: caller.id, version: credential.version },
      caller.id
    );
    return updated;
  }

  /* ------------------------ public verification ------------------------- */

  /**
   * UNAUTHENTICATED public verification (QR flow). The HMAC-signed code is
   * verified server-side; forged or malformed codes answer 404 (no oracle on
   * which part failed). Revoked and superseded credentials answer 404 as
   * well — only the active chain head verifies. The view is redacted:
   * initials-only holder identity, per-section basis badges and coarse
   * counts — never kobo amounts or certificate codes.
   */
  async verifyPublic(passportCode: string): Promise<PublicCreditPassportVerification> {
    const parsed = parsePassportCode(passportCode);
    if (!parsed) {
      throw new NotFoundException('Credit passport code is invalid or unknown');
    }
    const credential = await this.credentials.findByCode(passportCode.trim());
    if (
      !credential ||
      credential.id !== parsed.credentialId ||
      credential.status !== 'active' ||
      !verifyPassportCode(
        {
          credentialId: credential.id,
          userId: credential.userId,
          nonce: credential.codeNonce
        },
        parsed.signaturePrefix,
        credential.codeSignature,
        this.codeSecret
      )
    ) {
      throw new NotFoundException('Credit passport code is invalid or unknown');
    }
    this.telemetry.increment('credit_passport.verify_hits_total');
    const holder = await this.users.getById(credential.userId);
    const chain = verifyCredentialChain(
      credential.userId,
      await this.credentials.listByUserId(credential.userId)
    );
    const sections: PublicCreditPassportVerification['sections'] = {};
    const { payload } = credential;
    if (payload.repayment) {
      sections.repayment = {
        basis: payload.repayment.basis,
        decisional: payload.repayment.decisional,
        loanCount: payload.repayment.data.loanCount,
        onTimeRatio: payload.repayment.data.onTimeRatio
      };
    }
    if (payload.certificates) {
      sections.certificates = {
        basis: payload.certificates.basis,
        decisional: payload.certificates.decisional,
        count: payload.certificates.data.count
      };
    }
    if (payload.vsla) {
      sections.vsla = {
        basis: payload.vsla.basis,
        decisional: payload.vsla.decisional,
        groupsJoined: payload.vsla.data.groupsJoined
      };
    }
    if (payload.geoFactor) {
      sections.geoFactor = {
        basis: payload.geoFactor.basis,
        decisional: false,
        factorScore: payload.geoFactor.data.factorScore
      };
    }
    return {
      verified: true,
      passportCode: credential.passportCode,
      status: credential.status,
      version: credential.version,
      holderInitials: initialsOf(holder.fullName),
      sections,
      chain: { versionCount: chain.versionCount, valid: chain.valid, headHash: chain.headHash },
      qr: this.qrFor(credential),
      disclaimers: [
        'This verification view is redacted: the holder is identified by initials only and sections carry provenance badges, not financial detail.',
        payload.geoFactor
          ? 'The geo-verification factor is a SHADOW signal: computed in shadow mode and not used in any credit decision (non-decisional).'
          : 'No geo-verification factor is attached to this credential.',
        'The credit passport aggregates platform records; it is not a government-issued document.'
      ]
    };
  }

  /* ---------------------------- partner read ---------------------------- */

  /**
   * Partner-API read (scope credit-passport:read enforced by
   * PartnerAuthGuard at the route). Record-level authorisation: the farmer
   * must hold an active credential AND an unexpired, unrevoked disclosure
   * naming this partner (token partner binding or client id) with the
   * credit-passport:read scope — otherwise 403/404, fail closed.
   */
  async readForPartner(
    identity: { clientId: string; partnerId?: string },
    userId: string
  ): Promise<PartnerCreditPassportView> {
    const credential = await this.credentials.findActiveByUserId(userId);
    if (!credential) {
      throw new NotFoundException(`User '${userId}' holds no active credit passport`);
    }
    const partnerKeys = [identity.partnerId, identity.clientId].filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    );
    const nowIso = new Date().toISOString();
    const granted = await this.disclosures.find({ credentialId: credential.id });
    const disclosure = granted.find(
      (record) =>
        partnerKeys.includes(record.disclosedTo) &&
        record.scope === CREDIT_PASSPORT_READ_SCOPE &&
        !record.revokedAt &&
        record.expiresAt > nowIso
    );
    if (!disclosure) {
      throw new ForbiddenException(
        'No active consent-scoped disclosure authorises this partner to read the credit passport (expired, revoked or never granted)'
      );
    }
    await this.audit.record({
      actorId: identity.clientId,
      action: 'credit_passport.partner_read',
      entityType: 'credit_passport_credential',
      entityId: credential.id,
      metadata: { userId, disclosureId: disclosure.id, disclosedTo: disclosure.disclosedTo }
    });
    const chain = verifyCredentialChain(userId, await this.credentials.listByUserId(userId));
    return {
      credential,
      chain,
      disclosure: { id: disclosure.id, expiresAt: disclosure.expiresAt }
    };
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * Issues version 1 when none exists; appends a new chain version when the
   * freshly composed payload differs from the active head's payload hash.
   * The previous head is marked 'superseded' (retained for the chain).
   */
  private async issueOrRefresh(caller: User): Promise<CreditPassportCredential> {
    const payload = await this.assemblePayload(caller);
    const versions = await this.credentials.listByUserId(caller.id);
    const head = versions.length > 0 ? versions[versions.length - 1] : undefined;
    const existing = head && head.status === 'active' ? head : undefined;
    if (existing) {
      // Material-change check: recompute the hash AS the existing version —
      // unchanged inputs must reproduce the stored head exactly.
      const sameHeadHash = computeCredentialHash(
        credentialHashPayloadOf({
          userId: caller.id,
          version: existing.version,
          payload,
          prevHash: existing.prevHash
        })
      );
      if (existing.payloadHash === sameHeadHash) {
        return existing;
      }
    }
    const version = versions.length + 1;
    // Chain continuity is per farmer regardless of status: a re-issue after
    // revocation links to the revoked head, keeping one unbroken chain.
    const prevHash = head ? head.payloadHash : GENESIS_PREV_HASH;
    const payloadHash = computeCredentialHash(
      credentialHashPayloadOf({ userId: caller.id, version, payload, prevHash })
    );

    const nowIso = new Date().toISOString();
    const id = newId('crp');
    const nonce = randomBytes(4).toString('hex');
    const signature = signPassportCode({ credentialId: id, userId: caller.id, nonce }, this.codeSecret);
    const credential: CreditPassportCredential = {
      id,
      userId: caller.id,
      version,
      payload,
      payloadHash,
      prevHash,
      passportCode: formatPassportCode(id, nonce, signature),
      codeNonce: nonce,
      codeSignature: signature,
      status: 'active',
      issuedBy: caller.id,
      issuedAt: nowIso
    };
    // Supersede the previous head BEFORE inserting the new active version:
    // the one-active-credential-per-user invariant is enforced by the
    // repository (pg: partial unique index) and would reject two actives.
    if (existing) {
      await this.credentials.update(existing.id, { status: 'superseded' });
    }
    await this.credentials.create(credential);
    const eventName = existing
      ? 'credit_passport.credential.versioned'
      : 'credit_passport.credential.issued';
    await this.audit.record({
      actorId: caller.id,
      action: `credit_passport.${existing ? 'versioned' : 'issued'}`,
      entityType: 'credit_passport_credential',
      entityId: credential.id,
      metadata: { userId: caller.id, version, payloadHash }
    });
    await this.events.publish(
      eventName,
      { credentialId: credential.id, userId: caller.id, version, payloadHash },
      caller.id
    );
    return credential;
  }

  /**
   * Composes the passport payload from the owning modules' repositories.
   * Each section is isolated: a failing source omits that section rather
   * than failing (or worse, fabricating) the whole passport.
   */
  private async assemblePayload(caller: User): Promise<CreditPassportPayload> {
    const loans = await this.loans.find({ applicantUserId: caller.id });
    const payload: CreditPassportPayload = {
      holder: { userId: caller.id, fullName: caller.fullName }
    };

    const repayment = await this.sectionOrUndefined(() => this.buildRepaymentSection(loans));
    if (repayment) {
      payload.repayment = repayment;
    }
    const certificates = await this.sectionOrUndefined(() => this.buildCertificatesSection(caller.id));
    if (certificates) {
      payload.certificates = certificates;
    }
    const vsla = await this.sectionOrUndefined(() => this.buildVslaSection(caller.id));
    if (vsla) {
      payload.vsla = vsla;
    }
    const geoFactor = await this.sectionOrUndefined(() => this.buildGeoFactorSection(loans));
    if (geoFactor) {
      payload.geoFactor = geoFactor;
    }
    return payload;
  }

  /** Isolation wrapper: a failing section source omits the section (never fabricates). */
  private async sectionOrUndefined<T>(build: () => Promise<T>): Promise<T | undefined> {
    try {
      return await build();
    } catch {
      return undefined;
    }
  }

  /** Repayment history — LIVE basis, composed from the credit suite. */
  private async buildRepaymentSection(
    loans: Awaited<ReturnType<CreditLoanRepository['find']>>
  ): Promise<PassportSection<RepaymentSectionData>> {
    const schedules: CreditRepayment[] = [];
    for (const loan of loans) {
      schedules.push(...(await this.repayments.find({ loanId: loan.id })));
    }
    const paid = schedules.filter((entry) => entry.status === 'paid');
    const lateOrMissed = schedules.filter(
      (entry) => entry.status === 'late' || entry.status === 'missed'
    );
    const data: RepaymentSectionData = {
      loanCount: loans.length,
      completedLoans: loans.filter((loan) => loan.status === 'repaid').length,
      activeLoans: loans.filter(
        (loan) => loan.status === 'disbursed' || loan.status === 'repaying'
      ).length,
      defaultedLoans: loans.filter(
        (loan) => loan.status === 'defaulted' || loan.status === 'written_off'
      ).length,
      installmentsDue: schedules.length,
      installmentsPaid: paid.length,
      installmentsLateOrMissed: lateOrMissed.length,
      onTimeRatio: schedules.length === 0 ? 0 : paid.length / schedules.length,
      totalBorrowedKobo: loans.reduce((sum, loan) => sum + loan.principalKobo, 0),
      totalRepaidKobo: paid.reduce((sum, entry) => sum + (entry.paidAmountKobo ?? entry.amountKobo), 0)
    };
    return { basis: 'live', decisional: true, data };
  }

  /** Learning certificates — LIVE basis, composed from the learning module. */
  private async buildCertificatesSection(
    userId: string
  ): Promise<PassportSection<CertificatesSectionData>> {
    const earned = await this.certificates.find({ userId });
    return {
      basis: 'live',
      decisional: true,
      data: {
        count: earned.length,
        certificates: earned.map((certificate) => ({
          id: certificate.id,
          courseId: certificate.courseId,
          verificationCode: certificate.verificationCode,
          issuedAt: certificate.issuedAt
        }))
      }
    };
  }

  /** VSLA discipline — LIVE basis, composed from the vsla-carbon module. */
  private async buildVslaSection(userId: string): Promise<PassportSection<VslaSectionData>> {
    const memberships = await this.vslaMembers.find({ userId });
    let shareOutsReceived = 0;
    let totalSharedOutKobo = 0;
    let totalContributedKobo = 0;
    let loansTaken = 0;
    let loansRepaidInFull = 0;
    let loansOutstanding = 0;
    for (const membership of memberships) {
      const shareOuts = await this.vslaShareOuts.find({ memberId: membership.id });
      shareOutsReceived += shareOuts.length;
      totalSharedOutKobo += shareOuts.reduce((sum, record) => sum + record.shareKobo, 0);
      totalContributedKobo += shareOuts.reduce((sum, record) => sum + record.contributedKobo, 0);
      const memberLoans = await this.vslaLoans.find({ memberId: membership.id });
      loansTaken += memberLoans.length;
      loansRepaidInFull += memberLoans.filter((loan) => loan.status === 'REPAID').length;
      loansOutstanding += memberLoans.filter((loan) => loan.status === 'ACTIVE').length;
    }
    return {
      basis: 'live',
      decisional: true,
      data: {
        groupsJoined: memberships.length,
        activeMemberships: memberships.filter((member) => member.status === 'ACTIVE').length,
        shareOutsReceived,
        totalSharedOutKobo,
        totalContributedKobo,
        loansTaken,
        loansRepaidInFull,
        loansOutstanding
      }
    };
  }

  /**
   * Geo-verification factor — SHADOW basis, ALWAYS non-decisional (the
   * geo-credit module's hard constraint). Reads the farmer's latest shadow
   * score across their loan applications; when none exists the section is
   * still emitted with an honest 'unavailable' badge, never fabricated.
   */
  private async buildGeoFactorSection(
    loans: Awaited<ReturnType<CreditLoanRepository['find']>>
  ): Promise<PassportSection<GeoFactorSectionData>> {
    let latest: { computedAt: string; score: GeoFactorSectionData } | undefined;
    for (const loan of loans) {
      const scores = await this.geoShadow.find({ applicationId: loan.id });
      for (const score of scores) {
        if (!latest || score.computedAt > latest.computedAt) {
          latest = {
            computedAt: score.computedAt,
            score: {
              factorScore: score.factorScore,
              status: score.status,
              inputBasis: { flood: score.basis.flood, crop: score.basis.crop },
              computedAt: score.computedAt
            }
          };
        }
      }
    }
    if (!latest) {
      return {
        basis: 'unavailable',
        decisional: false,
        data: {
          factorScore: null,
          status: 'unavailable',
          inputBasis: { flood: 'unavailable', crop: 'unavailable' },
          computedAt: null
        }
      };
    }
    return { basis: 'shadow', decisional: false, data: latest.score };
  }

  private qrFor(credential: CreditPassportCredential): { code: string; verifyPath: string } {
    return {
      code: credential.passportCode,
      verifyPath: `/api/v1/credit-passport/verify/${encodeURIComponent(credential.passportCode)}`
    };
  }
}
