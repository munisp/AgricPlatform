import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { TenantContext } from '../../common/telemetry/tenant-context.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  AGENT_VOUCHER_REPOSITORY,
  MERCHANT_PAYMENT_REPOSITORY,
  MERCHANT_QR_CODE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AgentBankingAgentRepository,
  AgentRecord,
  AgentVoucherRecord,
  AgentVoucherRepository
} from '../../database/repositories/agent-banking.repository.js';
import type {
  MerchantPaymentRecord,
  MerchantPaymentRepository,
  MerchantQrCodeRecord,
  MerchantQrCodeRepository
} from '../../database/repositories/dealer-qr.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import {
  MOJALOOP_ADAPTER,
  type LiveMojaloopAdapter,
  type MojaloopAdapter,
  type MojaloopTransferCallback
} from '../integrations/drivers/mojaloop.driver.js';
import {
  canonicalQrPayload,
  hashPayerAlias,
  resolveQrSecret,
  signQrPayload,
  verifyQrSignature,
  type QrPayload
} from './qr-crypto.js';
import { resolveVoucherKeyRing, verifyVoucherEnvelope } from './voucher-crypto.js';
import type { HmacKeyRing } from '../../common/crypto/key-rotation.js';

/** Rollout flag gating the whole Dealer QR Pay surface (default OFF, fail-closed). */
export const DEALER_QR_PAY_FLAG = 'dealer-qr-pay';

// Telemetry names (Stage-25 <domain>.<noun>_<verb> conventions).
export const QR_PAYMENTS_TOTAL = 'agent_banking.qr_payments_total';
export const QR_PAYMENT_KOBO_TOTAL = 'agent_banking.qr_payment_kobo_total';
export const QR_PAY_SPAN = 'agent_banking.qr_payment.pay';
export const QR_SETTLE_SPAN = 'agent_banking.qr_payment.settle';
export const QR_ISSUE_SPAN = 'agent_banking.qr.issue';

/**
 * Platform clearing account for switch-settled QR payment funds. It is
 * CREDITED (drawn down) when a dealer receivable is settled from a
 * switch-confirmed Mojaloop transfer and may therefore run negative: the
 * negative balance IS the platform's settlement claim on the switch until
 * the out-of-band settlement sweep lands (same honesty doctrine as the
 * escrow payout-account modelling note — the ledger never pretends the
 * switch's settlement file has arrived). It is only ever posted against a
 * COMMITTED transfer.
 */
export const PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT = 'platform:mojaloop_settlement';

/**
 * Dealer receivable (ledger-visible, debit-normal customer-balance account
 * owned by the dealer's user — the farmer-wallet convention from wave
 * AGENTBANK). Voucher tender legs mirror the existing voucher-redemption
 * posting (DR destination / CR issuing-agent float, float solvency
 * guarded); wallet tender legs draw down the switch-settlement clearing
 * account above.
 */
export function dealerReceivableAccountCode(agentOrgId: string): string {
  return `dealer:${agentOrgId}:receivable`;
}

/** Payee party alias presented to the switch for a merchant (agent org). */
export function merchantPartyAlias(agentOrgId: string): string {
  return `merchant:${agentOrgId}`;
}

/**
 * Bounded-retry probe discipline for crash-safe rollback legs (stage 24,
 * audit A1-6/A4-1): identical to the voucher-redemption probes.
 */
export const LEDGER_PROBE_ATTEMPTS = 3;
export const LEDGER_PROBE_BASE_DELAY_MS = 50;
export const LEDGER_PROBE_JITTER_MS = 101;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ActorRef {
  id: string;
  roles: readonly string[];
}

export interface IssueQrInput {
  label: string;
}

export interface PayInput {
  /** Total payment amount, integer kobo (voucher + wallet tender). */
  amountKobo: number;
  /** Payer's wallet alias/MSISDN presented to the switch (never persisted plaintext). */
  payerAlias: string;
  /** Optional agent_banking offline voucher applied as partial/whole tender. */
  voucherId?: string;
  /** Mandatory client idempotency key — replays return the original payment. */
  idempotencyKey: string;
}

