import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { LedgerAccount } from '@agric-platform/shared';
import type { AgentRecord } from './agent-banking.repository.js';
import { PgAgentBankingAgentRepository } from './agent-banking.pg-repository.js';

/**
 * OB-12 query-spy tests: createWithLedgerAccounts must wrap the two
 * finance.ledger_accounts inserts and the agent_banking.agents insert in ONE
 * transaction on a single pooled client, so a failed agents insert rolls the
 * account provisioning back.
 */

const record: AgentRecord = {
  id: 'agent-1',
  userId: 'user-agent-1',
  organisation: 'Kano Farmers Cooperative',
  status: 'PENDING',
  floatAccountCode: 'agent:agent-1:float',
  commissionAccountCode: 'agent:agent-1:commission_payable',
  dailyLimitKobo: 25_000_000,
  lowFloatThresholdKobo: 2_000_000,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const accounts: LedgerAccount[] = [
  {
    id: 'acct-1',
    code: record.floatAccountCode,
    type: 'asset',
    ownerId: record.userId,
    currency: 'NGN',
    createdAt: record.createdAt
  },
  {
    id: 'acct-2',
    code: record.commissionAccountCode,
    type: 'liability',
    ownerId: record.userId,
    currency: 'NGN',
    createdAt: record.createdAt
  }
];

function spyPool(failOn?: RegExp) {
  const statements: string[] = [];
  let released = false;
  const client = {
    query: async (text: string) => {
      statements.push(text);
      if (failOn && failOn.test(text)) {
        throw new Error('simulated agents insert failure');
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {
      released = true;
    }
  } as unknown as pg.PoolClient;
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, statements, isReleased: () => released };
}

describe('PgAgentBankingAgentRepository.createWithLedgerAccounts (OB-12)', () => {
  it('commits both ledger accounts and the agent row in ONE transaction', async () => {
    const { pool, statements, isReleased } = spyPool();
    const repo = new PgAgentBankingAgentRepository(pool);

    const created = await repo.createWithLedgerAccounts(record, accounts);

    expect(created.id).toBe(record.id);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    const ledgerInserts = statements.filter((s) => s.includes('INSERT INTO finance.ledger_accounts'));
    expect(ledgerInserts).toHaveLength(2);
    // ensure semantics: concurrent/replayed registrations converge.
    expect(ledgerInserts.every((s) => s.includes('ON CONFLICT (code) DO NOTHING'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO agent_banking.agents'))).toBe(true);
    expect(statements.some((s) => s === 'ROLLBACK')).toBe(false);
    expect(isReleased()).toBe(true);
  });

  it('rolls back the ledger accounts when the agents insert fails', async () => {
    const { pool, statements, isReleased } = spyPool(/INSERT INTO agent_banking\.agents/);
    const repo = new PgAgentBankingAgentRepository(pool);

    await expect(repo.createWithLedgerAccounts(record, accounts)).rejects.toThrow(
      /simulated agents insert failure/
    );

    expect(statements.filter((s) => s.includes('INSERT INTO finance.ledger_accounts'))).toHaveLength(2);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((s) => s === 'COMMIT')).toBe(false);
    expect(isReleased()).toBe(true);
  });
});
