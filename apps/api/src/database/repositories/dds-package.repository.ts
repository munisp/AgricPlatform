import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DdsChecklistItem } from '../../modules/traceability/dds-validator.js';

/**
 * DDS Studio persistence port (stage 27 innovation 17, migration 076).
 *
 * Lifecycle doctrine: draft → validated → exported, with package immutability
 * after export enforced by guarded writes:
 *   - `saveChecklist` is guarded to non-exported packages (a re-validation
 *     can never rewrite an exported package's stored checklist);
 *   - `markExported` is a compare-and-set from status 'validated' only —
 *     a draft cannot jump to exported (a DDS is never auto-passed) and an
 *     exported package can never be re-exported or mutated.
 * Both implementations (in-memory here, pg in dds-package.pg-repository.ts)
 * must stay behaviourally identical.
 */

export type DdsPackageStatus = 'draft' | 'validated' | 'exported';

export interface DdsPackage {
  id: string;
  shipmentId: string;
  status: DdsPackageStatus;
  /** Per-requirement pass/fail + basis; empty until the first validation. */
  checklist: DdsChecklistItem[];
  /** sha256 over the canonical evidence manifest; set at export time only. */
  packageHash?: string;
  /** Partner client id when created through the partner API (no prefix). */
  exporterPartnerId?: string;
  createdBy: string;
  createdAt: string;
  exportedAt?: string;
}

export interface DdsPackageCriteria {
  shipmentId?: string;
  exporterPartnerId?: string;
  status?: DdsPackageStatus;
}

export interface DdsPackageRepository {
  create(pkg: DdsPackage): Promise<DdsPackage>;
  findById(id: string): Promise<DdsPackage | undefined>;
  getById(id: string): Promise<DdsPackage>;
  find(criteria: DdsPackageCriteria): Promise<DdsPackage[]>;
  /**
   * Stores the latest validation checklist and moves the package to
   * `status` ('draft' on a failed validation, 'validated' on a pass).
   * Guarded: throws ConflictException when the package is already exported.
   */
  saveChecklist(id: string, status: 'draft' | 'validated', checklist: DdsChecklistItem[]): Promise<DdsPackage>;
  /**
   * Guarded CAS 'validated' → 'exported': sets packageHash/exportedAt.
   * Throws ConflictException when the package is not in 'validated' state.
   */
  markExported(id: string, packageHash: string, exportedAt: string): Promise<DdsPackage>;
}

export class InMemoryDdsPackageRepository implements DdsPackageRepository {
  private readonly items = new Map<string, DdsPackage>();

  constructor(seed: readonly DdsPackage[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(pkg: DdsPackage): Promise<DdsPackage> {
    if (this.items.has(pkg.id)) {
      throw new ConflictException(`DDS package '${pkg.id}' already exists`);
    }
    this.items.set(pkg.id, structuredClone(pkg));
    return pkg;
  }

  async findById(id: string): Promise<DdsPackage | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<DdsPackage> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`DDS package '${id}' not found`);
    }
    return item;
  }

  async find(criteria: DdsPackageCriteria): Promise<DdsPackage[]> {
    return [...this.items.values()]
      .filter(
        (pkg) =>
          (!criteria.shipmentId || pkg.shipmentId === criteria.shipmentId) &&
          (!criteria.exporterPartnerId || pkg.exporterPartnerId === criteria.exporterPartnerId) &&
          (!criteria.status || pkg.status === criteria.status)
      )
      .map((pkg) => structuredClone(pkg));
  }

  async saveChecklist(
    id: string,
    status: 'draft' | 'validated',
    checklist: DdsChecklistItem[]
  ): Promise<DdsPackage> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`DDS package '${id}' not found`);
    }
    if (current.status === 'exported') {
      throw new ConflictException(`DDS package '${id}' is exported and immutable`);
    }
    const next: DdsPackage = { ...current, status, checklist: structuredClone(checklist) };
    this.items.set(id, next);
    return structuredClone(next);
  }

  async markExported(id: string, packageHash: string, exportedAt: string): Promise<DdsPackage> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`DDS package '${id}' not found`);
    }
    if (current.status !== 'validated') {
      throw new ConflictException(
        `DDS package '${id}' cannot be exported from status '${current.status}' (guarded CAS requires 'validated')`
      );
    }
    const next: DdsPackage = { ...current, status: 'exported', packageHash, exportedAt };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryDdsPackageRepository(): InMemoryDdsPackageRepository {
  return new InMemoryDdsPackageRepository();
}
