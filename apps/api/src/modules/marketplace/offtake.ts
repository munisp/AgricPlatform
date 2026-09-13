import { BadRequestException } from '@nestjs/common';

/**
 * Harvest Forward Contracts (Stage 27 Batch 3, Innovation 18) — pure domain
 * logic for milestone-tracked offtake agreements. No I/O in this module so
 * the state math and price-band rules are unit-testable in isolation:
 *
 *   - milestone status: pending -> partial -> met as deliveries accumulate
 *     (delivered_qty_kg === qty_kg); a milestone is 'missed' ONLY when the
 *     clock has passed its due_date while still unmet (never before);
 *   - price-band settlement: a delivery settles only at a unit price inside
 *     the contracted [floorKoboPerKg, capKoboPerKg] band. A price outside
 *     the band is NEVER silently clamped or re-priced — the delivery is
 *     refused and a renegotiation event is emitted by the caller;
 *   - money is integer kobo everywhere (price per kg, delivery amount).
 */

export const OFFTAKE_CONTRACT_STATUSES = [
  'draft',
  'active',
  'fulfilled',
  'defaulted',
  'cancelled'
] as const;
export type OfftakeContractStatus = (typeof OFFTAKE_CONTRACT_STATUSES)[number];

export const OFFTAKE_MILESTONE_STATUSES = ['pending', 'partial', 'met', 'missed'] as const;
export type OfftakeMilestoneStatus = (typeof OFFTAKE_MILESTONE_STATUSES)[number];

/** Contracted price band, integer kobo per kg. */
export interface OfftakePriceBand {
  floorKoboPerKg: number;
  capKoboPerKg: number;
}

