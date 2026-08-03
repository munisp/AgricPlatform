import { capResponse } from '../ussd/menu-engine.js';

/**
 * Agent-banking USSD menu engine (wave AGENTBANK) — a pure, deterministic
 * state machine mirroring the voice module's USSD engine. No I/O: the
 * caller passes the current state, the latest input segment and the data
 * the menu needs, and receives the next state, the full CON/END response
 * (≤182 chars, Africa's Talking turnaround limit) and an optional side
 * effect for the service layer (float balance lookup, recent transactions,
 * voucher redemption).
 */

export type AgentUssdMenuId = 'main' | 'voucher_code' | 'voucher_confirm';

export interface AgentUssdState {
  menu: AgentUssdMenuId;
  /** Voucher code typed at voucher_code, awaiting confirmation. */
  voucherCode?: string;
}

/** Live data one turn may need; gathered by the service per callback. */
export interface AgentUssdMenuData {
  /** Agent float balance in whole naira, when resolvable. */
  floatBalanceNaira?: number;
  /** Whether the float is at/below the low-float threshold. */
  lowFloat?: boolean;
  /** Up to 5 most recent transactions for the "last 5" screen. */
  recentTransactions?: Array<{
    type: 'cash_in' | 'cash_out' | 'voucher_redemption';
    amountNaira: number;
    day: string; // YYYY-MM-DD
  }>;
}

export type AgentUssdEffect =
  | { type: 'float_balance' }
  | { type: 'recent_transactions' }
  | { type: 'redeem_voucher'; voucherCode: string };

export interface AgentUssdTurn {
  state: AgentUssdState;
  /** Full response body including the CON/END prefix (≤182 chars). */
  response: string;
  end: boolean;
  effect?: AgentUssdEffect;
}

const BODY_CAP = 182 - 4;

const MAIN_MENU = 'Agent Banking\n1 Float balance\n2 Last 5 transactions\n3 Redeem voucher';

function con(state: AgentUssdState, body: string): AgentUssdTurn {
  return { state, response: `CON ${capResponse(body, BODY_CAP)}`, end: false };
}

function end(state: AgentUssdState, body: string): AgentUssdTurn {
  return { state, response: `END ${capResponse(body, BODY_CAP)}`, end: true };
}

export function initialAgentUssdState(): AgentUssdState {
  return { menu: 'main' };
}

function formatNaira(value: number): string {
  return `NGN ${Math.round(value).toLocaleString('en-NG')}`;
}

function txTypeLabel(type: 'cash_in' | 'cash_out' | 'voucher_redemption'): string {
  switch (type) {
    case 'cash_in':
      return 'Cash-in';
    case 'cash_out':
      return 'Cash-out';
    case 'voucher_redemption':
      return 'Voucher';
  }
}

/**
 * Advances the machine one turn. `input` is the latest segment of the
 * Africa's Talking `text` field (empty string on the opening dial). In any
 * sub-menu, `0` returns to the main menu.
 */
export function handleAgentUssdTurn(
  state: AgentUssdState,
  input: string,
  data: AgentUssdMenuData
): AgentUssdTurn {
  const text = input.trim();

  if (text === '') {
    return con(initialAgentUssdState(), MAIN_MENU);
  }
  if (state.menu !== 'main' && text === '0') {
    return con(initialAgentUssdState(), MAIN_MENU);
  }

  switch (state.menu) {
    case 'main':
      return handleMain(state, text, data);
    case 'voucher_code':
      return handleVoucherCode(state, text);
    case 'voucher_confirm':
      return handleVoucherConfirm(state, text);
  }
}

function handleMain(
  state: AgentUssdState,
  text: string,
  data: AgentUssdMenuData
): AgentUssdTurn {
  switch (text) {
    case '1': {
      if (data.floatBalanceNaira === undefined) {
        return end(initialAgentUssdState(), 'Float balance is unavailable right now.');
      }
      const flag = data.lowFloat ? '\nLOW FLOAT — request a top-up.' : '';
      return end(initialAgentUssdState(), `Float balance: ${formatNaira(data.floatBalanceNaira)}${flag}`);
    }
    case '2': {
      const recent = (data.recentTransactions ?? []).slice(0, 5);
      if (recent.length === 0) {
        return end(initialAgentUssdState(), 'No transactions yet.');
      }
      const lines = recent.map(
        (tx) => `${txTypeLabel(tx.type)} ${formatNaira(tx.amountNaira)} ${tx.day.slice(5)}`
      );
      return end(initialAgentUssdState(), `Last ${recent.length} transactions:\n${lines.join('\n')}`);
    }
    case '3':
      return con({ menu: 'voucher_code', voucherCode: undefined }, 'Enter the voucher code:');
    default:
      return con(state, `Invalid choice.\n${MAIN_MENU}`);
  }
}

function handleVoucherCode(state: AgentUssdState, text: string): AgentUssdTurn {
  if (!/^[a-z0-9-]{4,64}$/i.test(text)) {
    return con(state, 'Invalid code. Enter the voucher code:');
  }
  // No lookup here: signature/status verification happens server-side in
  // the service when the redemption effect executes.
  return con({ menu: 'voucher_confirm', voucherCode: text }, `Redeem voucher ${text}?\n1 Yes\n2 No`);
}

function handleVoucherConfirm(state: AgentUssdState, text: string): AgentUssdTurn {
  if (!state.voucherCode) {
    return con(initialAgentUssdState(), MAIN_MENU);
  }
  if (text === '1') {
    return {
      state: initialAgentUssdState(),
      response: 'END Redeeming voucher…',
      end: true,
      effect: { type: 'redeem_voucher', voucherCode: state.voucherCode }
    };
  }
  if (text === '2') {
    return end(initialAgentUssdState(), 'Voucher redemption cancelled.');
  }
  return con(state, `Redeem voucher ${state.voucherCode}?\nReply 1 for Yes or 2 for No:`);
}
