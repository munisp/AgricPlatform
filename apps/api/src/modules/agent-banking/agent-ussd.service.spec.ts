import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentFloatTopUpRepository,
  createInMemoryAgentTransactionRepository,
  createInMemoryAgentVoucherRepository
} from '../../database/repositories/agent-banking.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { createInMemoryUssdSessionRepository } from '../../database/repositories/ussd-session.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { AgentBankingService } from './agent-banking.service.js';
import { AgentUssdService } from './agent-ussd.service.js';
import { StubOtpDriver } from './otp.driver.js';

async function makeChannel() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const banking = new AgentBankingService(
    createInMemoryAgentBankingAgentRepository(),
    createInMemoryAgentFloatTopUpRepository(),
    createInMemoryAgentVoucherRepository(),
    createInMemoryAgentTransactionRepository(),
    ledger,
    users,
    events,
    new StubOtpDriver(),
    undefined,
    {}
  );
  const ussd = new AgentUssdService(users, banking, createInMemoryUssdSessionRepository(), {});
  const agentUser = await users.create({
    phone: '+2348000000001',
    fullName: 'Agent Amaka',
    roles: ['agent'],
    preferredLanguage: 'en'
  });
  const farmer = await users.create({
    phone: '+2348000000002',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  return { ussd, banking, ledger, users, agentUser, farmer };
}

describe('AgentUssdService channel', () => {
  it('keeps the callback disabled unless the USSD driver is configured', async () => {
    await expect(makeChannel().then((ctx) => ctx.ussd.driverConfig.enabled)).resolves.toBe(false);
  });

  it('rejects callers without an ACTIVE agent registration', async () => {
    const ctx = await makeChannel();
    const response = await ctx.ussd.handleCallback({
      sessionId: 'sess-1',
      phoneNumber: '+2348000000002', // farmer, not an agent
      text: ''
    });
    expect(response).toMatch(/^END /);
    expect(response).toContain('registered, active agents');
  });

  it('serves the float balance to a registered agent and replays turns idempotently', async () => {
    const ctx = await makeChannel();
    const agent = await ctx.banking.registerAgent(
      { userId: ctx.agentUser.id, organisation: 'Coop' },
      'user-admin'
    );
    await ctx.banking.setAgentStatus(agent.id, 'ACTIVE', 'user-admin');

    const open = await ctx.ussd.handleCallback({
      sessionId: 'sess-2',
      phoneNumber: '+2348000000001',
      text: ''
    });
    expect(open).toMatch(/^CON /);
    expect(open).toContain('Float balance');

    const balance = await ctx.ussd.handleCallback({
      sessionId: 'sess-2',
      phoneNumber: '+2348000000001',
      text: '1'
    });
    expect(balance).toMatch(/^END /);
    expect(balance).toContain('Float balance: NGN 0');

    // Replay of the same cumulative text returns the cached response.
    const replay = await ctx.ussd.handleCallback({
      sessionId: 'sess-2',
      phoneNumber: '+2348000000001',
      text: '1'
    });
    expect(replay).toBe(balance);
  });

  it('executes a voucher redemption from the menu effect', async () => {
    const ctx = await makeChannel();
    const agent = await ctx.banking.registerAgent(
      { userId: ctx.agentUser.id, organisation: 'Coop' },
      'user-admin'
    );
    await ctx.banking.setAgentStatus(agent.id, 'ACTIVE', 'user-admin');
    // Fund the float directly (top-up workflow is covered in the service spec).
    await ctx.ledger.ensureAccount({ code: 'platform:float_funding', type: 'equity' });
    await ctx.ledger.postEntry(
      {
        idempotencyKey: 'fund-1',
        description: 'funding',
        postings: [
          { accountCode: 'platform:cash', direction: 'debit', amountKobo: 1_000_000 },
          { accountCode: 'platform:float_funding', direction: 'credit', amountKobo: 1_000_000 }
        ]
      },
      'user-admin'
    );
    const request = await ctx.banking.requestTopUp(agent.id, 500_000, { id: 'user-admin', roles: ['admin'] });
    await ctx.banking.decideTopUp(request.id, 'approve', 'user-admin');
    await ctx.banking.settleTopUp(request.id, 'user-admin');
    const voucher = await ctx.banking.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000 },
      { id: ctx.agentUser.id, roles: ['agent'] }
    );

    // Dial: open → 3 (redeem voucher) → code → 1 (confirm).
    await ctx.ussd.handleCallback({ sessionId: 'sess-3', phoneNumber: '+2348000000001', text: '' });
    await ctx.ussd.handleCallback({ sessionId: 'sess-3', phoneNumber: '+2348000000001', text: '3' });
    await ctx.ussd.handleCallback({
      sessionId: 'sess-3',
      phoneNumber: '+2348000000001',
      text: `3*${voucher.id}`
    });
    const done = await ctx.ussd.handleCallback({
      sessionId: 'sess-3',
      phoneNumber: '+2348000000001',
      text: `3*${voucher.id}*1`
    });
    expect(done).toMatch(/^END /);
    expect(done).toContain('Voucher redeemed');
    expect((await ctx.banking.getVoucher(voucher.id)).status).toBe('REDEEMED');
  });
});