export interface TenderSplit {
  voucherTenderKobo: number;
  walletTenderKobo: number;
}

/**
 * Co-pay split math (pure, integer kobo): the voucher is indivisible tender
 * — it covers its full face value and the wallet covers the remainder. A
 * voucher exceeding the amount is rejected (no change-making in v1).
 * Invariant: voucherTenderKobo + walletTenderKobo === amountKobo.
 */
export function splitCoPayTender(amountKobo: number, voucherAmountKobo?: number): TenderSplit {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new BadRequestException('amountKobo must be a positive integer kobo value');
  }
  if (voucherAmountKobo === undefined) {
    return { voucherTenderKobo: 0, walletTenderKobo: amountKobo };
  }
  if (!Number.isSafeInteger(voucherAmountKobo) || voucherAmountKobo <= 0) {
    throw new BadRequestException('voucher amount must be a positive integer kobo value');
  }
  if (voucherAmountKobo > amountKobo) {
    throw new BadRequestException(
      'VOUCHER_EXCEEDS_AMOUNT: the voucher face value exceeds the payment amount and vouchers are indivisible tender'
    );
  }
  return { voucherTenderKobo: voucherAmountKobo, walletTenderKobo: amountKobo - voucherAmountKobo };
}

function isLiveAdapter(adapter: MojaloopAdapter | undefined): adapter is LiveMojaloopAdapter {
  return adapter?.name === 'live';
}

/**
 * Dealer QR Pay service (Stage 27, Innovation 16): HMAC-signed merchant QR
 * codes at agro-dealers, Mojaloop quote→transfer wallet tender, optional
 * signed-voucher co-pay (the migration-038 CAS redemption discipline), and
 * settlement posting to the dealer receivable in ONE ledger entry whose
 * outbox event commits in the same transaction as the status CAS.
 *
 * Fail-closed (inherits the strictest posture in the repo):
 *   - the stub adapter is the default; production + stub → 503;
 *   - a payment only reaches `completed` off a switch-COMMITTED transfer
 *     (or a fully voucher-covered tender, which has no switch leg);
 *   - stub/simulator `simulated` outcomes never complete a payment;
 *   - the confirmation poller and the webhook require the LIVE driver —
 *     with any other adapter they answer 503 rather than guessing;
 *   - JWS signatures are the live driver's own (never fabricated here).
 */
@Injectable()
export class DealerQrService {
  private readonly qrSecret: string;
  /** V-26: key-versioned voucher signature ring (kid:hmac-hex envelopes). */
  private readonly voucherKeyRing: HmacKeyRing;
  private readonly telemetry: TelemetryService;

  constructor(
    @Inject(MERCHANT_QR_CODE_REPOSITORY) private readonly qrCodes: MerchantQrCodeRepository,
    @Inject(MERCHANT_PAYMENT_REPOSITORY) private readonly payments: MerchantPaymentRepository,
    @Inject(AGENT_BANKING_AGENT_REPOSITORY) private readonly agents: AgentBankingAgentRepository,
    @Inject(AGENT_VOUCHER_REPOSITORY) private readonly vouchers: AgentVoucherRepository,
    private readonly ledger: LedgerService,
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Optional() @Inject(MOJALOOP_ADAPTER) private readonly mojaloop?: MojaloopAdapter,
    @Optional() telemetry?: TelemetryService,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.qrSecret = resolveQrSecret(env);
    this.voucherKeyRing = resolveVoucherKeyRing(env);
    this.telemetry = telemetry ?? new TelemetryService();
  }

  private tenantId(actorId: string): string {
    return TenantContext.currentTenantId() ?? `user:${actorId}`;
  }

  // ------------------------------------------------------------ QR codes

