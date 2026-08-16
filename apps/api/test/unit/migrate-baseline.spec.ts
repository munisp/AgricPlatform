import { describe, expect, it } from 'vitest';
import {
  baselineFilesForEmptyHistory,
  latestProbedFile
} from '../../src/database/migrate';

/**
 * Baseline decision logic for apps/api/src/database/migrate.ts (docker can
 * not run here, so the decision is factored into pure functions):
 *  - a Compose-bootstrapped database already ran ALL of infra/postgres via
 *    /docker-entrypoint-initdb.d; when the latest probed migration's
 *    artifact exists, every file up to it is recorded, not just 001;
 *  - a genuinely 001-only database records only 001_init.sql;
 *  - an empty (or mid-001-failed) database records nothing, so 001 is
 *    applied for real.
 */
const FILES = [
  '001_init.sql',
  '002_audit_hash_chain.sql',
  '015_query_indexes.sql',
  '019_analytics.sql',
  '019a_listing_certified_link.sql',
  '040_warehouse_certification_basis.sql',
  '044_money_column_checks.sql'
];

describe('migrate baseline decision', () => {
  it('records every file up to the probed migration when its artifact exists (Compose-bootstrapped DB)', () => {
    const baseline = baselineFilesForEmptyHistory({
      files: FILES,
      initSchemaComplete: true,
      latestArtifactPresent: true,
      latestProbedFile: '040_warehouse_certification_basis.sql'
    });
    expect(baseline).toContain('001_init.sql');
    expect(baseline).toContain('040_warehouse_certification_basis.sql');
    expect(baseline).not.toContain('044_money_column_checks.sql');
    expect(baseline.length).toBe(FILES.length - 1);
  });

  it('records only 001 for a genuinely 001-only database', () => {
    const baseline = baselineFilesForEmptyHistory({
      files: FILES,
      initSchemaComplete: true,
      latestArtifactPresent: false,
      latestProbedFile: '040_warehouse_certification_basis.sql'
    });
    expect(baseline).toEqual(['001_init.sql']);
  });

  it('records nothing for an empty database so 001 is applied for real', () => {
    expect(
      baselineFilesForEmptyHistory({
        files: FILES,
        initSchemaComplete: false,
        latestArtifactPresent: false,
        latestProbedFile: '040_warehouse_certification_basis.sql'
      })
    ).toEqual([]);
  });

  it('records nothing when the 001 schema probe is negative even if the latest probe has no file', () => {
    expect(
      baselineFilesForEmptyHistory({
        files: FILES,
        initSchemaComplete: false,
        latestArtifactPresent: false,
        latestProbedFile: null
      })
    ).toEqual([]);
  });

  it('latestProbedFile picks the highest-numbered on-disk file that has an artifact probe', () => {
    expect(latestProbedFile(FILES)).toBe('040_warehouse_certification_basis.sql');
    expect(latestProbedFile(['001_init.sql', '002_audit_hash_chain.sql'])).toBe(null);
  });
});
