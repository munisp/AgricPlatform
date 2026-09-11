import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';
// The rules module is plain ESM shared with the lint:sql runner.
import { lintMigrationStatements } from '../../../../scripts/lint-migrations-rules.mjs';

/**
 * Rule coverage for scripts/lint-migrations-rules.mjs — each rule gets a
 * negative test (must fail) and a sanctioned-pattern positive test, mirroring
 * how geocredit-migration.spec.ts drives pgsql-ast-parser.
 */
function problems(sql: string): string[] {
  return lintMigrationStatements(parse(sql) as never);
}

describe('lint-migrations rules', () => {
  describe('ALTER TABLE … DROP COLUMN', () => {
    it('fails drop column even with IF EXISTS (data-loss DDL)', () => {
      expect(problems('ALTER TABLE a.b DROP COLUMN c;').join('\n')).toContain('DROP COLUMN');
      expect(problems('ALTER TABLE a.b DROP COLUMN IF EXISTS c;').join('\n')).toContain(
        'DROP COLUMN'
      );
    });
  });

  describe('ALTER TABLE … DROP CONSTRAINT', () => {
    it('fails unguarded drop constraint', () => {
      const found = problems('ALTER TABLE a.b DROP CONSTRAINT c_check;');
      expect(found.some((p) => p.includes('DROP CONSTRAINT c_check without IF EXISTS'))).toBe(true);
    });

    it('passes DROP CONSTRAINT IF EXISTS', () => {
      expect(problems('ALTER TABLE a.b DROP CONSTRAINT IF EXISTS c_check;')).toEqual([]);
    });
  });

  describe('ALTER TABLE … ADD CONSTRAINT re-apply safety', () => {
    it('fails an unguarded add constraint', () => {
      const found = problems('ALTER TABLE a.b ADD CONSTRAINT c_check CHECK (x > 0);');
      expect(found.some((p) => p.includes('ADD CONSTRAINT c_check is not re-apply-safe'))).toBe(
        true
      );
    });

    it('passes the 016 pattern (DROP CONSTRAINT IF EXISTS + ADD)', () => {
      expect(
        problems(
          'ALTER TABLE a.b DROP CONSTRAINT IF EXISTS c_check; ALTER TABLE a.b ADD CONSTRAINT c_check CHECK (x > 0);'
        )
      ).toEqual([]);
    });

    it('fails when the preceding drop is not IF EXISTS', () => {
      const found = problems(
        'ALTER TABLE a.b DROP CONSTRAINT c_check; ALTER TABLE a.b ADD CONSTRAINT c_check CHECK (x > 0);'
      );
      expect(found.length).toBeGreaterThan(0);
    });

    it('passes the 019a pattern (pg_constraint-guarded DO block mentioning the name)', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c_check') THEN
            ALTER TABLE a.b ADD CONSTRAINT c_check CHECK (x > 0);
          END IF;
        END $$;`;
      expect(problems(sql)).toEqual([]);
    });

    it('fails an unnamed add constraint', () => {
      const found = problems('ALTER TABLE a.b ADD CHECK (x > 0);');
      expect(found.some((p) => p.includes('without a constraint name'))).toBe(true);
    });
  });

  describe('CREATE TABLE', () => {
    it('fails CREATE TABLE without IF NOT EXISTS', () => {
      const found = problems('CREATE TABLE a.b (id text PRIMARY KEY);');
      expect(found.some((p) => p.includes('CREATE TABLE a.b without IF NOT EXISTS'))).toBe(true);
    });

    it('passes CREATE TABLE IF NOT EXISTS with a primary key', () => {
      expect(problems('CREATE TABLE IF NOT EXISTS a.b (id text PRIMARY KEY);')).toEqual([]);
    });

    it('still fails CREATE TABLE without a primary key', () => {
      const found = problems('CREATE TABLE IF NOT EXISTS a.b (id text);');
      expect(found.some((p) => p.includes('has no primary key'))).toBe(true);
    });
  });

  describe('existing destructive-DDL rules unchanged', () => {
    it('fails unguarded DROP TABLE / TRUNCATE, passes guarded DROP TABLE', () => {
      expect(problems('DROP TABLE a.b;').join('\n')).toContain('unguarded DROP TABLE');
      expect(problems('TRUNCATE a.b;').join('\n')).toContain('TRUNCATE');
      expect(problems('DROP TABLE IF EXISTS a.b;')).toEqual([]);
    });
  });
});
