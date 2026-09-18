/**
 * Wave WAREHOUSE (Innovation #5): electronic warehouse receipts (e-WHR) for
 * Nigerian smallholders. Certified warehouses (admin-managed registry) accept
 * farmer crop-lot deposits, a quality grading is recorded, and an HMAC-signed
 * electronic warehouse receipt is issued. Receipts can be pledged to lenders
 * as loan collateral (lien, mirroring the livestock-trade lien precedent),
 * transferred between owners with an audit trail, and redeemed (grain
 * released). Money stays in the finance ledger; these are operational
 * records only. No PostGIS: warehouse locations are single H3 cells.
 */

export const WAREHOUSE_CERTIFICATION_STATUSES = ['pending', 'certified', 'suspended'] as const;
export type WarehouseCertificationStatus = (typeof WAREHOUSE_CERTIFICATION_STATUSES)[number];

export const WAREHOUSE_DEPOSIT_STATUSES = ['received', 'graded', 'issued', 'withdrawn'] as const;
export type WarehouseDepositStatus = (typeof WAREHOUSE_DEPOSIT_STATUSES)[number];

export const WAREHOUSE_RECEIPT_STATUSES = [
  'active',
  'pledged',
  'released',
  'redeemed',
  // V-37: terminal state of a PARENT receipt after a split — the parent's
  // claim moved wholly into its child receipts (quantity-conserved). A split
  // parent is non-pledgeable, non-transferable and non-redeemable.
  'split'
] as const;
export type WarehouseReceiptStatus = (typeof WAREHOUSE_RECEIPT_STATUSES)[number];

export const WAREHOUSE_PLEDGE_STATUSES = ['active', 'released'] as const;
export type WarehousePledgeStatus = (typeof WAREHOUSE_PLEDGE_STATUSES)[number];

export const WAREHOUSE_GRADES = ['A', 'B', 'C'] as const;
export type WarehouseGrade = (typeof WAREHOUSE_GRADES)[number];

/** Admin-managed certified warehouse registry entry (migration 034). */
export interface CertifiedWarehouse {
  id: string;
  name: string;
  state: string;
  lga: string;
  latitude: number;
  longitude: number;
  /** H3 cell of the warehouse (resolution fixed by the app layer). */
  h3Cell: string;
  capacityTonnes: number;
  /**
   * Certification lifecycle. 'certified' requires the warehouse-operator
   * certification feed port (STUB driver by default — the basis label always
   * travels with the check; see docs/warehouse-receipts.md).
   */
  certificationStatus: WarehouseCertificationStatus;
  /**
   * Basis of the last certification check: 'stub' (deterministic dev feed,
   * non-production only) or 'live'. A stub-derived 'certified' must NEVER
   * unblock deposits/pledges in production — the app layer fails closed.
   */
  certificationBasis?: 'stub' | 'live';
  /** External operator licence reference (never a URL to PII). */
  operatorLicenseRef?: string;
  createdAt: string;
  updatedAt: string;
}

/** Quality grading recorded against a deposit before the e-WHR is issued. */
export interface WarehouseGrading {
  grade: WarehouseGrade;
  /** Grain moisture content, percent (0–100). */
  moisturePercent: number;
  bagCount: number;
  weightKg: number;
  /** User id of the grader (warehouse operator / admin). */
  gradedBy: string;
  gradedAt: string;
}

