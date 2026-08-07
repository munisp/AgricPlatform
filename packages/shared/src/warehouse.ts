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

export const WAREHOUSE_RECEIPT_STATUSES = ['active', 'pledged', 'released', 'redeemed'] as const;
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

/** Regulator/admin read-only audit export bundle. */
export interface WarehouseRegistryExport {
  receipts: WarehouseReceipt[];
  pledges: WarehousePledge[];
  transfers: WarehouseReceiptTransfer[];
  exportedAt: string;
}