export interface OfftakeContract {
  id: string;
  /** Seller side: the cooperative (chapter) delivering the harvest. */
  cooperativeId: string;
  /** Buyer side: the aggregator/off-taker org countersigning the contract. */
  buyerOrgId: string;
  commodity: string;
  /** Total contracted volume; equals the sum of milestone qty_kg. */
  qtyKg: number;
  qualitySpec: Record<string, unknown>;
  priceBand: OfftakePriceBand;
  /** ISO calendar dates (yyyy-mm-dd); window_end > window_start. */
  windowStart: string;
  windowEnd: string;
  status: OfftakeContractStatus;
  /** Client idempotency key for retry-safe creation (UNIQUE in pg). */
  idempotencyKey?: string;
  createdBy: string;
  acceptedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfftakeMilestone {
  id: string;
  contractId: string;
  /** 1-based position within the contract; UNIQUE (contract_id, seq). */
  seq: number;
  /** ISO calendar date; the milestone is missed only after this date. */
  dueDate: string;
  qtyKg: number;
  deliveredQtyKg: number;
  /** Latest delivery's evidence links (history lives in the deliveries). */
  linkedLotId?: string;
  invoiceId?: string;
  escrowId?: string;
  status: OfftakeMilestoneStatus;
  createdAt: string;
  updatedAt: string;
}

/** One recorded delivery against a milestone (append-only evidence). */
export interface OfftakeDelivery {
  id: string;
  contractId: string;
  milestoneId: string;
  /** Traceability lot proving what was delivered (mandatory). */
  lotId: string;
  /** Marketplace order riding the existing invoice/escrow rails. */
  orderId: string;
  invoiceId?: string;
  escrowId?: string;
  qtyKg: number;
  priceKoboPerKg: number;
  /** qtyKg * priceKoboPerKg, integer kobo (the escrowed amount). */
  amountKobo: number;
  ledgerEntryId?: string;
  idempotencyKey?: string;
  createdBy: string;
  createdAt: string;
}

/** Feature flag (default OFF; fail-closed 404/absent until enabled). */
export const OFFTAKE_FLAG = 'offtake-contracts';

/**
 * Validates a price band; throws on anything but a positive floor with
 * cap >= floor, both safe-integer kobo per kg.
 */
export function assertValidPriceBand(band: OfftakePriceBand): void {
  if (!band || typeof band !== 'object') {
    throw new BadRequestException('priceBand is required');
  }
  if (!Number.isSafeInteger(band.floorKoboPerKg) || band.floorKoboPerKg <= 0) {
    throw new BadRequestException('priceBand.floorKoboPerKg must be a positive integer (kobo per kg)');
  }
  if (!Number.isSafeInteger(band.capKoboPerKg) || band.capKoboPerKg < band.floorKoboPerKg) {
    throw new BadRequestException(
      'priceBand.capKoboPerKg must be an integer >= floorKoboPerKg (kobo per kg)'
    );
  }
}

/** True when a unit price settles inside the contracted band. */
export function priceWithinBand(band: OfftakePriceBand, priceKoboPerKg: number): boolean {
  return (
    Number.isSafeInteger(priceKoboPerKg) &&
    priceKoboPerKg >= band.floorKoboPerKg &&
    priceKoboPerKg <= band.capKoboPerKg
  );
}

/**
 * Delivery settlement amount in integer kobo. Throws unless qty and price
 * are positive safe integers with a safe-integer product — money never
 * floats, and an unrepresentable amount is refused rather than rounded.
 */
export function deliveryAmountKobo(qtyKg: number, priceKoboPerKg: number): number {
  if (!Number.isSafeInteger(qtyKg) || qtyKg <= 0) {
    throw new BadRequestException('qtyKg must be a positive integer');
  }
  if (!Number.isSafeInteger(priceKoboPerKg) || priceKoboPerKg <= 0) {
    throw new BadRequestException('priceKoboPerKg must be a positive integer');
  }
  const amount = qtyKg * priceKoboPerKg;
  if (!Number.isSafeInteger(amount)) {
    throw new BadRequestException(
      `Delivery amount for ${qtyKg} kg at ${priceKoboPerKg} kobo/kg is not representable in kobo`
    );
  }
  return amount;
}

/**
 * Milestone status after a delivery accumulates: exactly met when the
 * contracted quantity is reached, partial once any quantity has landed.
 * Over-delivery is refused by the caller (milestone CHECK
 * delivered_qty_kg <= qty_kg), never recorded here.
 */
export function milestoneStatusAfterDelivery(
  deliveredQtyKg: number,
  qtyKg: number
): OfftakeMilestoneStatus {
  if (deliveredQtyKg >= qtyKg) {
    return 'met';
  }
  return deliveredQtyKg > 0 ? 'partial' : 'pending';
}

/**
 * Effective milestone status at a point in time: a milestone is 'missed'
 * ONLY once `today` (ISO date) is strictly after its due_date while unmet;
 * a met milestone never regresses.
 */
export function effectiveMilestoneStatus(
  milestone: Pick<OfftakeMilestone, 'status' | 'dueDate'>,
  today: string
): OfftakeMilestoneStatus {
  if (milestone.status === 'met') {
    return 'met';
  }
  return today > milestone.dueDate ? 'missed' : milestone.status;
}

/** True when every milestone of the contract is met (contract fulfilled). */
export function allMilestonesMet(
  milestones: ReadonlyArray<Pick<OfftakeMilestone, 'status'>>
): boolean {
  return milestones.length > 0 && milestones.every((milestone) => milestone.status === 'met');
}

/** Strict yyyy-mm-dd check without a regex (lexicographic-safe ISO dates). */
export function isIsoCalendarDate(value: string): boolean {
  const parts = value.split('-');
  if (parts.length !== 3 || parts[0].length !== 4 || parts[1].length !== 2 || parts[2].length !== 2) {
    return false;
  }
  if ([...value].some((char) => char !== '-' && (char < '0' || char > '9'))) {
    return false;
  }
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Validates the milestone plan at contract creation: 1-based contiguous
 * seq, due dates inside the delivery window, positive quantities, and
 * Σ qty_kg === the contract volume (fulfilment is defined as every
 * milestone met, so the plan must cover exactly the contracted volume).
 */
export function validateMilestonePlan(
  milestones: ReadonlyArray<{ seq: number; dueDate: string; qtyKg: number }>,
  contract: Pick<OfftakeContract, 'qtyKg' | 'windowStart' | 'windowEnd'>
): void {
  if (milestones.length === 0) {
    throw new BadRequestException('At least one delivery milestone is required');
  }
  const seqs = milestones.map((milestone) => milestone.seq).sort((a, b) => a - b);
  seqs.forEach((seq, index) => {
    if (seq !== index + 1) {
      throw new BadRequestException('Milestone seq must be 1-based and contiguous (1..N)');
    }
  });
  let total = 0;
  for (const milestone of milestones) {
    if (!Number.isSafeInteger(milestone.qtyKg) || milestone.qtyKg <= 0) {
      throw new BadRequestException(`Milestone ${milestone.seq}: qtyKg must be a positive integer`);
    }
    if (
      !isIsoCalendarDate(milestone.dueDate) ||
      milestone.dueDate < contract.windowStart ||
      milestone.dueDate > contract.windowEnd
    ) {
      throw new BadRequestException(
        `Milestone ${milestone.seq}: dueDate must be an ISO date inside the contract window ` +
          `(${contract.windowStart}..${contract.windowEnd})`
      );
    }
    total += milestone.qtyKg;
  }
  if (total !== contract.qtyKg) {
    throw new BadRequestException(
      `Milestone quantities sum to ${total} kg but the contract is ${contract.qtyKg} kg; ` +
        'the plan must cover exactly the contracted volume'
    );
  }
}

/** Buyer-side asset account holding funds escrowed for offtake deliveries. */
export function buyerEscrowAccountCode(buyerOrgId: string): string {
  return `org:${buyerOrgId}:offtake_escrow`;
}

/** Per-contract liability account for escrowed delivery funds. */
export function contractEscrowLiabilityAccountCode(contractId: string): string {
  return `offtake:${contractId}:escrow_liability`;
}

/** Cooperative-side receivable credited when a delivery escrow settles. */
export function coopReceivableAccountCode(cooperativeId: string): string {
  return `coop:${cooperativeId}:offtake_receivable`;
}

/** Deterministic ledger idempotency key for a delivery's escrow-hold posting. */
export function deliveryLedgerIdempotencyKey(idempotencyKey: string): string {
  return `offtake-delivery:${idempotencyKey}`;
}

/** Deterministic ledger idempotency key for a delivery's settlement posting. */
export function settlementLedgerIdempotencyKey(escrowId: string): string {
  return `offtake-settle:${escrowId}`;
}
