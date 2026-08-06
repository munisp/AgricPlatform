import { ConflictException, GoneException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { USSD_SESSION_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  UssdSessionRecord,
  UssdSessionRepository
} from '../../database/repositories/ussd-session.repository.js';
import { UsersService } from '../users/users.service.js';
import { resolveUssdDriver, type UssdDriverConfig } from '../ussd/ussd.service.js';
import { AgentBankingService } from './agent-banking.service.js';
import {
  handleAgentUssdTurn,
  initialAgentUssdState,
  type AgentUssdMenuData,
  type AgentUssdState
} from './agent-ussd.js';
import type { AgentRecord } from '../../database/repositories/agent-banking.repository.js';

/** Reuses the 3-minute Africa's Talking inactivity window. */
export const AGENT_USSD_SESSION_TTL_MS = 3 * 60 * 1000;

export interface AgentUssdCallbackInput {
  sessionId: string;
  phoneNumber: string;
  /** `*` separated cumulative inputs; '' on the opening dial. */
  text: string;
}

/** Engine state plus the replay cache persisted in channels.ussd_sessions.state. */
interface StoredAgentUssdState {
  engine: AgentUssdState;
  lastText?: string;
  lastResponse?: string;
}

/**
 * Agent-banking USSD channel service (wave AGENTBANK). Mirrors the wave
 * P5b session discipline: 3-minute TTL, idempotent replay on
 * (sessionId, cumulative text), and a pure menu engine whose effects
 * (float balance, recent transactions, voucher redemption) execute here.
 * The caller is identified by their phone number → user → ACTIVE agent
 * registration; non-agents get a terminal message, never menu data.
 */
@Injectable()
export class AgentUssdService {
  private readonly logger = new Logger(AgentUssdService.name);
  readonly driverConfig: UssdDriverConfig;

  constructor(
    private readonly users: UsersService,
    private readonly banking: AgentBankingService,
    @Inject(USSD_SESSION_REPOSITORY) private readonly sessions: UssdSessionRepository,
    @Optional() env: NodeJS.ProcessEnv = process.env
  ) {
    // Same fail-closed driver gate as the agronomy USSD channel: the
    // callback stays disabled unless USSD_DRIVER is live|sandbox with the
    // Africa's Talking credentials configured.
    this.driverConfig = resolveUssdDriver(env);
  }

  async handleCallback(input: AgentUssdCallbackInput): Promise<string> {
    const now = Date.now();
    const text = input.text ?? '';
    const existing = await this.sessions.findById(input.sessionId);

    if (existing && existing.expiresAt > new Date(now).toISOString()) {
      const stored = existing.state as unknown as StoredAgentUssdState;
      if (stored.lastText === text && stored.lastResponse !== undefined) {
        return stored.lastResponse;
      }
    }

    const expired = !existing || existing.expiresAt <= new Date(now).toISOString();
    const stored = expired ? undefined : (existing.state as unknown as StoredAgentUssdState);
    const engineState = stored?.engine ?? initialAgentUssdState();
    const segment = text.split('*').pop() ?? '';

    const agent = await this.agentForPhone(input.phoneNumber);
    if (!agent) {
      return 'END Agent Banking is for registered, active agents. Contact your cooperative.';
    }

    const data = await this.menuData(agent, engineState);
    const turn = handleAgentUssdTurn(engineState, segment, data);
    let response = turn.response;

    if (turn.effect?.type === 'redeem_voucher') {
      response = await this.executeRedemption(agent, turn.effect.voucherCode);
    }

    const record: UssdSessionRecord = {
      sessionId: input.sessionId,
      phone: input.phoneNumber,
      msisdn: input.phoneNumber,
      state: {
        engine: turn.state,
        lastText: text,
        lastResponse: response
      } as unknown as Record<string, unknown>,
      currentMenu: turn.state.menu,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      expiresAt: new Date(now + AGENT_USSD_SESSION_TTL_MS).toISOString()
    };
    await this.sessions.save(record);
    return response;
  }

  private async agentForPhone(phone: string): Promise<AgentRecord | undefined> {
    const user = await this.users.findByPhone(phone);
    if (!user) {
      return undefined;
    }
    try {
      const agent = await this.banking.agentForUser(user.id);
      return agent.status === 'ACTIVE' ? agent : undefined;
    } catch {
      return undefined;
    }
  }

  /** Gathers the live data the current menu may need. */
  private async menuData(agent: AgentRecord, state: AgentUssdState): Promise<AgentUssdMenuData> {
    const data: AgentUssdMenuData = {};
    if (state.menu === 'main') {
      try {
        const float = await this.banking.floatBalance(agent.id);
        data.floatBalanceNaira = Math.floor(float.balanceKobo / 100);
        data.lowFloat = float.lowFloat;
      } catch (error) {
        this.logger.warn(`Agent USSD float lookup failed: ${(error as Error).message}`);
      }
      const recent = await this.banking.listTransactions({ agentId: agent.id });
      data.recentTransactions = recent
        .slice(-5)
        .reverse()
        .map((tx) => ({
          type: tx.type,
          amountNaira: Math.floor(tx.amountKobo / 100),
          day: tx.createdAt.slice(0, 10)
        }));
    }
    return data;
  }

  /**
   * Executes a voucher redemption from the USSD session. The signature
   * presentation requirement is satisfied by the stored signature — the
   * HMAC integrity check still runs server-side, and the agent's phone
   * identity authenticates the session (see docs/agent-banking.md).
   */
  private async executeRedemption(agent: AgentRecord, voucherCode: string): Promise<string> {
    try {
      const { voucher } = await this.banking.redeemVoucher(voucherCode, undefined, {
        id: agent.userId,
        roles: ['agent']
      });
      return `END Voucher redeemed: NGN ${Math.floor(voucher.amountKobo / 100).toLocaleString('en-NG')} credited to the farmer wallet.`;
    } catch (error) {
      if (error instanceof ConflictException) {
        return 'END This voucher was already redeemed or voided.';
      }
      if (error instanceof GoneException) {
        return 'END This voucher has expired.';
      }
      this.logger.warn(`Agent USSD voucher redemption failed: ${(error as Error).message}`);
      return 'END Voucher redemption failed. Check the code and try again.';
    }
  }
}
