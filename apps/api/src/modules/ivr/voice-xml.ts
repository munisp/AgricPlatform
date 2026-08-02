import type { IvrAction } from './call-flow.js';

/**
 * Africa's Talking Voice XML renderer (wave P6a). Turns the engine's action
 * list into the `<Response>` document the callback endpoint returns. All
 * dynamic text passes through escapeXml so prompt content (e.g. advisory
 * summaries with `&` or `<`) can never break the document.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderAction(action: IvrAction): string {
  switch (action.type) {
    case 'say':
      return `<Say>${escapeXml(action.text)}</Say>`;
    case 'getDigits':
      return (
        `<GetDigits timeout="${action.timeoutSeconds}" numDigits="${action.numDigits}">` +
        `<Say>${escapeXml(action.prompt)}</Say>` +
        `</GetDigits>`
      );
    case 'enqueue':
      // Agent-escalation placeholder: Enqueue hands the caller to the AT
      // dashboard queue; a Dial-to-agent-number action can replace it once
      // the call-centre number is provisioned (provider-side concern).
      return '<Enqueue/>';
    case 'reject':
      return '<Reject/>';
  }
}

export function renderVoiceXml(actions: readonly IvrAction[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response>${actions.map(renderAction).join('')}</Response>`
  );
}

/** Empty response for hangup notifications (isActive=0) that need no action. */
export function emptyVoiceXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
}
