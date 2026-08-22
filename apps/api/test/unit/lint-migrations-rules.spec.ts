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

  describe('CREATE INDEX', () => {
    it('fails CREATE INDEX without IF NOT EXISTS', () => {
      const found = problems('CREATE INDEX idx_a ON a.b (c);');
      expect(found.some((p) => p.includes('CREATE INDEX idx_a ON a.b without IF NOT EXISTS'))).toBe(
        true
      );
    });

    it('fails CREATE UNIQUE INDEX without IF NOT EXISTS', () => {
      const found = problems('CREATE UNIQUE INDEX idx_a ON a.b (c);');
      expect(
        found.some((p) => p.includes('CREATE UNIQUE INDEX idx_a ON a.b without IF NOT EXISTS'))
      ).toBe(true);
    });

    it('passes CREATE INDEX IF NOT EXISTS', () => {
      expect(problems('CREATE INDEX IF NOT EXISTS idx_a ON a.b (c);')).toEqual([]);
    });

    it('passes CREATE UNIQUE INDEX IF NOT EXISTS', () => {
      expect(problems('CREATE UNIQUE INDEX IF NOT EXISTS idx_a ON a.b (c);')).toEqual([]);
    });

    it('passes a guarded index with USING method and WHERE clause', () => {
      expect(
        problems(
          'CREATE INDEX IF NOT EXISTS idx_a ON a.b USING btree (c DESC) WHERE d IS NULL;'
        )
      ).toEqual([]);
    });
  });

  describe('ALTER TABLE … ADD COLUMN re-apply safety (A4-11)', () => {
    it('fails ADD COLUMN without IF NOT EXISTS', () => {
      const found = problems('ALTER TABLE a.b ADD COLUMN c text;');
      expect(
        found.some((p) => p.includes('ADD COLUMN c without IF NOT EXISTS'))
      ).toBe(true);
    });

    it('passes ADD COLUMN IF NOT EXISTS', () => {
      expect(problems('ALTER TABLE a.b ADD COLUMN IF NOT EXISTS c text;')).toEqual([]);
    });

    it('passes an information_schema.columns-guarded DO block naming the column and table', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'b' AND column_name = 'c') THEN
            ALTER TABLE a.b ADD COLUMN c text;
          END IF;
        END $$;`;
      expect(problems(sql)).toEqual([]);
    });

    it('fails when the column guard names a different table (decoy)', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'other_table' AND column_name = 'c') THEN
            ALTER TABLE a.other_table ADD COLUMN c text;
          END IF;
        END $$;
        ALTER TABLE a.zz ADD COLUMN c text;`;
      expect(problems(sql).some((p) => p.includes('ADD COLUMN c without IF NOT EXISTS'))).toBe(
        true
      );
    });
  });

  describe('ALTER COLUMN … TYPE (A4-11)', () => {
    it('always fails ALTER COLUMN … TYPE (destructive rewrite)', () => {
      const found = problems('ALTER TABLE a.b ALTER COLUMN c TYPE bigint;');
      expect(found.some((p) => p.includes('ALTER COLUMN c TYPE is not allowed'))).toBe(true);
    });

    it('also fails the SET DATA TYPE spelling', () => {
      const found = problems('ALTER TABLE a.b ALTER COLUMN c SET DATA TYPE bigint;');
      expect(found.some((p) => p.includes('ALTER COLUMN c TYPE is not allowed'))).toBe(true);
    });
  });

  describe('CREATE SCHEMA / CREATE EXTENSION (A4-11)', () => {
    it('fails CREATE SCHEMA without IF NOT EXISTS', () => {
      const found = problems('CREATE SCHEMA foo;');
      expect(found.some((p) => p.includes('CREATE SCHEMA foo without IF NOT EXISTS'))).toBe(true);
    });

    it('passes CREATE SCHEMA IF NOT EXISTS', () => {
      expect(problems('CREATE SCHEMA IF NOT EXISTS foo;')).toEqual([]);
    });

    it('fails CREATE EXTENSION without IF NOT EXISTS', () => {
      const found = problems('CREATE EXTENSION pgcrypto;');
      expect(found.some((p) => p.includes('CREATE EXTENSION pgcrypto without IF NOT EXISTS'))).toBe(
        true
      );
    });

    it('passes CREATE EXTENSION IF NOT EXISTS', () => {
      expect(problems('CREATE EXTENSION IF NOT EXISTS pgcrypto;')).toEqual([]);
    });
  });

  describe('CREATE TYPE (A4-11 — pg has no IF NOT EXISTS for types)', () => {
    it('fails an unguarded CREATE TYPE AS ENUM', () => {
      const found = problems("CREATE TYPE mood AS ENUM ('a', 'b');");
      expect(found.some((p) => p.includes('CREATE TYPE mood without an existence guard'))).toBe(
        true
      );
    });

    it('fails an unguarded CREATE TYPE composite', () => {
      const found = problems('CREATE TYPE pair AS (x integer, y text);');
      expect(found.some((p) => p.includes('CREATE TYPE pair without an existence guard'))).toBe(
        true
      );
    });

    it('passes a pg_type-guarded DO block naming the type', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood') THEN
            CREATE TYPE mood AS ENUM ('a', 'b');
          END IF;
        END $$;`;
      expect(problems(sql)).toEqual([]);
    });
  });

  describe('data DML idempotency (A4-11)', () => {
    it('fails INSERT without ON CONFLICT', () => {
      const found = problems("INSERT INTO a.b (code) VALUES ('x');");
      expect(found.some((p) => p.includes('INSERT INTO a.b without ON CONFLICT'))).toBe(true);
    });

    it('passes INSERT … ON CONFLICT DO NOTHING (003/021 seed pattern)', () => {
      expect(problems("INSERT INTO a.b (code) VALUES ('x') ON CONFLICT (code) DO NOTHING;")).toEqual(
        []
      );
    });

    it('fails a bare UPDATE', () => {
      const found = problems("UPDATE a.b SET status = 'x' WHERE status = 'y';");
      expect(found.some((p) => p.includes('UPDATE a.b is not provably idempotent'))).toBe(true);
    });

    it('fails an UPDATE with no WHERE at all', () => {
      const found = problems("UPDATE a.b SET status = 'x';");
      expect(found.some((p) => p.includes('UPDATE a.b is not provably idempotent'))).toBe(true);
    });

    it('passes the 018 self-guarding null-backfill (SET c = … WHERE c IS NULL)', () => {
      expect(problems('UPDATE identity.auth_sessions SET family_id = id WHERE family_id IS NULL;')).toEqual(
        []
      );
    });

    it('fails DELETE (data deletion belongs in a retention job)', () => {
      const found = problems('DELETE FROM a.b WHERE stale = true;');
      expect(found.some((p) => p.includes('DELETE FROM a.b is not allowed'))).toBe(true);
    });
  });

  describe('DROP INDEX (A4-11)', () => {
    it('fails DROP INDEX without IF EXISTS', () => {
      const found = problems('DROP INDEX a.idx_b;');
      expect(found.some((p) => p.includes('DROP INDEX (idx_b) without IF EXISTS'))).toBe(true);
    });

    it('passes DROP INDEX IF EXISTS', () => {
      expect(problems('DROP INDEX IF EXISTS a.idx_b;')).toEqual([]);
    });
  });

  describe('table-qualified pg_constraint guard (A4-12)', () => {
    it('fails when a same-named constraint is guarded on a DIFFERENT table (decoy)', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c_check') THEN
            ALTER TABLE a.orders ADD CONSTRAINT c_check CHECK (x > 0);
          END IF;
        END $$;
        ALTER TABLE a.enrolments ADD CONSTRAINT c_check CHECK (y > 0);`;
      const found = problems(sql);
      expect(
        found.some((p) => p.includes('ADD CONSTRAINT c_check is not re-apply-safe'))
      ).toBe(true);
    });

    it('fails when a DO block only mentions the constraint name in a comment', () => {
      const sql = `
        DO $$ BEGIN
          -- c_check is handled elsewhere
          RAISE NOTICE 'noop';
        END $$;
        ALTER TABLE a.enrolments ADD CONSTRAINT c_check CHECK (y > 0);`;
      const found = problems(sql);
      expect(
        found.some((p) => p.includes('ADD CONSTRAINT c_check is not re-apply-safe'))
      ).toBe(true);
    });

    it('passes when the DO block names the constraint AND its table', () => {
      const sql = `
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'c_check') THEN
            ALTER TABLE a.enrolments ADD CONSTRAINT c_check CHECK (y > 0);
          END IF;
        END $$;`;
      expect(problems(sql)).toEqual([]);
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
