import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Certificate,
  CreditLoanApplication,
  CreditRepayment,
  User
} from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { InMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
import { InMemoryConsentRepository } from '../../database/repositories/consent.repository.js';
import {
  createInMemoryCreditPassportCredentialRepository,
  createInMemoryCreditPassportDisclosureRepository
} from '../../database/repositories/credit-passport.repository.js';
import {
  InMemoryCreditLoanRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { GeoCreditShadowRecord } from '../../database/repositories/geo-credit-shadow.repository.js';
import { InMemoryGeoCreditShadowRepository } from '../../database/repositories/geo-credit-shadow.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  InMemoryVslaLoanRepository,
  InMemoryVslaMemberRepository,
  InMemoryVslaShareOutRepository,
  type VslaLoanRecord,
  type VslaMemberRecord,
  type VslaShareOutRecord
} from '../../database/repositories/vsla-carbon.repository.js';
import {
  CREDIT_PASSPORT_READ_SCOPE,
  CREDIT_PASSPORT_SHARE_CONSENT_PURPOSE,
  CreditPassportService
} from './credit-passport.service.js';
import {
  computeCredentialHash,
  credentialHashPayloadOf,
  GENESIS_PREV_HASH,
  verifyCredentialChain,
  type CreditPassportCredential
} from './credit-passport.types.js';
import { formatPassportCode, parsePassportCode, signPassportCode } from './passport-code.js';

const farmer: User = {
  id: 'farmer-1',
  phone: '+2348000000000',
  fullName: 'Adamu Bello',
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  roles: ['farmer'],
  createdAt: '2026-01-01T00:00:00.000Z'
};

const LOAN_REPAID: CreditLoanApplication = {
  id: 'loan-1',
  applicantUserId: farmer.id,
  productId: 'prod-1',
  principalKobo: 50_000_00,
  status: 'repaid',
  createdAt: '2025-09-01T00:00:00.000Z',
  updatedAt: '2026-01-10T00:00:00.000Z'
};

const LOAN_ACTIVE: CreditLoanApplication = {
  id: 'loan-2',
  applicantUserId: farmer.id,
  productId: 'prod-1',
  principalKobo: 80_000_00,
  status: 'repaying',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z'
};

const REPAYMENTS: CreditRepayment[] = [
  {
    id: 'rep-1',
    loanId: 'loan-1',
    sequence: 1,
    dueAt: '2025-12-01T00:00:00.000Z',
    amountKobo: 25_000_00,
    paidAt: '2025-11-28T00:00:00.000Z',
    paidAmountKobo: 25_000_00,
    status: 'paid'
  },
  {
    id: 'rep-2',
    loanId: 'loan-1',
    sequence: 2,
    dueAt: '2026-01-01T00:00:00.000Z',
    amountKobo: 25_000_00,
    paidAt: '2026-01-02T00:00:00.000Z',
    paidAmountKobo: 25_000_00,
    status: 'paid'
  },
  {
    id: 'rep-3',
    loanId: 'loan-2',
    sequence: 1,
    dueAt: '2026-03-01T00:00:00.000Z',
    amountKobo: 40_000_00,
    paidAt: '2026-03-01T10:00:00.000Z',
    paidAmountKobo: 40_000_00,
    status: 'paid'
  },
  {
    id: 'rep-4',
    loanId: 'loan-2',
    sequence: 2,
    dueAt: '2026-04-01T00:00:00.000Z',
    amountKobo: 40_000_00,
    status: 'missed'
  }
];

const CERTIFICATE: Certificate = {
  id: 'cert-1',
  userId: farmer.id,
  courseId: 'course-agronomy-1',
  verificationCode: 'NYFN-CERT-2026-0042',
  issuedAt: '2026-02-15T00:00:00.000Z',
  verificationUrl: 'https://example.test/verify/NYFN-CERT-2026-0042'
};

const MEMBERSHIP: VslaMemberRecord = {
  id: 'mem-1',
  groupId: 'vsla-1',
  userId: farmer.id,
  role: 'member',
  status: 'ACTIVE',
  joinedAt: '2025-06-01T00:00:00.000Z'
};

const SHARE_OUT: VslaShareOutRecord = {
  id: 'so-1',
  cycleId: 'cyc-1',
  memberId: MEMBERSHIP.id,
  shareKobo: 12_000_00,
  contributedKobo: 10_000_00,
  residualKobo: 0,
  ledgerEntryId: 'le-1',
  createdAt: '2026-01-20T00:00:00.000Z'
};

const VSLA_LOAN: VslaLoanRecord = {
  id: 'vloan-1',
  groupId: 'vsla-1',
  cycleId: 'cyc-1',
  memberId: MEMBERSHIP.id,
  principalKobo: 5_000_00,
  interestRateBps: 500,
  totalDueKobo: 5_250_00,
  repaidKobo: 5_250_00,
  status: 'REPAID',
  issuedAt: '2025-08-01T00:00:00.000Z',
  repaidAt: '2025-11-01T00:00:00.000Z',
  ledgerEntryId: 'le-2',
  createdAt: '2025-08-01T00:00:00.000Z'
};

const SHADOW_SCORE: GeoCreditShadowRecord = {
  id: 'gcs-1',
  applicationId: LOAN_ACTIVE.id,
  factorScore: 72,
  status: 'computed',
  breakdown: {
    plotVerification: 25,
    areaPlausibility: 15,
    floodRisk: 16,
    cropHealth: 12,
    dataFreshness: 4
  },
  basis: { flood: 'live', crop: 'stub' },
  inputFingerprint: 'deadbeef',
  computedAt: '2026-03-05T00:00:00.000Z'
};

describe('CreditPassportService', () => {
  let credentials: ReturnType<typeof createInMemoryCreditPassportCredentialRepository>;
  let disclosures: ReturnType<typeof createInMemoryCreditPassportDisclosureRepository>;
  let loans: InMemoryCreditLoanRepository;
  let repayments: InMemoryCreditRepaymentRepository;
  let certificates: InMemoryCertificateRepository;
  let vslaMembers: InMemoryVslaMemberRepository;
  let vslaShareOuts: InMemoryVslaShareOutRepository;
  let vslaLoans: InMemoryVslaLoanRepository;
  let geoShadow: InMemoryGeoCreditShadowRepository;
  let consents: InMemoryConsentRepository;
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: CreditPassportService;

  const seed = (options: { shadowScores?: GeoCreditShadowRecord[] } | undefined = {}) => {
    credentials = createInMemoryCreditPassportCredentialRepository();
    disclosures = createInMemoryCreditPassportDisclosureRepository();
    loans = new InMemoryCreditLoanRepository([structuredClone(LOAN_REPAID), structuredClone(LOAN_ACTIVE)]);
    repayments = new InMemoryCreditRepaymentRepository(structuredClone(REPAYMENTS));
    certificates = new InMemoryCertificateRepository([structuredClone(CERTIFICATE)]);
    vslaMembers = new InMemoryVslaMemberRepository();
    vslaShareOuts = new InMemoryVslaShareOutRepository();
    vslaLoans = new InMemoryVslaLoanRepository();
    geoShadow = new InMemoryGeoCreditShadowRepository();
    for (const score of options.shadowScores ?? [SHADOW_SCORE]) {
      void geoShadow.upsert(structuredClone(score));
    }
    consents = new InMemoryConsentRepository();
    outbox = createInMemoryOutboxRepository();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    const users = {
      getById: vi.fn().mockImplementation(async (id: string) => {
        if (id !== farmer.id) {
          throw new NotFoundException(`User '${id}' not found`);
        }
        return farmer;
      })
    };
    service = new CreditPassportService(
      users as never,
      audit as never,
      new DomainEventsService(outbox),
      new TelemetryService(),
      credentials,
      disclosures,
      loans,
      repayments,
      certificates,
      vslaMembers,
      vslaShareOuts,
      vslaLoans,
      geoShadow,
      consents
    );
  };

  const seedVsla = async () => {
    await vslaMembers.create(structuredClone(MEMBERSHIP));
    await vslaShareOuts.create(structuredClone(SHARE_OUT));
    await vslaLoans.create(structuredClone(VSLA_LOAN));
  };

  beforeEach(() => seed());

  /* --------------------- payload assembly + basis badges --------------------- */

  describe('payload assembly', () => {
    it('assembles all sections with honest per-section basis badges', async () => {
      await seedVsla();
      const document = await service.getMine(farmer);
      const { payload } = document.credential;

      expect(payload.holder).toEqual({ userId: farmer.id, fullName: 'Adamu Bello' });

      expect(payload.repayment?.basis).toBe('live');
      expect(payload.repayment?.decisional).toBe(true);
      expect(payload.repayment?.data.loanCount).toBe(2);
      expect(payload.repayment?.data.completedLoans).toBe(1);
      expect(payload.repayment?.data.activeLoans).toBe(1);
      expect(payload.repayment?.data.installmentsDue).toBe(4);
      expect(payload.repayment?.data.installmentsPaid).toBe(3);
      expect(payload.repayment?.data.installmentsLateOrMissed).toBe(1);
      expect(payload.repayment?.data.onTimeRatio).toBeCloseTo(3 / 4);
      expect(payload.repayment?.data.totalBorrowedKobo).toBe(130_000_00);

      expect(payload.certificates?.basis).toBe('live');
      expect(payload.certificates?.decisional).toBe(true);
      expect(payload.certificates?.data.count).toBe(1);
      expect(payload.certificates?.data.certificates[0]?.verificationCode).toBe(
        'NYFN-CERT-2026-0042'
      );

      expect(payload.vsla?.basis).toBe('live');
      expect(payload.vsla?.decisional).toBe(true);
      expect(payload.vsla?.data.groupsJoined).toBe(1);
      expect(payload.vsla?.data.shareOutsReceived).toBe(1);
      expect(payload.vsla?.data.totalSharedOutKobo).toBe(12_000_00);
      expect(payload.vsla?.data.loansRepaidInFull).toBe(1);

      // Geo factor: SHADOW and hard non-decisional, mirroring the geo-credit constraint.
      expect(payload.geoFactor?.basis).toBe('shadow');
      expect(payload.geoFactor?.decisional).toBe(false);
      expect(payload.geoFactor?.data.factorScore).toBe(72);
      expect(payload.geoFactor?.data.inputBasis).toEqual({ flood: 'live', crop: 'stub' });
    });

    it('badges the geo factor unavailable (never fabricated) when no shadow score exists', async () => {
      seed({ shadowScores: [] });
      const document = await service.getMine(farmer);
      const geo = document.credential.payload.geoFactor;
      expect(geo?.basis).toBe('unavailable');
      expect(geo?.decisional).toBe(false);
      expect(geo?.data.factorScore).toBeNull();
      expect(geo?.data.status).toBe('unavailable');
    });

    it('omits a section whose source fails instead of fabricating it', async () => {
      vi.spyOn(certificates, 'find').mockRejectedValue(new Error('store down'));
      const document = await service.getMine(farmer);
      expect(document.credential.payload.certificates).toBeUndefined();
      expect(document.credential.payload.repayment?.basis).toBe('live');
    });

    it('requires authentication', async () => {
      await expect(service.getMine(null)).rejects.toThrow('Authentication required');
    });
  });

  /* --------------------------- hash chain --------------------------- */

  describe('credential hash chain', () => {
    it('issues version 1 anchored at the genesis prev-hash and verifies', async () => {
      const document = await service.getMine(farmer);
      expect(document.credential.version).toBe(1);
      expect(document.credential.prevHash).toBe(GENESIS_PREV_HASH);
      expect(document.credential.payloadHash).toBe(
        computeCredentialHash(credentialHashPayloadOf(document.credential))
      );
      expect(document.chain.valid).toBe(true);
      expect(document.chain.versionCount).toBe(1);
    });

    it('returns the stored head unchanged when nothing material changed', async () => {
      const first = await service.getMine(farmer);
      const second = await service.getMine(farmer);
      expect(second.credential.id).toBe(first.credential.id);
      expect(second.credential.version).toBe(1);
    });

    it('appends a new linked chain version on material change', async () => {
      const first = await service.getMine(farmer);
      await certificates.create({
        id: 'cert-2',
        userId: farmer.id,
        courseId: 'course-finance-1',
        verificationCode: 'NYFN-CERT-2026-0043',
        issuedAt: '2026-04-01T00:00:00.000Z',
        verificationUrl: 'https://example.test/verify/NYFN-CERT-2026-0043'
      });
      const second = await service.getMine(farmer);

      expect(second.credential.version).toBe(2);
      expect(second.credential.prevHash).toBe(first.credential.payloadHash);
      expect(second.credential.id).not.toBe(first.credential.id);
      expect(second.chain.valid).toBe(true);
      expect(second.chain.versionCount).toBe(2);

      // The superseded head is retained and no longer active (one active per user).
      const storedFirst = await credentials.getById(first.credential.id);
      expect(storedFirst.status).toBe('superseded');
      const actives = await credentials.find({ userId: farmer.id, status: 'active' });
      expect(actives).toHaveLength(1);
      expect(actives[0]?.id).toBe(second.credential.id);
    });

    it('detects payload tampering and chain surgery on recomputation', () => {
      const base: CreditPassportCredential = {
        id: 'crp-a',
        userId: farmer.id,
        version: 1,
        payload: { holder: { userId: farmer.id, fullName: 'Adamu Bello' } },
        payloadHash: '',
        prevHash: GENESIS_PREV_HASH,
        passportCode: 'CRP.crp-a.00000000.0000000000000000',
        codeNonce: '00000000',
        codeSignature: '0'.repeat(64),
        status: 'active',
        issuedBy: farmer.id,
        issuedAt: '2026-01-01T00:00:00.000Z'
      };
      base.payloadHash = computeCredentialHash(credentialHashPayloadOf(base));
      const second: CreditPassportCredential = {
        ...base,
        id: 'crp-b',
        version: 2,
        prevHash: base.payloadHash,
        status: 'active'
      };
      second.payloadHash = computeCredentialHash(credentialHashPayloadOf(second));

      expect(verifyCredentialChain(farmer.id, [base, second]).valid).toBe(true);

      // Payload tampering: rewritten facts break the stored hash.
      const tampered = { ...base, payload: { holder: { userId: farmer.id, fullName: 'Forged Name' } } };
      const tamperedResult = verifyCredentialChain(farmer.id, [tampered, second]);
      expect(tamperedResult.valid).toBe(false);
      expect(tamperedResult.versions[0]?.hashValid).toBe(false);

      // Chain surgery: a version gap breaks the prev-link and sequence checks.
      const gapResult = verifyCredentialChain(farmer.id, [second]);
      expect(gapResult.valid).toBe(false);
      expect(gapResult.versions[0]?.prevLinkValid).toBe(false);
    });
  });

  /* --------------------------- public verify --------------------------- */

  describe('verifyPublic', () => {
    it('verifies a genuine code with a minimal, PII-redacted projection', async () => {
      await seedVsla();
      const document = await service.getMine(farmer);
      const result = await service.verifyPublic(document.credential.passportCode);

      expect(result.verified).toBe(true);
      expect(result.version).toBe(1);
      expect(result.holderInitials).toBe('A.B.');
      expect(result.chain.valid).toBe(true);
      expect(result.sections.repayment?.basis).toBe('live');
      expect(result.sections.geoFactor?.basis).toBe('shadow');
      expect(result.sections.geoFactor?.decisional).toBe(false);
      expect(result.qr.verifyPath).toContain('/api/v1/credit-passport/verify/');

      // PII minimality: no full name, no kobo amounts, no certificate codes.
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('Adamu');
      expect(serialised).not.toContain('Kobo');
      expect(serialised).not.toContain('NYFN-CERT');
      expect(serialised).not.toContain(farmer.phone);
    });

    it('answers 404 for forged or malformed codes (no oracle)', async () => {
      const document = await service.getMine(farmer);
      await expect(service.verifyPublic('not-a-code')).rejects.toThrow(NotFoundException);
      // A well-formed but forged signature must fail identically.
      const forged = formatPassportCode(
        document.credential.id,
        'ffffffff',
        signPassportCode(
          { credentialId: document.credential.id, userId: farmer.id, nonce: 'ffffffff' },
          'attacker-controlled-secret'
        )
      );
      await expect(service.verifyPublic(forged)).rejects.toThrow(NotFoundException);
    });

    it('revocation invalidates verification (fail closed)', async () => {
      const document = await service.getMine(farmer);
      await service.verifyPublic(document.credential.passportCode); // verifies while active
      await service.revoke(farmer);
      await expect(service.verifyPublic(document.credential.passportCode)).rejects.toThrow(
        NotFoundException
      );
      const actives = await credentials.find({ userId: farmer.id, status: 'active' });
      expect(actives).toHaveLength(0);
    });

    it('superseded versions no longer verify', async () => {
      const first = await service.getMine(farmer);
      await certificates.create({
        id: 'cert-2',
        userId: farmer.id,
        courseId: 'course-finance-1',
        verificationCode: 'NYFN-CERT-2026-0043',
        issuedAt: '2026-04-01T00:00:00.000Z',
        verificationUrl: 'https://example.test/verify/NYFN-CERT-2026-0043'
      });
      await service.getMine(farmer); // versions the credential
      await expect(service.verifyPublic(first.credential.passportCode)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  /* ----------------------- share + partner read ----------------------- */

  describe('share + partner read', () => {
    it('records NDPA consent and creates an expiring disclosure on share', async () => {
      const disclosure = await service.share(farmer, { partnerId: 'partner-9', expiresInHours: 48 });
      expect(disclosure.disclosedTo).toBe('partner-9');
      expect(disclosure.scope).toBe(CREDIT_PASSPORT_READ_SCOPE);
      expect(disclosure.expiresAt > disclosure.consentRecordedAt).toBe(true);

      const consentRecords = await consents.find({ userId: farmer.id });
      expect(
        consentRecords.some(
          (record) =>
            record.purpose === CREDIT_PASSPORT_SHARE_CONSENT_PURPOSE &&
            record.granted &&
            !record.revokedAt
        )
      ).toBe(true);

      const events = await outbox.list();
      expect(events.some((event) => event.name === 'credit_passport.disclosure.shared')).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'credit_passport.shared', actorId: farmer.id })
      );
    });

    it('enforces disclosure lifetime bounds', async () => {
      await expect(service.share(farmer, { partnerId: 'p', expiresInHours: 0 })).rejects.toThrow(
        BadRequestException
      );
      await expect(
        service.share(farmer, { partnerId: 'p', expiresInHours: 24 * 365 })
      ).rejects.toThrow(BadRequestException);
      await expect(service.share(farmer, { partnerId: '' })).rejects.toThrow(BadRequestException);
    });

    it('serves the full payload to a disclosed partner', async () => {
      await service.share(farmer, { partnerId: 'partner-9' });
      const view = await service.readForPartner(
        { clientId: 'pc_abc', partnerId: 'partner-9' },
        farmer.id
      );
      expect(view.credential.payload.repayment?.data.loanCount).toBe(2);
      expect(view.disclosure.expiresAt).toBeTruthy();
      expect(view.chain.valid).toBe(true);
    });

    it('rejects partner reads without a disclosure, for the wrong partner, or when expired', async () => {
      await service.getMine(farmer); // credential exists but was never shared
      await expect(
        service.readForPartner({ clientId: 'pc_abc', partnerId: 'partner-9' }, farmer.id)
      ).rejects.toThrow(ForbiddenException);

      // Shared with a different partner.
      await service.share(farmer, { partnerId: 'partner-10' });
      await expect(
        service.readForPartner({ clientId: 'pc_abc', partnerId: 'partner-9' }, farmer.id)
      ).rejects.toThrow(ForbiddenException);

      // Expired disclosure.
      const { credential } = await service.getMine(farmer);
      await disclosures.create({
        id: 'crpd-expired',
        credentialId: credential.id,
        userId: farmer.id,
        disclosedTo: 'partner-9',
        scope: CREDIT_PASSPORT_READ_SCOPE,
        consentRecordedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z'
      });
      await expect(
        service.readForPartner({ clientId: 'pc_abc', partnerId: 'partner-9' }, farmer.id)
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects partner reads for users without an active credential (404)', async () => {
      await expect(
        service.readForPartner({ clientId: 'pc_abc', partnerId: 'partner-9' }, 'unknown-user')
      ).rejects.toThrow(NotFoundException);
    });
  });

  /* --------------------- one active credential per user --------------------- */

  describe('one active credential per user', () => {
    it('the repository refuses a second ACTIVE credential for the same user', async () => {
      const document = await service.getMine(farmer);
      const duplicate: CreditPassportCredential = {
        ...document.credential,
        id: 'crp-duplicate',
        version: 2,
        passportCode: 'CRP.crp-duplicate.11111111.2222222222222222',
        payloadHash: 'f'.repeat(64)
      };
      await expect(credentials.create(duplicate)).rejects.toThrow(ConflictException);
    });

    it('revoke is terminal: re-issue after revocation starts a new chain', async () => {
      const first = await service.getMine(farmer);
      await service.revoke(farmer);
      const second = await service.getMine(farmer);
      expect(second.credential.version).toBe(2);
      expect(second.credential.prevHash).toBe(first.credential.payloadHash);
      expect(second.chain.valid).toBe(true);
    });
  });

  /* --------------------------- code helpers --------------------------- */

  describe('passport code helpers', () => {
    it('round-trips the wire format and rejects malformed codes', () => {
      const code = formatPassportCode('crp-123', 'a1b2c3d4', 'e'.repeat(64));
      expect(code).toBe('CRP.crp-123.a1b2c3d4.' + 'e'.repeat(16));
      expect(parsePassportCode(code)).toEqual({
        credentialId: 'crp-123',
        nonce: 'a1b2c3d4',
        signaturePrefix: 'e'.repeat(16)
      });
      expect(parsePassportCode('CRP.only-two.a1b2c3d4')).toBeUndefined();
      expect(parsePassportCode('CRP.crp-1.NOTHEX!!.' + 'e'.repeat(16))).toBeUndefined();
      expect(parsePassportCode('CRP.crp-1.a1b2c3d4.tooshort')).toBeUndefined();
      expect(parsePassportCode('')).toBeUndefined();
    });
  });
});
