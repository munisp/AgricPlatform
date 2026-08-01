import { describe, expect, it } from 'vitest';
import { DomainEventsService } from './domain-events.service.js';

describe('DomainEventsService', () => {
  it('publishes events using the {domain}.{entity}.{verb} taxonomy', () => {
    const service = new DomainEventsService();
    const seen: string[] = [];
    service.on('learning.certificate.issued', (event) => seen.push(event.name));

    const event = service.publish('learning.certificate.issued', { certificateId: 'cert-1' }, 'user-1');
    expect(event.name).toBe('learning.certificate.issued');
    expect(seen).toEqual(['learning.certificate.issued']);
    expect(service.listOutbox()).toHaveLength(1);
  });

  it('rejects names outside the taxonomy', () => {
    const service = new DomainEventsService();
    expect(() => service.publish('certificateIssued', {})).toThrow(/taxonomy/);
    expect(() => service.publish('too.many.segments.here', {})).toThrow(/taxonomy/);
  });
});