  /**
   * Issues a signed merchant QR code for an ACTIVE agent (the merchant
   * registry reuses the agent organisation model). Caller must be the
   * dealer themself or an admin. The label joins the signed payload, so it
   * must not contain the '.' canonical separator.
   */
  async issueQrCode(
    agentOrgId: string,
    input: IssueQrInput,
    actor: ActorRef
  ): Promise<{ qr: MerchantQrCodeRecord; payload: string; signature: string }> {
    const agent = await this.getAgent(agentOrgId);
    if (agent.status !== 'ACTIVE') {
      throw new BadRequestException(`Merchant agent must be ACTIVE to issue QR codes (status is ${agent.status})`);
    }
    if (!actor.roles.includes('admin') && agent.userId !== actor.id) {
      throw new ForbiddenException('Only the dealer or an admin can issue QR codes for this merchant');
    }
    const label = input.label?.trim();
    if (!label) {
      throw new BadRequestException('label is required');
    }
    if (label.includes('.')) {
      throw new BadRequestException("label must not contain the '.' canonical-payload separator");
    }
    return this.telemetry.withSpan(QR_ISSUE_SPAN, { agent_org_id: agent.id }, async () => {
      const id = newId('qr');
      const createdAt = new Date().toISOString();
      const payload: QrPayload = {
        qrId: id,
        agentOrgId: agent.id,
        dealerUserId: agent.userId,
        label,
        issuedAt: createdAt
      };
      const signature = signQrPayload(payload, this.qrSecret);
      const qr = await this.qrCodes.create({
        id,
        agentOrgId: agent.id,
        dealerUserId: agent.userId,
        payloadHmac: signature,
        label,
        status: 'active',
        createdAt
      });
      await this.events.publish(
        'agent_banking.qr.issued',
        {
          qrId: id,
          agentOrgId: agent.id,
          dealerUserId: agent.userId,
          label,
          tenantId: this.tenantId(actor.id)
        },
        actor.id
      );
      return { qr, payload: canonicalQrPayload(payload), signature };
    });
  }

  /** The QR row after re-verifying its stored HMAC (tamper evidence). */
  private async verifiedQr(code: string): Promise<MerchantQrCodeRecord> {
    const qr = await this.qrCodes.findById(code);
    if (!qr) {
      throw new NotFoundException(`Merchant QR code '${code}' not found`);
    }
    const payload: QrPayload = {
      qrId: qr.id,
      agentOrgId: qr.agentOrgId,
      dealerUserId: qr.dealerUserId,
      label: qr.label,
      issuedAt: qr.createdAt
    };
    if (!verifyQrSignature(payload, qr.payloadHmac, this.qrSecret)) {
      // The stored row fails its own integrity proof — treat as hostile.
      throw new UnauthorizedException('QR payload integrity check failed');
    }
    return qr;
  }

  // ------------------------------------------------------------- payment

