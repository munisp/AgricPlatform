import { Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import {
  LEDGER_BACKEND,
  type LedgerBackendDriver
} from '../integrations/drivers/tigerbeetle.driver.js';
import { LedgerService } from './ledger.service.js';

/** One pg ledger account ↔ TigerBeetle account mapping to compare. */
export interface TbPgAccountPair {
  /** pg ledger account natural key (finance.ledger_accounts.code). */
  accountCode: string;
  /** TigerBeetle account id (decimal-string u128). */
  tbAccountId: string;
}

export interface TbConsistencyDivergence {
  accountCode: string;
  tbAccountId: string;
  /** null when the pg account or the TB account does not exist. */
  pgBalanceKobo: number | null;
  tbBalanceKobo: number | null;
  driftKobo: number | null;
  detail: string;
}

export interface TbConsistencyReport {
  /** False unless the tigerbeetle ledger backend is selected (legal gate). */
  enabled: boolean;
  checkedAt: string;
  detail: string;
  checkedPairs: number;
  /**
   * True when tigerbeetle is selected but NO account pairs are configured:
   * consistency cannot be proven, so this is itself an alert — TigerBeetle
   * can never be enabled silently unverifiable.
   */
  unmapped: boolean;
  divergent: TbConsistencyDivergence[];
  balanced: boolean;
}

/**
 * Parses TIGERBEETLE_ACCOUNT_MAP: a JSON array of
 * {"accountCode": "<pg code>", "tbAccountId": "<decimal u128>"} pairs.
 * Malformed config throws (fail visible — a silent empty map would read as
 * "nothing to check").
 */
export function parseTbAccountMap(raw?: string): TbPgAccountPair[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TIGERBEETLE_ACCOUNT_MAP is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TIGERBEETLE_ACCOUNT_MAP must be a JSON array of {accountCode, tbAccountId}');
  }
  return parsed.map((item, index) => {
    const pair = item as Partial<TbPgAccountPair> | null;
    if (
      !pair ||
      typeof pair.accountCode !== 'string' ||
      !pair.accountCode ||
      typeof pair.tbAccountId !== 'string' ||
      !/^[0-9]+$/.test(pair.tbAccountId)
    ) {
      throw new Error(
        `TIGERBEETLE_ACCOUNT_MAP[${index}] must be {"accountCode": string, "tbAccountId": decimal-string u128}`
      );
    }
    return { accountCode: pair.accountCode, tbAccountId: pair.tbAccountId };
  });
}

/**
 * pg ↔ TigerBeetle consistency checker (Stage 27, WP-G13 ledger hardening).
 *
 * The TigerBeetle backend is a legal-gated proof-of-port; if it is ever
 * enabled (LEDGER_DRIVER=tigerbeetle), the platform must be able to PROVE
 * the two ledgers agree. This checker compares, per configured account
 * pair, the pg ledger balance (Σ debits − Σ credits, integer kobo) against
 * the TigerBeetle posted balance (debits_posted − credits_posted). Any
 * divergence — or enabling tigerbeetle with no account map at all — is
 * fail-visible: telemetry metric + audit row + an unbalanced report. The
 * checker is inert while the stub backend is selected (report.enabled
 * === false), so the default Postgres-authoritative deployment is never
 * spammed.
 *
 * Scheduler wiring is out of scope (WP-G12 owns schedulers); the admin
 * endpoint GET /finance/ledger/reconciliation/backend drives it on demand.
 */
