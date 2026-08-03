import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type {
  CreditSavingsAccount,
  CreditSavingsTransaction,
  SavingsDirection
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  CREDIT_SAVINGS_TRANSACTION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditGroupMemberRepository,
  CreditGroupRepository,
  CreditSavingsAccountRepository,
  CreditSavingsTransactionRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { CreditActor } from './credit.service.js';

export interface SavingsTransactionResult {
  account: CreditSavingsAccount;
  transaction: CreditSavingsTransaction;
  /** True when the ref already existed and the stored transaction was returned. */
  replay: boolean;
}

const MAX_ATTEMPTS = 3;

/**
 * VSLA savings (Wave CREDIT): personal and group accounts with guarded
 * balance updates. Every deposit/withdrawal is:
 *   - idempotent by caller-supplied `ref` (unique per transaction), and
 *   - atomic: balance CAS + transaction append (+ outbox event on pg) in
 *     one unit of work via CreditSavingsAccountRepository.applyTransaction.
 * Group accounts are administered by the group leader; members may read.
 */
@Injectable()
export class CreditSavingsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly accounts: CreditSavingsAccountRepository,
    @Inject(CREDIT_SAVINGS_TRANSACTION_REPOSITORY)
    private readonly transactions: CreditSavingsTransactionRepository,
    @Inject(CREDIT_GROUP_REPOSITORY) private readonly groups: CreditGroupRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY) private readonly members: CreditGroupMemberRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  /* --------------------------------------------------- personal accounts -- */

  /** Own account, auto-provisioned on first access (idempotent). */
  async getOwnAccount(actor: CreditActor): Promise<CreditSavingsAccount> {
    return this.ensureAccount({ userId: actor.id });
  }

  async listOwnTransactions(actor: CreditActor): Promise<CreditSavingsTransaction[]> {
    const account = await this.ensureAccount({ userId: actor.id });
    return this.transactions.find({ accountId: account.id });
  }

  async depositOwn(
    actor: CreditActor,
    amountKobo: number,
    ref: string
  ): Promise<SavingsTransactionResult> {
    const account = await this.ensureAccount({ userId: actor.id });
    return this.transact(account, 'deposit', amountKobo, ref, actor);
  }

  async withdrawOwn(
    actor: CreditActor,
    amountKobo: number,
    ref: string
  ): Promise<SavingsTransactionResult> {
    const account = await this.ensureAccount({ userId: actor.id });
    return this.transact(account, 'withdrawal', amountKobo, ref, actor);
  }

  /* ------------------------------------------------------ group accounts -- */

  /** Group account read (members); auto-provisioned on first access. */
  async getGroupAccount(groupId: string, actor: CreditActor): Promise<CreditSavingsAccount> {
    await this.requireMembership(groupId, actor);
    return this.ensureAccount({ groupId });
  }

  async listGroupTransactions(
    groupId: string,
    actor: CreditActor
  ): Promise<CreditSavingsTransaction[]> {
    await this.requireMembership(groupId, actor);
    const account = await this.ensureAccount({ groupId });
    return this.transactions.find({ accountId: account.id });
  }

  /** Group deposit — group leader only. */
  async depositGroup(
    groupId: string,
    actor: CreditActor,
    amountKobo: number,
    ref: string
  ): Promise<SavingsTransactionResult> {
    await this.requireLeader(groupId, actor);
    const account = await this.ensureAccount({ groupId });
    return this.transact(account, 'deposit', amountKobo, ref, actor);
  }

  /** Group withdrawal — group leader only. */
  async withdrawGroup(
    groupId: string,
    actor: CreditActor,
    amountKobo: number,
    ref: string
  ): Promise<SavingsTransactionResult> {
    await this.requireLeader(groupId, actor);
    const account = await this.ensureAccount({ groupId });
    return this.transact(account, 'withdrawal', amountKobo, ref, actor);
  }

  /* ------------------------------------------------------------ internals -- */

  private async ensureAccount(
    owner: { userId: string } | { groupId: string }
  ): Promise<CreditSavingsAccount> {
    const existing = await this.accounts.findOne(owner);
    if (existing) {
      return existing;
    }
    const account: CreditSavingsAccount = {
      id: newId('csav'),
      userId: 'userId' in owner ? owner.userId : undefined,
      groupId: 'groupId' in owner ? owner.groupId : undefined,
      balanceKobo: 0,
      updatedAt: new Date().toISOString()
    };
    try {
      return await this.accounts.create(account);
    } catch (error) {
      // Unique-owner race: a concurrent provisioning won — return it.
      if (error instanceof ConflictException) {
        const winner = await this.accounts.findOne(owner);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  private async transact(
    account: CreditSavingsAccount,
    direction: SavingsDirection,
    amountKobo: number,
    ref: string,
    actor: CreditActor
  ): Promise<SavingsTransactionResult> {
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      throw new BadRequestException('amountKobo must be a positive integer kobo amount');
    }
    if (!ref || !ref.trim()) {
      throw new BadRequestException('ref is required (idempotency key)');
    }
    const normalRef = ref.trim();
    const existing = await this.transactions.findOne({ ref: normalRef });
    if (existing) {
      return this.replay(account.id, existing, amountKobo, direction);
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await this.accounts.getById(account.id);
      const newBalance =
        direction === 'deposit'
          ? current.balanceKobo + amountKobo
          : current.balanceKobo - amountKobo;
      if (newBalance < 0) {
        throw new BadRequestException(
          `Insufficient savings balance (${current.balanceKobo} kobo) for a ${amountKobo} kobo withdrawal`
        );
      }
      const now = new Date().toISOString();
      const transaction: CreditSavingsTransaction = {
        id: newId('ctxn'),
        accountId: account.id,
        direction,
        amountKobo,
        balanceAfterKobo: newBalance,
        ref: normalRef,
        createdAt: now
      };
      const event = this.events.build(
        direction === 'deposit' ? 'credit.savings.deposited' : 'credit.savings.withdrawn',
        { accountId: account.id, amountKobo, ref: normalRef },
        actor.id
      );
      try {
        const result = await this.accounts.applyTransaction(
          account.id,
          { balanceKobo: current.balanceKobo },
          { balanceKobo: newBalance, updatedAt: now },
          transaction,
          event
        );
        if (this.accounts.transactionalOutbox) {
          this.events.emit(event);
        } else {
          await this.events.persist(event);
        }
        await this.audit?.record({
          actorId: actor.id,
          action: `credit.savings.${direction}`,
          entityType: 'credit_savings_account',
          entityId: account.id,
          metadata: { amountKobo, ref: normalRef, balanceAfterKobo: newBalance }
        });
        return { account: result.account, transaction: result.transaction, replay: false };
      } catch (error) {
        if (error instanceof ConflictException) {
          // Ref race: a concurrent request with the same ref committed.
          const winner = await this.transactions.findOne({ ref: normalRef });
          if (winner) {
            return this.replay(account.id, winner, amountKobo, direction);
          }
          // Balance CAS race: re-read and retry.
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException(
      `Savings account '${account.id}' is contended; retry the operation`
    );
  }

  /**
   * Idempotent replay: the stored transaction wins, but only when the ref
   * targets the same account, direction and amount — a ref reused with
   * different parameters is a 409, never a silent no-op.
   */
  private replay(
    accountId: string,
    stored: CreditSavingsTransaction,
    amountKobo: number,
    direction: SavingsDirection
  ): Promise<SavingsTransactionResult> {
    if (
      stored.accountId !== accountId ||
      stored.direction !== direction ||
      stored.amountKobo !== amountKobo
    ) {
      throw new ConflictException(
        `Savings ref '${stored.ref}' was already used with different parameters`
      );
    }
    return this.accounts
      .getById(accountId)
      .then((account) => ({ account, transaction: stored, replay: true }));
  }

  private async requireMembership(groupId: string, actor: CreditActor): Promise<void> {
    await this.groups.getById(groupId);
    if (actor.roles.includes('admin')) {
      return;
    }
    const membership = await this.members.find(groupId, actor.id);
    if (!membership) {
      throw new ForbiddenException('Only group members may access the group savings account');
    }
  }

  private async requireLeader(groupId: string, actor: CreditActor): Promise<void> {
    await this.groups.getById(groupId);
    if (actor.roles.includes('admin')) {
      return;
    }
    const membership = await this.members.find(groupId, actor.id);
    if (!membership || membership.role !== 'leader') {
      throw new ForbiddenException('Only the group leader may move group savings');
    }
  }
}
