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
    it('collects crop, quantity and price, then emits create_listing on YES', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'YES']);
      expect(turns[0].reply).toContain('What crop');
      expect(turns[1].reply).toContain('How many kg of Maize');
      expect(turns[2].reply).toContain('total price in NGN for 500 kg of Maize');
      expect(turns[3].reply).toContain('500 kg Maize for NGN 250,000');
      const final = turns[4];
      expect(final.action).toEqual({
        type: 'create_listing',
        crop: 'Maize',
        quantityKg: 500,
        priceNaira: 250000
      });
      expect(final.flow).toBeUndefined();
    });

    it('accepts comma-formatted amounts', () => {
      const turns = run(['listing', 'Rice', '1,000', '2,500,000', 'yes']);
      expect(turns[4].action).toEqual({
        type: 'create_listing',
        crop: 'Rice',
        quantityKg: 1000,
        priceNaira: 2500000
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

    it('cancels cleanly on NO at the confirmation step', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'NO']);
      expect(turns[4].reply).toContain('Cancelled');
      expect(turns[4].action).toBeUndefined();
      expect(turns[4].flow).toBeUndefined();
    });

    it('re-prompts on an invalid confirmation answer', () => {
      const turns = run(['1', 'Maize', '500', '250000', 'maybe']);
      expect(turns[4].reply).toContain('Reply YES to publish or NO to cancel');
      expect(turns[4].flow).toMatchObject({ step: 'confirm' });
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