@Injectable()
export class TbConsistencyChecker {
  private readonly logger = new Logger(TbConsistencyChecker.name);
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly ledger: LedgerService,
    @Optional() @Inject(LEDGER_BACKEND) private readonly backend?: LedgerBackendDriver,
    @Optional() private readonly audit?: AuditService,
    @Optional() telemetry?: TelemetryService
  ) {
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /** The checker is live only when the tigerbeetle backend is selected. */
  get enabled(): boolean {
    return this.backend?.name === 'tigerbeetle';
  }

  /**
   * Compares pg ledger balances against TigerBeetle posted balances for the
   * given pairs (or TIGERBEETLE_ACCOUNT_MAP when omitted).
   */
  async runCheck(pairs?: readonly TbPgAccountPair[], env: NodeJS.ProcessEnv = process.env): Promise<TbConsistencyReport> {
    const checkedAt = new Date().toISOString();
    if (!this.enabled) {
      return {
        enabled: false,
        checkedAt,
        detail:
          'Checker disabled: the tigerbeetle ledger backend is not selected ' +
          '(Postgres ledger is authoritative); no pg↔TB comparison applies.',
        checkedPairs: 0,
        unmapped: false,
        divergent: [],
        balanced: true
      };
    }
    const resolvedPairs = pairs ?? parseTbAccountMap(env.TIGERBEETLE_ACCOUNT_MAP);
    if (resolvedPairs.length === 0) {
      // Fail visible: tigerbeetle enabled with nothing to verify against.
      this.telemetry.increment('finance.ledger.tb_consistency.unmapped', 1);
      await this.audit?.record({
        actorId: 'system',
        action: 'finance.ledger.tb_consistency_unmapped',
        entityType: 'ledger_backend',
        entityId: 'tigerbeetle',
        metadata: {}
      });
      return {
        enabled: true,
        checkedAt,
        detail:
          'TigerBeetle backend is ENABLED but no account pairs are configured ' +
          '(TIGERBEETLE_ACCOUNT_MAP is empty) — pg↔TB consistency cannot be proven. ' +
          'Do not treat the backend as verified.',
        checkedPairs: 0,
        unmapped: true,
        divergent: [],
        balanced: false
      };
    }
    if (typeof this.backend?.lookupAccountBalances !== 'function') {
      throw new ServiceUnavailableException(
        'The selected tigerbeetle backend cannot answer account balance lookups; ' +
          'refusing to report pg↔TB consistency as verified.'
      );
    }
    const tbBalances = await this.backend.lookupAccountBalances(
      resolvedPairs.map((pair) => pair.tbAccountId)
    );
    const divergent: TbConsistencyDivergence[] = [];
    for (const [index, pair] of resolvedPairs.entries()) {
      let pgBalanceKobo: number | null;
      try {
        pgBalanceKobo = (await this.ledger.balance(pair.accountCode)).balanceKobo;
      } catch (error) {
        if (error instanceof NotFoundException) {
          pgBalanceKobo = null;
        } else {
          throw error;
        }
      }
      const tb = tbBalances[index];
      const tbBalanceKobo = tb ? tb.debitsPostedKobo - tb.creditsPostedKobo : null;
      if (pgBalanceKobo === null || tbBalanceKobo === null) {
        divergent.push({
          accountCode: pair.accountCode,
          tbAccountId: pair.tbAccountId,
          pgBalanceKobo,
          tbBalanceKobo,
          driftKobo: null,
          detail:
            pgBalanceKobo === null
              ? `pg ledger account '${pair.accountCode}' does not exist`
              : `TigerBeetle account '${pair.tbAccountId}' does not exist`
        });
      } else if (pgBalanceKobo !== tbBalanceKobo) {
        divergent.push({
          accountCode: pair.accountCode,
          tbAccountId: pair.tbAccountId,
          pgBalanceKobo,
          tbBalanceKobo,
          driftKobo: pgBalanceKobo - tbBalanceKobo,
          detail: `pg balance ${pgBalanceKobo} kobo != TigerBeetle balance ${tbBalanceKobo} kobo`
        });
      }
    }
    const balanced = divergent.length === 0;
    if (!balanced) {
      this.logger.warn(
        `pg↔TB consistency divergence over ${divergent.length}/${resolvedPairs.length} pair(s)`
      );
      this.telemetry.increment('finance.ledger.tb_consistency.divergent', divergent.length);
      await this.audit?.record({
        actorId: 'system',
        action: 'finance.ledger.tb_consistency_divergent',
        entityType: 'ledger_backend',
        entityId: 'tigerbeetle',
        metadata: {
          checkedPairs: resolvedPairs.length,
          divergent: divergent.map((item) => ({
            accountCode: item.accountCode,
            tbAccountId: item.tbAccountId,
            driftKobo: item.driftKobo
          }))
        }
      });
    }
    return {
      enabled: true,
      checkedAt,
      detail: balanced
        ? `All ${resolvedPairs.length} configured pg↔TB account pair(s) agree.`
        : `${divergent.length} of ${resolvedPairs.length} pg↔TB account pair(s) diverge.`,
      checkedPairs: resolvedPairs.length,
      unmapped: false,
      divergent,
      balanced
    };
  }
}