  /**
   * Quote → transfer against a merchant QR code. Optional voucherId applies
   * the signed-voucher redemption CAS path as tender: the voucher is
   * claimed ISSUED→REDEEMING BEFORE the switch leg is prepared, so a
   * concurrent redemption/void loses the CAS and only this payment can
   * settle it. The wallet leg runs over the MOJALOOP_ADAPTER port with the
   * deterministic per-reference transfer id (live driver), and the row's
   * UNIQUE(mojaloop_transfer_id) is the settlement idempotency key.
   *
   * A stub/simulator `simulated` transfer NEVER completes a payment — the
   * row stays `quoted` (fail closed). Production with the stub adapter
   * answers 503 before anything is persisted.
   */
  async pay(code: string, input: PayInput, actor: ActorRef): Promise<MerchantPaymentRecord> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — QR payments must be replay-safe');
    }
    const replay = await this.payments.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return replay; // idempotent replay of a transport retry
    }
    const qr = await this.verifiedQr(code);
    if (qr.status !== 'active') {
      throw new ConflictException(`Merchant QR code '${code}' is ${qr.status}`);
    }
    const agent = await this.getAgent(qr.agentOrgId);
    if (agent.status !== 'ACTIVE') {
      throw new BadRequestException(`Merchant agent must be ACTIVE to accept payments (status is ${agent.status})`);
    }
    await this.users.getById(actor.id); // payer must be a known user
    const payerAlias = input.payerAlias?.trim();
    if (!payerAlias) {
      throw new BadRequestException('payerAlias is required');
    }

    // Validate the co-pay voucher BEFORE any state change (no claim yet).
    const voucher = input.voucherId ? await this.validatedCoPayVoucher(input.voucherId, actor) : undefined;
    const split = splitCoPayTender(input.amountKobo, voucher?.amountKobo);

    // Fail-closed adapter gate for the wallet leg.
    if (split.walletTenderKobo > 0) {
      if (!this.mojaloop) {
        throw new ServiceUnavailableException('QR wallet payments are unavailable: no Mojaloop adapter bound');
      }
      if (this.mojaloop.name === 'stub' && isProduction(this.env)) {
        throw new ServiceUnavailableException(
          'QR wallet payments are unavailable: the Mojaloop adapter is the stub driver (production requires a configured switch driver)'
        );
      }
    }

    return this.telemetry.withSpan(QR_PAY_SPAN, { agent_org_id: agent.id }, async () => {
      const now = new Date().toISOString();
      const paymentId = newId('mpay');
      let payment: MerchantPaymentRecord;
      try {
        payment = await this.payments.create({
          id: paymentId,
          qrId: qr.id,
          payerUserId: actor.id,
          amountKobo: input.amountKobo,
          voucherTenderKobo: split.voucherTenderKobo,
          walletTenderKobo: split.walletTenderKobo,
          ...(voucher ? { voucherId: voucher.id } : {}),
          payerAliasHmac: hashPayerAlias(payerAlias, this.qrSecret),
          adapterBasis: this.mojaloop?.name ?? 'stub',
          status: 'quoted',
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          updatedAt: now
        });
      } catch (error) {
        if (error instanceof ConflictException) {
          // Lost a retry race — the original payment is authoritative.
          const existing = await this.payments.findByIdempotencyKey(input.idempotencyKey);
          if (existing) {
            return existing;
          }
        }
        throw error;
      }
      await this.events.publish(
        'agent_banking.merchant_payment.quoted',
        {
          paymentId: payment.id,
          qrId: qr.id,
          agentOrgId: agent.id,
          amountKobo: payment.amountKobo,
          voucherTenderKobo: payment.voucherTenderKobo,
          walletTenderKobo: payment.walletTenderKobo,
          adapterBasis: payment.adapterBasis,
          tenantId: this.tenantId(actor.id)
        },
        actor.id
      );
      this.telemetry.increment(QR_PAYMENTS_TOTAL, 1, { status: 'quoted' });

      // Claim the co-pay voucher BEFORE the switch leg: only the CAS winner
      // can ever settle it (migration-038 redemption discipline).
      if (voucher) {
        await this.vouchers.updateExpected(voucher.id, { status: 'REDEEMING' }, { status: 'ISSUED' });
      }

      if (split.walletTenderKobo === 0) {
        // Voucher-only tender: no switch leg exists, so nothing here waits
        // on a switch confirmation — the signed voucher IS the tender.
        return this.settlePayment(payment, actor.id);
      }

      // Wallet leg over the MOJALOOP_ADAPTER port. Adapter failures leave
      // the payment `quoted` (resumable via the confirmation poller) with
      // the voucher claim held REDEEMING for the same resume path — the
      // fail path rolls the claim back only when the switch says the
      // transfer will never commit.
      const adapter = this.mojaloop as MojaloopAdapter;
      const amountNaira = split.walletTenderKobo / 100;
      const quote = await adapter.requestQuote({
        amountNaira,
        payerMsisdn: payerAlias,
        payeeMsisdn: merchantPartyAlias(agent.id),
        reference: payment.id
      });
      const transfer = await adapter.executeTransfer({
        amountNaira,
        payerMsisdn: payerAlias,
        payeeMsisdn: merchantPartyAlias(agent.id),
        reference: payment.id,
        quoteId: quote.quoteId
      });
      payment = await this.payments.updateExpected(
        payment.id,
        { quoteId: quote.quoteId, mojaloopTransferId: transfer.transferId, updatedAt: new Date().toISOString() },
        { status: 'quoted' }
      );
      if (transfer.status === 'failed') {
        return this.failPayment(payment, 'transfer aborted by the switch', actor.id);
      }
      if (transfer.status === 'committed') {
        // Switch-confirmed — settle immediately.
        return this.settlePayment(payment, actor.id);
      }
      // 'pending' | 'simulated': the switch has not confirmed; the payment
      // stays quoted for the poller/webhook. A simulated outcome can never
      // complete (no real switch confirmed anything).
      return payment;
    });
  }

  /** Co-pay voucher validation: ownership, state machine, signature, value. */
  private async validatedCoPayVoucher(voucherId: string, actor: ActorRef): Promise<AgentVoucherRecord> {
    const voucher = await this.vouchers.findById(voucherId);
    if (!voucher) {
      throw new NotFoundException(`Voucher '${voucherId}' not found`);
    }
    if (!actor.roles.includes('admin') && voucher.farmerId !== actor.id) {
      throw new ForbiddenException('Only the voucher owner (or an admin) can tender this voucher');
    }
    if (voucher.status === 'REDEEMED' || voucher.status === 'REDEEMING') {
      throw new ConflictException(`Voucher '${voucherId}' is not available (status is ${voucher.status})`);
    }
    if (voucher.status === 'VOIDED') {
      throw new ConflictException(`Voucher '${voucherId}' was voided`);
    }
    if (voucher.status === 'EXPIRED' || Date.parse(voucher.expiresAt) <= Date.now()) {
      throw new GoneException(`Voucher '${voucherId}' expired at ${voucher.expiresAt}`);
    }
    // Server-side signature verification of the stored voucher payload —
    // only a genuinely platform-issued voucher can be tendered. Key-versioned
    // envelope (V-26): active+previous kids accepted during rotation.
    const valid = verifyVoucherEnvelope(
      {
        voucherId: voucher.id,
        agentId: voucher.agentId,
        farmerId: voucher.farmerId,
        amountKobo: voucher.amountKobo,
        expiry: voucher.expiresAt,
        nonce: voucher.nonce
      },
      voucher.signature,
      this.voucherKeyRing
    );
    if (!valid) {
      throw new UnauthorizedException('Voucher signature verification failed');
    }
    return voucher;
  }

  // ---------------------------------------------------------- settlement

  /**
   * Posts the settlement to the dealer receivable and completes the
   * payment — only ever called off a switch-COMMITTED transfer (wallet leg)
   * or for voucher-only tender. The ledger entry is idempotent on
   * merchant-payment-settlement:<id>; the status CAS quoted→completed
   * carries the outbox event in the same database transaction (pg), so a
   * redelivered confirmation or a racing poller is a no-op.
   */
  private async settlePayment(payment: MerchantPaymentRecord, actorId: string): Promise<MerchantPaymentRecord> {
    if (payment.status === 'completed') {
      return payment; // replay-safe no-op
    }
    if (payment.status !== 'quoted') {
      throw new ConflictException(`Merchant payment '${payment.id}' is ${payment.status}, not quoted`);
    }
    const qr = await this.qrCodes.findById(payment.qrId);
    const agent = qr ? await this.agents.findById(qr.agentOrgId) : undefined;
    if (!qr || !agent) {
      throw new ConflictException(`Merchant payment '${payment.id}' references a missing merchant`);
    }
    return this.telemetry.withSpan(QR_SETTLE_SPAN, { agent_org_id: agent.id }, async () => {
      const receivable = dealerReceivableAccountCode(agent.id);
      await this.ledger.ensureAccount({ code: receivable, type: 'asset', ownerId: qr.dealerUserId });
      const postings: { accountCode: string; direction: 'debit' | 'credit'; amountKobo: number }[] = [];
      const solvent: string[] = [];
      if (payment.walletTenderKobo > 0) {
        await this.ledger.ensureAccount({ code: PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT, type: 'asset' });
        postings.push(
          { accountCode: receivable, direction: 'debit', amountKobo: payment.walletTenderKobo },
          { accountCode: PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT, direction: 'credit', amountKobo: payment.walletTenderKobo }
        );
      }
      let voucher: AgentVoucherRecord | undefined;
      if (payment.voucherId && payment.voucherTenderKobo > 0) {
        voucher = await this.vouchers.findById(payment.voucherId);
        const voucherAgent = voucher ? await this.agents.findById(voucher.agentId) : undefined;
        if (!voucher || !voucherAgent) {
          throw new ConflictException(`Merchant payment '${payment.id}' references a missing co-pay voucher`);
        }
        postings.push(
          { accountCode: receivable, direction: 'debit', amountKobo: payment.voucherTenderKobo },
          { accountCode: voucherAgent.floatAccountCode, direction: 'credit', amountKobo: payment.voucherTenderKobo }
        );
        solvent.push(voucherAgent.floatAccountCode);
      }
      const entry = await this.ledger.postEntry(
        {
          idempotencyKey: `merchant-payment-settlement:${payment.id}`,
          referenceType: 'agent_banking_merchant_payment',
          referenceId: payment.id,
          description: `Dealer QR payment ${payment.id} settled to merchant ${agent.id} (voucher ${payment.voucherTenderKobo} + wallet ${payment.walletTenderKobo} kobo)`,
          postings,
          requireSolventAccounts: solvent
        },
        actorId
      );
      // Finalize the co-pay voucher: REDEEMING→REDEEMED pinned to the
      // settlement entry. A resume finding it already REDEEMED with this
      // entry is the replay of a crash window and continues.
      if (voucher) {
        if (voucher.status === 'REDEEMING') {
          await this.vouchers.updateExpected(
            voucher.id,
            { status: 'REDEEMED', redeemedAt: new Date().toISOString(), ledgerEntryId: entry.id },
            { status: 'REDEEMING' }
          );
        } else if (voucher.status !== 'REDEEMED' || voucher.ledgerEntryId !== entry.id) {
          throw new ConflictException(
            `Co-pay voucher '${voucher.id}' is ${voucher.status} — refusing to settle payment '${payment.id}'`
          );
        }
      }
      const now = new Date().toISOString();
      const event = this.events.build(
        'agent_banking.merchant_payment.completed',
        {
          paymentId: payment.id,
          qrId: payment.qrId,
          agentOrgId: agent.id,
          amountKobo: payment.amountKobo,
          voucherTenderKobo: payment.voucherTenderKobo,
          walletTenderKobo: payment.walletTenderKobo,
          mojaloopTransferId: payment.mojaloopTransferId,
          ledgerEntryId: entry.id,
          tenantId: this.tenantId(actorId)
        },
        actorId
      );
      const completed = await this.payments.updateExpected(
        payment.id,
        { status: 'completed', ledgerEntryId: entry.id, completedAt: now, updatedAt: now },
        { status: 'quoted' },
        event
      );
      if (this.payments.transactionalOutbox) {
        this.events.emit(event);
      } else {
        await this.events.persist(event);
      }
      this.telemetry.increment(QR_PAYMENTS_TOTAL, 1, { status: 'completed' });
      this.telemetry.increment(QR_PAYMENT_KOBO_TOTAL, payment.amountKobo, {});
      return completed;
    });
  }

  /**
   * Fails a quoted payment (switch aborted / never prepared) and releases
   * the co-pay voucher claim. The claim rolls back REDEEMING→ISSUED ONLY
   * when the ledger proves no settlement entry exists under this payment's
   * key (stage-24 probe doctrine) — otherwise the claim stays REDEEMING for
   * a safe resume and the caller gets a 409.
   */
  private async failPayment(
    payment: MerchantPaymentRecord,
    reason: string,
    actorId: string
  ): Promise<MerchantPaymentRecord> {
    if (payment.status !== 'quoted') {
      return payment; // replay-safe no-op
    }
    const now = new Date().toISOString();
    const event = this.events.build(
      'agent_banking.merchant_payment.failed',
      {
        paymentId: payment.id,
        qrId: payment.qrId,
        amountKobo: payment.amountKobo,
        reason,
        tenantId: this.tenantId(actorId)
      },
      actorId
    );
    const failed = await this.payments.updateExpected(
      payment.id,
      { status: 'failed', failureReason: reason, updatedAt: now },
      { status: 'quoted' },
      event
    );
    if (this.payments.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    this.telemetry.increment(QR_PAYMENTS_TOTAL, 1, { status: 'failed' });
    await this.releaseVoucherClaim(payment);
    return failed;
  }

  /** Best-effort voucher claim release, gated on the ledger-truth probe. */
  private async releaseVoucherClaim(payment: MerchantPaymentRecord): Promise<void> {
    if (!payment.voucherId) {
      return;
    }
    const voucher = await this.vouchers.findById(payment.voucherId);
    if (!voucher || voucher.status !== 'REDEEMING') {
      return;
    }
    const probe = await this.probeLedgerEntry(`merchant-payment-settlement:${payment.id}`);
    if (probe === 'absent') {
      await this.vouchers
        .updateExpected(voucher.id, { status: 'ISSUED' }, { status: 'REDEEMING' })
        .catch(() => undefined);
      return;
    }
    // The settlement posting exists (or the probe is inconclusive): the
    // claim stays REDEEMING for the resume path — never re-open a PAID
    // voucher (stage 24, audit A1-6).
    throw new ConflictException(
      `Merchant payment '${payment.id}' failed but its settlement posting state is uncertain — the co-pay voucher claim stays REDEEMING for a safe resume`
    );
  }

  /** Bounded-retry ledger truth probe (see AgentBankingService). */
  private async probeLedgerEntry(key: string): Promise<'found' | 'absent' | 'unknown'> {
    let sawFailure = false;
    for (let attempt = 0; attempt < LEDGER_PROBE_ATTEMPTS; attempt += 1) {
      try {
        if (await this.ledger.findEntryByIdempotencyKey(key)) {
          return 'found';
        }
      } catch {
        sawFailure = true; // the probe itself failed — we know nothing
      }
      if (attempt < LEDGER_PROBE_ATTEMPTS - 1) {
        await sleep(LEDGER_PROBE_BASE_DELAY_MS + Math.floor(Math.random() * LEDGER_PROBE_JITTER_MS));
      }
    }
    return sawFailure ? 'unknown' : 'absent';
  }

  // ------------------------------------------------- confirm (poller/webhook)

  /**
   * Confirmation poller entry point (admin/scheduler): queries the LIVE
   * driver's transfer-status endpoint and settles or fails the payment.
   * Replay-safe: an already-completed payment returns unchanged.
   */
  async confirmPayment(id: string, actorId: string): Promise<MerchantPaymentRecord> {
    const payment = await this.payments.findById(id);
    if (!payment) {
      throw new NotFoundException(`Merchant payment '${id}' not found`);
    }
    if (payment.status === 'completed' || payment.status === 'failed') {
      return payment; // replay-safe no-op
    }
    if (payment.walletTenderKobo === 0) {
      // Voucher-only payments settle synchronously at pay time; a quoted
      // voucher-only row is a crash-window resume.
      return this.settlePayment(payment, actorId);
    }
    if (!payment.mojaloopTransferId) {
      // The transfer leg was never prepared (the quote/prepare call failed
      // before an id existed) — nothing can commit at the switch; fail and
      // release the voucher claim (ledger probe gates the rollback).
      return this.failPayment(payment, 'transfer was never prepared', actorId);
    }
    if (!isLiveAdapter(this.mojaloop)) {
      throw new ServiceUnavailableException(
        'QR payment confirmation requires the live Mojaloop driver (transfer status query); the configured adapter cannot confirm transfers'
      );
    }
    const transfer = await this.mojaloop.transferStatus(payment.mojaloopTransferId);
    if (transfer.status === 'committed') {
      return this.settlePayment(payment, actorId);
    }
    if (transfer.status === 'failed') {
      return this.failPayment(payment, 'transfer aborted by the switch', actorId);
    }
    return payment; // still pending at the switch
  }

  /**
   * FSPIOP PUT /transfers/{id} webhook: the live driver verifies the
   * fulfilment against the ILP condition it generated (unverifiable
   * fulfilment fails closed) before the payment state machine advances.
   * Redelivered confirmations are a no-op — UNIQUE(mojaloop_transfer_id)
   * plus the quoted→completed CAS make double settlement impossible.
   */
  async handleMojaloopWebhook(body: MojaloopTransferCallback & { transferId?: string }): Promise<MerchantPaymentRecord> {
    if (!isLiveAdapter(this.mojaloop)) {
      throw new ServiceUnavailableException(
        'Mojaloop transfer callbacks require the live Mojaloop driver; the configured adapter cannot verify fulfilments'
      );
    }
    const transferId = body.transferId?.trim();
    if (!transferId) {
      throw new BadRequestException('transferId is required');
    }
    // Driver-side fulfilment verification (throws on mismatch — fail closed).
    const transfer = this.mojaloop.handleTransferCallback(transferId, body);
    const payment = await this.payments.findByTransferId(transferId);
    if (!payment) {
      throw new NotFoundException(`No merchant payment for transfer '${transferId}'`);
    }
    if (payment.status === 'completed' || payment.status === 'failed') {
      return payment; // redelivered confirmation — no-op
    }
    if (transfer.status === 'committed') {
      return this.settlePayment(payment, 'mojaloop-webhook');
    }
    if (transfer.status === 'failed') {
      return this.failPayment(payment, 'transfer aborted by the switch', 'mojaloop-webhook');
    }
    return payment;
  }

  // -------------------------------------------------------------- reads

  /** Payment detail: payer, dealer owner, or admin. */
  async getPayment(id: string, actor: ActorRef): Promise<MerchantPaymentRecord> {
    const payment = await this.payments.findById(id);
    if (!payment) {
      throw new NotFoundException(`Merchant payment '${id}' not found`);
    }
    if (!actor.roles.includes('admin') && payment.payerUserId !== actor.id) {
      const qr = await this.qrCodes.findById(payment.qrId);
      if (!qr || qr.dealerUserId !== actor.id) {
        throw new ForbiddenException('Only the payer, the dealer or an admin can view this payment');
      }
    }
    return payment;
  }

  async listQrCodes(agentOrgId: string, actor: ActorRef): Promise<MerchantQrCodeRecord[]> {
    const agent = await this.getAgent(agentOrgId);
    if (!actor.roles.includes('admin') && agent.userId !== actor.id) {
      throw new ForbiddenException('Only the dealer or an admin can list QR codes for this merchant');
    }
    return this.qrCodes.find({ agentOrgId });
  }

  private async getAgent(agentOrgId: string): Promise<AgentRecord> {
    const agent = await this.agents.findById(agentOrgId);
    if (!agent) {
      throw new NotFoundException(`Merchant (agent organisation) '${agentOrgId}' not found`);
    }
    return agent;
  }
}