/** Farmer crop-lot deposit at a certified warehouse. */
export interface WarehouseDeposit {
  id: string;
  warehouseId: string;
  farmerId: string;
  /** Optional link to a traceability CommodityLot (migrations 029/030). */
  lotId?: string;
  crop: string;
  status: WarehouseDepositStatus;
  grading?: WarehouseGrading;
  /** Set once the e-WHR is issued (issuance is idempotent per deposit). */
  receiptId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Electronic warehouse receipt. The signature is HMAC-SHA256 over a
 * versioned canonical payload (receipt number, parties, grade, quantities,
 * nonce) — any tampering invalidates it (see receipt-crypto.ts).
 */
export interface WarehouseReceipt {
  id: string;
  /** Human-readable unique receipt number, e.g. WHR-2026-3F9A1C2E. */
  receiptNumber: string;
  depositId: string;
  warehouseId: string;
  ownerId: string;
  crop: string;
  grade: WarehouseGrade;
  bagCount: number;
  weightKg: number;
  status: WarehouseReceiptStatus;
  nonce: string;
  signature: string;
  issuedAt: string;
  createdAt: string;
  updatedAt: string;
  /**
   * V-37 receipt split: the parent receipt this child was split from
   * (undefined on issuance receipts). A child's signature chains the parent's
   * receipt number + signature (receipt-crypto.ts signChildReceipt), so a
   * child cannot be re-parented without invalidating its signature.
   */
  parentReceiptId?: string;
  /** 1-based position of this child within the parent's split (V-37). */
  splitSeq?: number;
  /**
   * V-07 spoilage/condition loss: cumulative recorded loss in kg. The SIGNED
   * issuance fields (weightKg/bagCount/grade) are never rewritten — tamper
   * evidence would break — so downstream quantity math must use the
   * loss-adjusted effective quantity (see effectiveReceiptWeightKg).
   */
  lostWeightKg?: number;
  /** V-07: cumulative recorded bag loss (integer). */
  lostBagCount?: number;
  /** V-07: post-issuance re-grade (condition adjustment). The effective
   * grade is `regradedTo ?? grade`; the signed issuance grade is preserved. */
  regradedTo?: WarehouseGrade;
}

/**
 * Lien registration: a receipt pledged as loan collateral to a lender.
 * Mirrors the livestock-trade LivestockLien precedent. The external
 * collateral-registry reference is STUB-labelled until the national
 * collateral registry integration gate is cleared.
 */
export interface WarehousePledge {
  id: string;
  receiptId: string;
  lenderId: string;
  /** Receipt owner at registration time (the borrower). */
  borrowerId: string;
  principalKobo: number;
  terms: string;
  status: WarehousePledgeStatus;
  /** External collateral-registry reference (stub-labelled). */
  registryRef?: string;
  /** Honest provenance of the registry reference: 'stub' | 'live'. */
  registryBasis: 'stub' | 'live';
  registeredAt: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Append-only receipt ownership-transfer audit record. */
export interface WarehouseReceiptTransfer {
  id: string;
  receiptId: string;
  fromOwnerId: string;
  toOwnerId: string;
  transferredBy: string;
  note?: string;
  createdAt: string;
}

/* ---- V-07: spoilage/condition loss & adjustment events ------------------ */

/**
 * Loss/adjustment event kinds recorded against an issued receipt. The events
 * themselves ride the transactional outbox (warehouse.receipt.loss_reported)
 * as append-only evidence; the receipt row carries the CUMULATIVE loss
 * fields above so the effective quantity is readable without a replay.
 */
export const WAREHOUSE_LOSS_KINDS = [
  'spoilage',
  'theft',
  'moisture_damage',
  'regrade',
  'operator_fraud'
] as const;
export type WarehouseLossKind = (typeof WAREHOUSE_LOSS_KINDS)[number];

/**
 * V-07: effective (loss-adjusted) receipt quantity in kg. Never negative —
 * the service refuses a loss report that would drive it below zero.
 */
export function effectiveReceiptWeightKg(
  receipt: Pick<WarehouseReceipt, 'weightKg' | 'lostWeightKg'>
): number {
  return receipt.weightKg - (receipt.lostWeightKg ?? 0);
}

/** V-07: effective (loss-adjusted) bag count. */
export function effectiveReceiptBagCount(
  receipt: Pick<WarehouseReceipt, 'bagCount' | 'lostBagCount'>
): number {
  return receipt.bagCount - (receipt.lostBagCount ?? 0);
}

/** V-07: effective grade — a re-grade supersedes the signed issuance grade. */
export function effectiveReceiptGrade(
  receipt: Pick<WarehouseReceipt, 'grade' | 'regradedTo'>
): WarehouseGrade {
  return receipt.regradedTo ?? receipt.grade;
}

/* ---- V-39: operator bond (ledger accounts; see WarehouseBondService) ----- */

/**
 * Ledger account holding an operator's performance bond (liability: the
 * platform owes the bond back to the operator until a fraud draw). The
 * REAL bond instrument is an external legal/insurance gate (E-08) — these
 * accounts model the in-platform recourse once that gate lands.
 */
export function warehouseOperatorBondAccountCode(warehouseId: string): string {
  return `warehouse:${warehouseId}:operator_bond`;
}

/** Liability account for fraud compensation owed to receipt holders. */
export function warehouseFraudCompensationAccountCode(warehouseId: string): string {
  return `warehouse:${warehouseId}:fraud_compensation_payable`;
}

/** Platform cash account debited when an operator posts a bond. */
export const WAREHOUSE_BOND_CASH_ACCOUNT = 'platform:cash';

/** Regulator/admin read-only audit export bundle. */
export interface WarehouseRegistryExport {
  receipts: WarehouseReceipt[];
  pledges: WarehousePledge[];
  transfers: WarehouseReceiptTransfer[];
  exportedAt: string;
}

/* ---- Stage 27 / Innovation 8: Receipt LTV Guardian (migration 066) ------ */

/** Collateral-position lifecycle: active → margin_call → cured | liquidated. */
export const COLLATERAL_POSITION_STATUSES = [
  'active',
  'margin_call',
  'cured',
  'liquidated'
] as const;
export type CollateralPositionStatus = (typeof COLLATERAL_POSITION_STATUSES)[number];

/**
 * Honest provenance of an observed price (geo-credit badge doctrine).
 * 'unavailable' is deliberately absent: a failed fetch produces NO
 * observation row — the position is flagged priceStale instead.
 */
export const LTV_PRICE_BASES = ['live', 'stub'] as const;
export type LtvPriceBasis = (typeof LTV_PRICE_BASES)[number];

/**
 * A warehouse receipt monitored as loan collateral. The outstanding loan
 * balance is never stored here — `ledgerAccountCode` points at the finance
 * ledger account (single source of truth) read at evaluation time.
 */
export interface CollateralPosition {
  id: string;
  receiptId: string;
  loanId: string;
  lenderId: string;
  borrowerId: string;
  /** Ledger account read for the outstanding balance at evaluation time. */
  ledgerAccountCode: string;
  pledgedQtyKg: number;
  commodity: string;
  /** Collateral haircut in basis points (0–9999). */
  haircutBps: number;
  /** Target maximum LTV in basis points; recovery to ≤ this cures a call. */
  ltvLimitBps: number;
  /** LTV at or above this raises a margin call (basis points). */
  marginCallBps: number;
  status: CollateralPositionStatus;
  /** Fail-closed flag: price feed unavailable at the last evaluation. */
  priceStale: boolean;
  openedAt: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Append-only LTV observation (evidence doctrine — never updated). */
export interface LtvObservation {
  id: string;
  positionId: string;
  pricePerKgKobo: number;
  priceBasis: LtvPriceBasis;
  /** Outstanding loan balance read from the ledger at observation time. */
  outstandingKobo: number;
  ltvBps: number;
  observedAt: string;
}

/** Lender-facing position detail including the observation history. */
export interface CollateralPositionDetail {
  position: CollateralPosition;
  observations: LtvObservation[];
}
