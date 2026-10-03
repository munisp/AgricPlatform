import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';
import { lintMigrationStatements } from '../../../../scripts/lint-migrations-rules.mjs';

/**
 * Migration 121 (GAP-H10 orphan-table cleanup) structural checks — the same
 * parser lint:sql uses, asserting:
 *   - exactly the three guarded drops evidenced by mapping-gap-register.md
 *     GAP-H10 and mapping-verification.md conflict C-03
 *     (privacy.processing_register, community.groups, integrations.providers);
 *   - the retained/watch tables (analytics.events, identity.roles,
 *     marketplace.order_events) are documented in the header rationale but
 *     never appear in executable SQL, i.e. are never drop targets.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '121_drop_orphan_tables.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

const EXPECTED_DROPS = [
  'privacy.processing_register',
  'community.groups',
  'integrations.providers'
];

/** Retained per C-03: watch item / seeded reference data / migrate probe. */
const RETAINED_TABLES = ['analytics.events', 'identity.roles', 'marketplace.order_events'];

interface DropTableStatement {
  type: 'drop table';
  ifExists?: boolean;
  names?: Array<{ schema?: string; name: string }>;
}

function dropTargets(): Array<{ qualified: string; ifExists?: boolean }> {
  const out: Array<{ qualified: string; ifExists?: boolean }> = [];
  for (const statement of statements) {
    if (statement.type !== 'drop table') continue;
    const drop = statement as unknown as DropTableStatement;
    for (const name of drop.names ?? []) {
      out.push({
        qualified: `${name.schema ? name.schema + '.' : ''}${name.name}`,
        ifExists: drop.ifExists
      });
    }
  }
  return out;
}

describe('infra/postgres/121_drop_orphan_tables.sql', () => {
  it('parses cleanly with pgsql-ast-parser and passes the shared migration lint rules', () => {
    expect(statements.length).toBeGreaterThan(0);
    expect(lintMigrationStatements(statements as never)).toEqual([]);
  });

  it('drops exactly the three GAP-H10 orphan tables, each guarded with IF EXISTS', () => {
    const targets = dropTargets();
    expect(targets.map((target) => target.qualified).sort()).toEqual([...EXPECTED_DROPS].sort());
    for (const target of targets) {
      expect(target.ifExists, `DROP TABLE IF EXISTS ${target.qualified}`).toBe(true);
    }
  });

  it('is wrapped in a single transaction (BEGIN … COMMIT, drop statements only)', () => {
    expect(statements[0]?.type).toBe('begin');
    expect(statements[statements.length - 1]?.type).toBe('commit');
    const allowed = new Set(['begin', 'commit', 'drop table']);
    for (const statement of statements) {
      expect(allowed.has(statement.type)).toBe(true);
    }
  });

  it('never targets the retained/watch tables in executable SQL', () => {
    // Comment lines carry the retention rationale; executable SQL must not
    // mention the retained tables at all.
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const retained of RETAINED_TABLES) {
      expect(executableSql).not.toContain(retained);
      expect(dropTargets().some((target) => target.qualified === retained)).toBe(false);
    }
  });

  it('documents the retention rationale for each retained/watch table in the header', () => {
    const header = sql
      .split('\n')
      .filter((line) => line.trimStart().startsWith('--'))
      .join('\n');
    // analytics.events — C-03 watch item.
    expect(header).toContain('analytics.events');
    expect(header).toMatch(/WATCH ITEM/i);
    // identity.roles — seeded reference data and FK target, not an orphan.
    expect(header).toContain('identity.roles');
    expect(header).toMatch(/reference data/i);
    // marketplace.order_events — retained migrate-baseline probe artifact.
    expect(header).toContain('marketplace.order_events');
    expect(header).toMatch(/probe/i);
  });
});
