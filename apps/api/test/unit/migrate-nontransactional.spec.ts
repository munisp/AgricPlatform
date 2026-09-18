import { describe, expect, it } from 'vitest';
import {
  isNonTransactionalMigration,
  NON_TRANSACTIONAL_MARKER,
  splitNonTransactionalStatements
} from '../../src/database/migrate.js';

/**
 * V-76: `-- no-transaction` first-line marker support — statement-wise
 * application for DDL that cannot run inside a transaction block
 * (CREATE INDEX CONCURRENTLY, NOT VALID + VALIDATE CONSTRAINT).
 */

describe('isNonTransactionalMigration (V-76)', () => {
  it('detects the marker only as the first line', () => {
    expect(isNonTransactionalMigration('-- no-transaction\nCREATE INDEX x ON t (c);')).toBe(true);
    expect(isNonTransactionalMigration('-- NO-TRANSACTION\nSELECT 1;')).toBe(true);
    expect(isNonTransactionalMigration('-- no-transaction')).toBe(true); // no trailing newline
    expect(isNonTransactionalMigration('BEGIN;\n-- no-transaction\nSELECT 1;')).toBe(false);
    expect(isNonTransactionalMigration('-- ordinary comment\nSELECT 1;')).toBe(false);
  });

  it('the checked-in 082 hot-path indexes migration carries the marker', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      new URL('../../../../infra/postgres/082_hot_path_indexes.sql', import.meta.url),
      'utf8'
    );
    expect(sql.startsWith(NON_TRANSACTIONAL_MARKER)).toBe(true);
    expect(isNonTransactionalMigration(sql)).toBe(true);
    const statements = splitNonTransactionalStatements(sql, '082_hot_path_indexes.sql');
    expect(statements).toHaveLength(3);
    expect(statements.every((s) => s.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS'))).toBe(
      true
    );
  });
});

describe('splitNonTransactionalStatements (V-76)', () => {
  it('splits flat DDL on statement terminators and drops comment-only chunks', () => {
    const sql = [
      NON_TRANSACTIONAL_MARKER,
      '-- build one',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON s.t (c);',
      '',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON s.u (d);'
    ].join('\n');
    const statements = splitNonTransactionalStatements(sql, 'x.sql');
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('a_idx');
    expect(statements[1]).toContain('b_idx');
  });

  it('refuses dollar-quoted bodies (would be split incorrectly)', () => {
    const sql = `${NON_TRANSACTIONAL_MARKER}\nCREATE FUNCTION f() RETURNS void AS $$ SELECT 1; $$ LANGUAGE sql;`;
    expect(() => splitNonTransactionalStatements(sql, 'bad.sql')).toThrowError(/dollar-quoted/);
  });

  it('refuses explicit transaction control (defeats the marker)', () => {
    for (const keyword of ['BEGIN', 'COMMIT', 'ROLLBACK']) {
      const sql = `${NON_TRANSACTIONAL_MARKER}\n${keyword};`;
      expect(() => splitNonTransactionalStatements(sql, 'bad.sql')).toThrowError(
        /BEGIN\/COMMIT\/ROLLBACK/
      );
    }
  });
});
