import type pg from 'pg';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DdsChecklistItem } from '../../modules/traceability/dds-validator.js';
import { mapPgError } from '../pg/pg-repository.base.js';
import type {
  DdsPackage,
  DdsPackageCriteria,
  DdsPackageRepository,
  DdsPackageStatus
} from './dds-package.repository.js';

/**
 * DDS Studio pg implementation (stage 27 innovation 17, migration 076).
 * Package immutability after export is enforced in SQL, not just in app
 * code: saveChecklist carries `AND status <> 'exported'` and markExported is
 * a compare-and-set (`WHERE id = $1 AND status = 'validated'`), so a lost
 * race or a replayed export fails with ConflictException instead of
 * rewriting an exported package. No UPDATE path exists for package_hash,
 * exporter_partner_id or created_by outside these guarded transitions.
 */

const COLS =
  'id, shipment_id, status, checklist, package_hash, exporter_partner_id, created_by, created_at, exported_at';

function str(row: Record<string, unknown>, column: string): string {
  return row[column] as string;
}

function ts(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return value instanceof Date ? value.toISOString() : String(value);
}

function strOrUndef(row: Record<string, unknown>, column: string): string | undefined {
  return (row[column] as string | null) ?? undefined;
}

function tsOrUndef(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function checklistFromRow(row: Record<string, unknown>): DdsChecklistItem[] {
  const value = row['checklist'];
  if (Array.isArray(value)) {
    return value as DdsChecklistItem[];
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as DdsChecklistItem[];
  }
  return [];
}

function packageFromRow(row: Record<string, unknown>): DdsPackage {
  return {
    id: str(row, 'id'),
    shipmentId: str(row, 'shipment_id'),
    status: str(row, 'status') as DdsPackageStatus,
    checklist: checklistFromRow(row),
    packageHash: strOrUndef(row, 'package_hash'),
    exporterPartnerId: strOrUndef(row, 'exporter_partner_id'),
    createdBy: str(row, 'created_by'),
    createdAt: ts(row, 'created_at'),
    exportedAt: tsOrUndef(row, 'exported_at')
  };
}

export class PgDdsPackageRepository implements DdsPackageRepository {
  private static readonly TABLE = 'traceability.dds_packages';

  constructor(private readonly pool: pg.Pool) {}

  async create(pkg: DdsPackage): Promise<DdsPackage> {
    try {
      await this.pool.query(
        `INSERT INTO ${PgDdsPackageRepository.TABLE} (${COLS}) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
        [
          pkg.id,
          pkg.shipmentId,
          pkg.status,
          JSON.stringify(pkg.checklist),
          pkg.packageHash ?? null,
          pkg.exporterPartnerId ?? null,
          pkg.createdBy,
          pkg.createdAt,
          pkg.exportedAt ?? null
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return pkg;
  }

  async findById(id: string): Promise<DdsPackage | undefined> {
    const result = await this.pool.query(
      `SELECT ${COLS} FROM ${PgDdsPackageRepository.TABLE} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? packageFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<DdsPackage> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`DDS package '${id}' not found`);
    }
    return item;
  }

  async find(criteria: DdsPackageCriteria): Promise<DdsPackage[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (criteria.shipmentId) {
      params.push(criteria.shipmentId);
      parts.push(`shipment_id = $${params.length}`);
    }
    if (criteria.exporterPartnerId) {
      params.push(criteria.exporterPartnerId);
      parts.push(`exporter_partner_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      parts.push(`status = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${COLS} FROM ${PgDdsPackageRepository.TABLE}${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map(packageFromRow);
  }

  /** Guarded: refuses to touch an exported package (immutability after export). */
  async saveChecklist(
    id: string,
    status: 'draft' | 'validated',
    checklist: DdsChecklistItem[]
  ): Promise<DdsPackage> {
    const result = await this.pool.query(
      `UPDATE ${PgDdsPackageRepository.TABLE} SET status = $2, checklist = $3::jsonb
       WHERE id = $1 AND status <> 'exported' RETURNING ${COLS}`,
      [id, status, JSON.stringify(checklist)]
    );
    if (result.rows.length === 0) {
      const existing = await this.findById(id);
      if (!existing) {
        throw new NotFoundException(`DDS package '${id}' not found`);
      }
      throw new ConflictException(`DDS package '${id}' is exported and immutable`);
    }
    return packageFromRow(result.rows[0]);
  }

  /** Guarded CAS 'validated' → 'exported'; any other state conflicts. */
  async markExported(id: string, packageHash: string, exportedAt: string): Promise<DdsPackage> {
    const result = await this.pool.query(
      `UPDATE ${PgDdsPackageRepository.TABLE} SET status = 'exported', package_hash = $2, exported_at = $3
       WHERE id = $1 AND status = 'validated' RETURNING ${COLS}`,
      [id, packageHash, exportedAt]
    );
    if (result.rows.length === 0) {
      const existing = await this.findById(id);
      if (!existing) {
        throw new NotFoundException(`DDS package '${id}' not found`);
      }
      throw new ConflictException(
        `DDS package '${id}' cannot be exported from status '${existing.status}' (guarded CAS requires 'validated')`
      );
    }
    return packageFromRow(result.rows[0]);
  }
}

export function createPgDdsPackageRepository(pool: pg.Pool): PgDdsPackageRepository {
  return new PgDdsPackageRepository(pool);
}
