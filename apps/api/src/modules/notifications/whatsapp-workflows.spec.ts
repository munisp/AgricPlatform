import { describe, expect, it } from 'vitest';
import { routeWaMessage, WA_MENU, type WaFlow } from './whatsapp-workflows.js';

function run(messages: string[]) {
  let flow: WaFlow | undefined;
  return messages.map((message) => {
    const turn = routeWaMessage(flow, message);
    flow = turn.flow;
    return turn;
  });
}

describe('WhatsApp workflow router', () => {
  it('shows the menu for an unstructured first message', () => {
    const [turn] = run(['hello there']);
    expect(turn.reply).toBe(WA_MENU);
    expect(turn.flow).toBeUndefined();
  });

  it('resets to the menu on MENU even mid-flow', () => {
    const turns = run(['1', 'menu']);
    expect(turns[1].reply).toBe(WA_MENU);
    expect(turns[1].flow).toBeUndefined();
  });

  it('cancels an in-progress flow on CANCEL', () => {
    const turns = run(['1', 'cancel']);
    expect(turns[1].reply).toContain('Cancelled');
    expect(turns[1].flow).toBeUndefined();
  });

  describe('marketplace listing flow', () => {
    it('collects crop, quantity, price and LGA, then emits create_listing on YES', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'Dala', 'YES']);
      expect(turns[0].reply).toContain('What crop');
      expect(turns[1].reply).toContain('How many kg of Maize');
      expect(turns[2].reply).toContain('total price in NGN for 500 kg of Maize');
      expect(turns[3].reply).toContain('Which LGA');
      expect(turns[4].reply).toContain('500 kg Maize for NGN 250,000 in Dala LGA');
      const final = turns[5];
      expect(final.action).toEqual({
        type: 'create_listing',
        crop: 'Maize',
        quantityKg: 500,
        priceNaira: 250000,
        lga: 'Dala'
      });
      expect(final.flow).toBeUndefined();
    });

    it('accepts comma-formatted amounts', () => {
      const turns = run(['listing', 'Rice', '1,000', '2,500,000', 'Kano Municipal', 'yes']);
      expect(turns[5].action).toEqual({
        type: 'create_listing',
        crop: 'Rice',
        quantityKg: 1000,
        priceNaira: 2500000,
        lga: 'Kano Municipal'
      });
    });

    it('rejects an invalid crop name and stays on the crop step', () => {
      const turns = run(['1', '123']);
      expect(turns[1].reply).toContain('crop name');
      expect(turns[1].flow).toMatchObject({ kind: 'listing', step: 'crop' });
    });

    it('rejects a non-numeric quantity and stays on the quantity step', () => {
      const turns = run(['1', 'Maize', 'plenty']);
      expect(turns[2].reply).toContain('quantity in kg');
      expect(turns[2].flow).toMatchObject({ step: 'quantity' });
    });

    it('rejects a non-numeric price and stays on the price step', () => {
      const turns = run(['1', 'Maize', '500', 'free']);
      expect(turns[3].reply).toContain('price in NGN');
      expect(turns[3].flow).toMatchObject({ step: 'price' });
    });

    it('rejects an LGA over 60 chars and stays on the lga step', () => {
      const turns = run(['1', 'Maize', '500', '250000', `A${'a'.repeat(60)}`]);
      expect(turns[4].reply).toContain('LGA name');
      expect(turns[4].flow).toMatchObject({ step: 'lga' });
    });

    it('rejects a non-letter LGA and stays on the lga step', () => {
      const turns = run(['1', 'Maize', '500', '250000', '1234']);
      expect(turns[4].reply).toContain('LGA name');
      expect(turns[4].flow).toMatchObject({ step: 'lga' });
    });

    it('cancels cleanly on NO at the confirmation step', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'Dala', 'NO']);
      expect(turns[5].reply).toContain('Cancelled');
      expect(turns[5].action).toBeUndefined();
      expect(turns[5].flow).toBeUndefined();
    });

    it('re-prompts on an invalid confirmation answer', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'Dala', 'maybe']);
      expect(turns[5].reply).toContain('Reply YES to publish or NO to cancel');
      expect(turns[5].flow).toMatchObject({ step: 'confirm' });
    });

    it('collects the LGA for confirm-state flows serialised before the step shipped', () => {
      const legacy: WaFlow = {
        kind: 'listing',
        step: 'confirm',
        crop: 'Maize',
        quantityKg: 500,
        priceNaira: 250000
      };
      const turn = routeWaMessage(legacy, 'YES');
      expect(turn.action).toBeUndefined();
      expect(turn.flow).toMatchObject({ step: 'lga' });
      expect(turn.reply).toContain('Which LGA');
    });
  });

  describe('crop advisory flow', () => {
    it('collects crop and state, then emits advisory_request', () => {
      const turns = run(['2', 'Rice', 'Kano']);
      expect(turns[0].reply).toContain('Which crop');
      expect(turns[1].reply).toContain('Which state is your Rice farm in');
      expect(turns[2].action).toEqual({ type: 'advisory_request', crop: 'Rice', state: 'Kano' });
      expect(turns[2].flow).toBeUndefined();
    });

    it('rejects an invalid state and stays on the state step', () => {
      const turns = run(['advisory', 'Rice', '42']);
      expect(turns[2].flow).toMatchObject({ kind: 'advisory', step: 'state' });
    });
  });

  describe('tap-to-confirm actions', () => {
    it('emits confirm_action for CONFIRM <code> outside a flow', () => {
      const [turn] = run(['CONFIRM ab-123']);
      expect(turn.action).toEqual({ type: 'confirm_action', code: 'ab-123' });
    });

    it('does not hijack CONFIRM while a flow is active', () => {
      const turns = run(['1', 'CONFIRM ab-123']);
      // Inside the listing flow the text is treated as a (invalid) crop answer.
      expect(turns[1].action).toBeUndefined();
      expect(turns[1].flow).toMatchObject({ kind: 'listing' });
    });
  });
});
