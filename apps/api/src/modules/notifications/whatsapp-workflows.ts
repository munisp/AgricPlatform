/**
 * WhatsApp guided-chat workflows (wave P5b) — pure, deterministic state
 * machines over inbound text. The conversation service
 * (inbound-conversations.service.ts) owns persistence (KV store, 24h TTL),
 * user resolution and action execution; these functions only decide the
 * next prompt. Workflow state is serialisable JSON so it round-trips
 * through Redis unchanged.
 */

export type WaFlow =
  | {
      kind: 'listing';
      step: 'crop' | 'quantity' | 'price' | 'lga' | 'confirm';
      crop?: string;
      quantityKg?: number;
      priceNaira?: number;
      lga?: string;
    }
  | { kind: 'advisory'; step: 'crop' | 'state'; crop?: string };

export type WaAction =
  | {
      type: 'create_listing';
      crop: string;
      quantityKg: number;
      priceNaira: number;
      /** Local Government Area the produce is sold from (wave P6b). */
      lga: string;
    }
  | { type: 'advisory_request'; crop: string; state: string }
  | { type: 'confirm_action'; code: string };

export interface WaTurn {
  /** Next workflow state; undefined ends/clears the workflow. */
  flow?: WaFlow;
  /** Prompt sent back to the sender; the service may override it after executing an action. */
  reply: string;
  action?: WaAction;
}

export const WA_MENU =
  'Welcome to AgricPlatform. Reply:\n1 Create a marketplace listing\n2 Get crop advisory\nCONFIRM <code> to confirm a notification action\nCANCEL to stop';

const CANCEL_REPLY = 'Cancelled. Reply MENU for options.';
const YES = /^(yes|y|1)$/i;
const NO = /^(no|n|2)$/i;

function parseAmount(text: string): number | undefined {
  const value = Number(text.replace(/[,\s]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isCropName(text: string): boolean {
  return /^[a-zA-Z][a-zA-Z' -]{1,39}$/.test(text.trim());
}

/**
 * LGA capture (wave P6b): packages/shared ships no Nigeria LGA fixture, so
 * the chat step accepts free text up to 60 chars (letters/spaces — matches
 * real LGA names like "Kano Municipal" or "Obafemi Owode").
 */
export const WA_LGA_MAX_CHARS = 60;

function isLgaName(text: string): boolean {
  return /^[a-zA-Z][a-zA-Z' -]{0,59}$/.test(text.trim());
}

/**
 * Routes one inbound WhatsApp text through the active workflow (if any).
 * Global commands win everywhere: CANCEL aborts, MENU resets to the menu,
 * CONFIRM <code> triggers a pending notification action.
 */
export function routeWaMessage(flow: WaFlow | undefined, rawText: string): WaTurn {
  const text = rawText.trim();

  if (/^cancel$/i.test(text)) {
    return { reply: CANCEL_REPLY };
  }
  if (/^(menu|start|hi|hello)$/i.test(text)) {
    return { reply: WA_MENU };
  }
  const confirmMatch = /^confirm\s+([a-z0-9-]+)$/i.exec(text);
  if (confirmMatch && !flow) {
    return {
      reply: 'Confirming your action…',
      action: { type: 'confirm_action', code: confirmMatch[1].toLowerCase() }
    };
  }

  if (!flow) {
    if (text === '1' || /^listing$/i.test(text)) {
      return {
        flow: { kind: 'listing', step: 'crop' },
        reply: 'What crop are you selling? (e.g. Maize)'
      };
    }
    if (text === '2' || /^advisory$/i.test(text)) {
      return {
        flow: { kind: 'advisory', step: 'crop' },
        reply: 'Which crop do you need advisory for? (e.g. Rice)'
      };
    }
    return { reply: WA_MENU };
  }

  return flow.kind === 'listing' ? advanceListing(flow, text) : advanceAdvisory(flow, text);
}

function advanceListing(flow: Extract<WaFlow, { kind: 'listing' }>, text: string): WaTurn {
  switch (flow.step) {
    case 'crop': {
      if (!isCropName(text)) {
        return { flow, reply: 'Please enter a crop name (letters only, e.g. Maize):' };
      }
      return {
        flow: { ...flow, step: 'quantity', crop: text.trim() },
        reply: `How many kg of ${text.trim()} are you selling?`
      };
    }
    case 'quantity': {
      const quantityKg = parseAmount(text);
      if (!quantityKg) {
        return { flow, reply: 'Enter the quantity in kg (numbers only, e.g. 500):' };
      }
      return {
        flow: { ...flow, step: 'price', quantityKg },
        reply: `What is the total price in NGN for ${quantityKg} kg of ${flow.crop}?`
      };
    }
    case 'price': {
      const priceNaira = parseAmount(text);
      if (!priceNaira) {
        return { flow, reply: 'Enter the total price in NGN (numbers only, e.g. 250000):' };
      }
      return {
        flow: { ...flow, step: 'lga', priceNaira },
        reply: `Which LGA is this ${flow.crop} sold from? (e.g. Dala, Kano Municipal)`
      };
    }
    case 'lga': {
      if (!isLgaName(text)) {
        return {
          flow,
          reply: `Enter the LGA name (letters only, up to ${WA_LGA_MAX_CHARS} chars, e.g. Dala):`
        };
      }
      return {
        flow: { ...flow, step: 'confirm', lga: text.trim() },
        reply:
          `Listing: ${flow.quantityKg} kg ${flow.crop} for ` +
          `NGN ${(flow.priceNaira as number).toLocaleString('en-NG')} in ${text.trim()} LGA.\n` +
          'Reply YES to publish or NO to cancel.'
      };
    }
    case 'confirm': {
      if (!flow.lga) {
        // Flow serialised before the LGA step shipped (24h KV TTL): collect it.
        return {
          flow: { ...flow, step: 'lga' },
          reply: `Which LGA is this ${flow.crop} sold from? (e.g. Dala, Kano Municipal)`
        };
      }
      if (YES.test(text)) {
        return {
          reply: 'Publishing your listing…',
          action: {
            type: 'create_listing',
            crop: flow.crop as string,
            quantityKg: flow.quantityKg as number,
            priceNaira: flow.priceNaira as number,
            lga: flow.lga as string
          }
        };
      }
      if (NO.test(text)) {
        return { reply: CANCEL_REPLY };
      }
      return { flow, reply: 'Reply YES to publish or NO to cancel.' };
    }
  }
}

function advanceAdvisory(flow: Extract<WaFlow, { kind: 'advisory' }>, text: string): WaTurn {
  switch (flow.step) {
    case 'crop': {
      if (!isCropName(text)) {
        return { flow, reply: 'Please enter a crop name (letters only, e.g. Rice):' };
      }
      return {
        flow: { ...flow, step: 'state', crop: text.trim() },
        reply: `Which state is your ${text.trim()} farm in? (e.g. Kano)`
      };
    }
    case 'state': {
      if (!isCropName(text)) {
        return { flow, reply: 'Please enter a state name (letters only, e.g. Kano):' };
      }
      return {
        reply: 'Fetching the latest advisory…',
        action: { type: 'advisory_request', crop: flow.crop as string, state: text.trim() }
      };
    }
  }
}
