import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import {
  createInMemoryBeneficiaryRepository,
  createInMemoryInputVoucherRepository,
  createInMemoryProgrammeFundingRepository,
  createInMemoryRedemptionRepository,
  createInMemorySubsidyProgrammeRepository,
  type InMemoryProgrammeFundingRepository
} from '../../database/repositories/input-vouchers.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { StubIdentityDriver, stubIdentityResult } from '../input-vouchers/identity.driver.js';
import {
  InputVouchersService,
  PLATFORM_SUBSIDY_BUDGET_ACCOUNT,
  programmeLiabilityAccountCode,
  type ActorRef
} from '../input-vouchers/input-vouchers.service.js';
import { UsersService } from '../users/users.service.js';
import {
  VOUCHER_STUCK_SWEEPER_CONSUMER,
  VoucherStuckSweeperService
} from './voucher-stuck-sweeper.service.js';

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };
const PAST = '2020-01-01T00:00:00.000Z';

let ninSeed = 50000000000;

function verifiedNin(): string {
  for (let candidate = ninSeed; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate).padStart(11, '0');
    if (stubIdentityResult(nin).verified) {
      ninSeed = candidate + 137;
      return nin;
    }
  }
  throw new Error('no verifiable stub NIN found');
}

async function makeCtx(wrapFunding?: (funding: InMemoryProgrammeFundingRepository) => InMemoryProgrammeFundingRepository) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const programmes = createInMemorySubsidyProgrammeRepository();
  const vouchers = createInMemoryInputVoucherRepository();
  const redemptions = createInMemoryRedemptionRepository();
  let funding = createInMemoryProgrammeFundingRepository();
  if (wrapFunding) {
    funding = wrapFunding(funding);
  }
  const service = new InputVouchersService(
    programmes,
    createInMemoryBeneficiaryRepository(),
    vouchers,
    redemptions,
    funding,
    ledger,
    users,
    events,
    new StubIdentityDriver(),
    undefined,
    {}
  );
  const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
  const sweeper = new VoucherStuckSweeperService(service, dedup, vouchers);
  const farmer = await users.create({
    phone: '+2348000000012',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const supplier = await users.create({
    phone: '+2348000000014',
    fullName: 'Dealer Dapo',
    roles: ['supplier'],
    preferredLanguage: 'en'
  });
  const programme = await service.createProgramme(
    {
      name: '2026 wet-season fertiliser',
      sponsor: 'FMARD / state programme (STUB demo)',
      perFarmerCapKobo: 5_000_000,
      budgetKobo: 10_000_000
    },
    ADMIN.id
  );
  await service.activateProgramme(programme.id, ADMIN.id);
  await service.fundProgramme(
    programme.id,
    { amountKobo: 10_000_000, idempotencyKey: `fund-${programme.id}` },
    ADMIN.id
  );
  await service.verifyBeneficiary(
    programme.id,
    { farmerId: farmer.id, nin: verifiedNin(), fullName: 'Farmer Femi', state: 'Kano', primaryCrop: 'maize' },
    ADMIN.id
  );
  return { service, sweeper, dedup, ledger, farmer, supplier, programme, vouchers, redemptions, funding };
}

type Ctx = Awaited<ReturnType<typeof makeCtx>>;

let allocSeq = 0;

async function issuedVoucher(ctx: Ctx, amountKobo = 200_000) {
  allocSeq += 1;
  const voucher = await ctx.service.allocateVoucher(
    ctx.programme.id,
    { farmerId: ctx.farmer.id, amountKobo, idempotencyKey: `alloc-sweep-${allocSeq}` },
    ADMIN.id
  );
  await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
  return voucher;
}

/** Moves an ISSUED voucher to a past expiry (the sweep clock is the record's own). */
async function ageToExpired(ctx: Ctx, voucherId: string) {
  return ctx.vouchers.updateExpected(voucherId, { expiresAt: PAST }, { status: 'ISSUED' });
}

describe('VoucherStuckSweeperService (WP-G12)', () => {
  it('expires due ISSUED vouchers with balanced compensating postings', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    await ageToExpired(ctx, voucher.id);

    const result = await ctx.sweeper.sweep();
    expect(result).toMatchObject({ scanned: 1, expired: 1, conflicts: 0, failed: 0 });
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('EXPIRED');

    // The compensating release posting is balanced (DR liability / CR budget)
    // and keyed on the voucher — the sweeper never inserts raw rows.
    const release = await ctx.ledger.findEntryByIdempotencyKey(`input-voucher-release:${voucher.id}`);
    expect(release).toBeDefined();
    const debits = release!.postings.filter((p) => p.direction === 'debit');
    const credits = release!.postings.filter((p) => p.direction === 'credit');
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(1);
    expect(debits[0].accountCode).toBe(programmeLiabilityAccountCode(ctx.programme.id));
    expect(credits[0].accountCode).toBe(PLATFORM_SUBSIDY_BUDGET_ACCOUNT);
    expect(debits[0].amountKobo).toBe(credits[0].amountKobo);

    // The funded-float reservation was released exactly once.
    const funding = await ctx.funding.getFunding(ctx.programme.id);
    expect(funding?.reservedKobo).toBe(0);
  });

  it('is idempotent: a double-run reposts nothing', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    await ageToExpired(ctx, voucher.id);

    await ctx.sweeper.sweep();
    const second = await ctx.sweeper.sweep();
    expect(second).toMatchObject({ scanned: 0, expired: 0 });
    // Exactly one release entry exists; the marker carries the voucher.
    expect(await ctx.dedup.has(VOUCHER_STUCK_SWEEPER_CONSUMER, voucher.id)).toBe(true);
  });

  it('skips vouchers already covered by the exactly-once marker', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    await ageToExpired(ctx, voucher.id);
    await ctx.dedup.mark(VOUCHER_STUCK_SWEEPER_CONSUMER, voucher.id);
    const result = await ctx.sweeper.sweep();
    expect(result).toMatchObject({ scanned: 1, skippedMarked: 1, expired: 0 });
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('ISSUED');
  });

  it('resumes a stuck EXPIRING claim to EXPIRED without double-releasing', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    // Simulate a crash between the ISSUED→EXPIRING CAS and the release.
    await ctx.vouchers.updateExpected(voucher.id, { status: 'EXPIRING', expiresAt: PAST }, { status: 'ISSUED' });

    const result = await ctx.sweeper.sweep();
    expect(result).toMatchObject({ expired: 1, failed: 0 });
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('EXPIRED');
    // A resume reposts nothing: one release entry, one funding release marker.
    expect(await ctx.ledger.findEntryByIdempotencyKey(`input-voucher-release:${voucher.id}`)).toBeDefined();
    expect((await ctx.funding.getFunding(ctx.programme.id))?.reservedKobo).toBe(0);
  });

  it('resumes a stuck VOIDING claim to VOIDED once past the stuck TTL', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    await ctx.vouchers.updateExpected(voucher.id, { status: 'VOIDING' }, { status: 'ISSUED' });

    // Fresh claim: inside the default 1h TTL the sweeper leaves it alone.
    const early = await ctx.sweeper.sweep();
    expect(early.scanned).toBe(0);

    const result = await ctx.sweeper.sweep(new Date(), { stuckTtlMs: 0 });
    expect(result).toMatchObject({ voided: 1, failed: 0 });
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('VOIDED');
    expect((await ctx.funding.getFunding(ctx.programme.id))?.reservedKobo).toBe(0);
  });

  it('resumes a stuck REDEEMING claim to REDEEMED when the redemption posting committed', async () => {
    // Funding repo whose first settleReserved throws — the redeem then
    // crashes AFTER the redemption row + ledger entry committed, leaving a
    // stuck REDEEMING claim.
    const ctx = await makeCtx((inner) => {
      let failures = 1;
      const original = inner.settleReserved.bind(inner);
      const wrapper = Object.create(inner) as InMemoryProgrammeFundingRepository;
      wrapper.settleReserved = async (...args) => {
        if (failures-- > 0) {
          throw new Error('funding store unreachable');
        }
        return original(...args);
      };
      return wrapper;
    });
    const voucher = await issuedVoucher(ctx);
    const supplier: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-SWEEP-1', supplier)).rejects.toThrowError(
      'funding store unreachable'
    );
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('REDEEMING');
    expect(
      await ctx.redemptions.findByIdempotencyKey(`input-voucher-redemption:${voucher.id}`)
    ).toBeDefined();

    const result = await ctx.sweeper.sweep(new Date(), { stuckTtlMs: 0 });
    expect(result).toMatchObject({ redeemed: 1, rolledBack: 0, failed: 0 });
    const final = await ctx.vouchers.findById(voucher.id);
    expect(final?.status).toBe('REDEEMED');
    expect(final?.ledgerEntryId).toBeDefined();
    // Reservation moved to settled exactly once.
    const funding = await ctx.funding.getFunding(ctx.programme.id);
    expect(funding?.reservedKobo).toBe(0);
    expect(funding?.settledKobo).toBe(200_000);
  });

  it('rolls a stuck REDEEMING claim back to ISSUED only with ledger proof of absence', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    // Claim without posting (crash between the CAS and the ledger write).
    await ctx.vouchers.updateExpected(voucher.id, { status: 'REDEEMING' }, { status: 'ISSUED' });

    const result = await ctx.sweeper.sweep(new Date(), { stuckTtlMs: 0 });
    expect(result).toMatchObject({ rolledBack: 1, redeemed: 0, failed: 0 });
    const rolled = await ctx.vouchers.findById(voucher.id);
    expect(rolled?.status).toBe('ISSUED');
    // Rollback is NOT terminal — no marker; a later pass can still sweep it.
    expect(await ctx.dedup.has(VOUCHER_STUCK_SWEEPER_CONSUMER, voucher.id)).toBe(false);

    // And a later expiry pass takes the re-opened voucher out cleanly.
    await ctx.vouchers.updateExpected(voucher.id, { expiresAt: PAST }, { status: 'ISSUED' });
    const second = await ctx.sweeper.sweep();
    expect(second.expired).toBe(1);
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('EXPIRED');
  });

  it('a CAS race loser backs off: a concurrent terminal transition wins', async () => {
    const ctx = await makeCtx();
    const voucher = await issuedVoucher(ctx);
    await ageToExpired(ctx, voucher.id);
    // Wrap the guarded write so a twin (a dealer redemption finalizing) lands
    // between the sweeper's read and its CAS.
    const original = ctx.vouchers.updateExpected.bind(ctx.vouchers);
    let raced = false;
    ctx.vouchers.updateExpected = async (id, patch, expected) => {
      if (!raced && id === voucher.id) {
        raced = true;
        await original(id, { status: 'REDEEMED', redeemedAt: new Date().toISOString() }, { status: 'ISSUED' });
      }
      return original(id, patch, expected);
    };
    const result = await ctx.sweeper.sweep();
    expect(result.conflicts).toBe(1);
    expect(result.expired).toBe(0);
    expect((await ctx.vouchers.findById(voucher.id))?.status).toBe('REDEEMED');
  });
});
