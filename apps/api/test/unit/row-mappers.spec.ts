import { describe, expect, it } from 'vitest';
import type { MarketplaceListing, Profile } from '@agric-platform/shared';
import { hashAuditEvent } from '../../src/core/audit-chain.js';
import {
  auditMapper,
  deliveryLogMapper,
  listingMapper,
  opportunityMapper,
  profileMapper,
  userMapper
} from '../../src/database/pg/row-mappers.js';

/** Round-trip and shape tests for the trickiest row mappers (plan §9.3). */
describe('row mappers', () => {
  it('listing: LocationRef columns and numeric conversion', () => {
    const row = {
      id: 'listing-1',
      seller_id: 'user-adamu',
      kind: 'produce',
      title: 'Maize lot',
      crop: 'maize',
      quantity: '12.50',
      unit: 'tonnes',
      price_ngn: '275000.00',
      location_state: 'Kano',
      location_lga: 'Nassarawa',
      location_ward: null,
      location_latitude: '12.002200',
      location_longitude: null,
      harvest_date: new Date('2026-06-01T00:00:00Z'),
      is_active: true
    };
    const listing = listingMapper.fromRow(row);
    expect(listing.quantity).toBe(12.5);
    expect(listing.priceNaira).toBe(275000);
    expect(listing.location).toEqual({
      state: 'Kano',
      lga: 'Nassarawa',
      ward: undefined,
      latitude: 12.0022,
      longitude: undefined
    });
    expect(listing.harvestDate).toBe('2026-06-01');
  });

  it('listing: toRow round-trips through fromRow', () => {
    const listing: MarketplaceListing = {
      id: 'listing-2',
      sellerId: 'user-adamu',
      kind: 'equipment',
      title: 'Tractor hire',
      quantity: 3,
      unit: 'units',
      priceNaira: 150000,
      location: { state: 'Kaduna', lga: 'Zaria', ward: 'Tudun Wada' },
      isActive: true
    };
    const back = listingMapper.fromRow({
      ...listingMapper.toRow(listing),
      location_ward: 'Tudun Wada'
    });
    expect(back).toEqual({ ...listing, harvestDate: undefined, crop: undefined });
  });

  it('profile: flat columns reassemble LocationRef; arrays pass through', () => {
    const profile: Profile = {
      userId: 'user-adamu',
      location: { state: 'Kano', lga: 'Nassarawa' },
      farmingInterests: ['maize'],
      valueChains: ['grains'],
      completionScore: 70,
      badges: ['contributor']
    };
    const back = profileMapper.fromRow(profileMapper.toRow(profile));
    expect(back.userId).toBe('user-adamu');
    expect(back.location).toEqual({
      state: 'Kano',
      lga: 'Nassarawa',
      ward: undefined,
      latitude: undefined,
      longitude: undefined
    });
    expect(back.valueChains).toEqual(['grains']);
  });

  it('opportunity: text[] columns round-trip', () => {
    const row = {
      id: 'opp-1',
      title: 'Grant',
      type: 'grant',
      description: 'd',
      states: ['Kano', 'Kaduna'],
      value_chains: ['maize'],
      eligibility: ['women'],
      deadline: new Date('2027-01-01T00:00:00.000Z'),
      partner_id: null,
      is_active: true
    };
    const opp = opportunityMapper.fromRow(row);
    expect(opp.states).toEqual(['Kano', 'Kaduna']);
    expect(opp.partnerId).toBeUndefined();
    expect(opp.deadline).toBe('2027-01-01T00:00:00.000Z');
  });

  it('user: toRow only emits keys present on the patch', () => {
    expect(userMapper.toRow({ fullName: 'New Name' } as never)).toEqual({
      full_name: 'New Name'
    });
    // present-but-undefined clears to NULL (NDPR anonymize path)
    expect(userMapper.toRow({ email: undefined } as never)).toEqual({ email: null });
  });

  it('delivery log: DeliveryResult serializes into detail jsonb', () => {
    const entry = {
      id: 'delivery-1',
      notificationId: 'notif-1',
      result: {
        delivered: true,
        provider: 'termii',
        driver: 'stub',
        providerRef: 'stub-123',
        note: 'ok'
      },
      at: '2026-02-19T10:00:00.000Z'
    };
    const row = deliveryLogMapper.toRow(entry);
    expect(row.provider).toBe('termii');
    expect(row.status).toBe('delivered');
    expect(row.detail).toEqual(entry.result);
    const back = deliveryLogMapper.fromRow({ ...row, attempted_at: new Date(entry.at) });
    expect(back.notificationId).toBe('notif-1');
    expect(back.at).toBe(entry.at);
  });

  it('audit: hash-chain columns round-trip (observability §A.6)', () => {
    const event = {
      id: 'audit-1',
      actorId: 'admin-1',
      action: 'user.suspend',
      entityType: 'user',
      entityId: 'user-1',
      metadata: { reason: 'fraud' },
      createdAt: '2026-02-19T10:00:00.000Z',
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
      requestId: 'req-1'
    };
    const row = auditMapper.toRow(event);
    expect(auditMapper.columns).toContain('prev_hash');
    expect(auditMapper.columns).toContain('hash');
    expect(auditMapper.columns).toContain('request_id');
    expect(row.prev_hash).toBe(event.prevHash);
    expect(row.hash).toBe(event.hash);
    expect(row.request_id).toBe('req-1');

    const back = auditMapper.fromRow({ ...row, created_at: new Date(event.createdAt) });
    expect(back).toEqual(event);

    // Payload-hash stability (audit C2-11): the event verify() rebuilds from
    // the row must hash identically to the writer's in-memory event.
    const { hash: _stored, ...unsignedWritten } = event;
    const { hash: _mapped, ...unsignedMapped } = back;
    expect(hashAuditEvent(unsignedMapped, back.prevHash!)).toBe(
      hashAuditEvent(unsignedWritten, event.prevHash)
    );

    // Legacy rows without hash columns map to undefined (additive contract).
    const legacy = auditMapper.fromRow({
      ...row,
      prev_hash: null,
      hash: null,
      request_id: null,
      created_at: new Date(event.createdAt)
    });
    expect(legacy.prevHash).toBeUndefined();
    expect(legacy.hash).toBeUndefined();
    expect(legacy.requestId).toBeUndefined();
    // The keys must be ABSENT, not present-but-undefined: canonicalJSON
    // serializes an own undefined key as `"key":undefined`, which would
    // change the hashed payload and break verify() recomputation (C2-11).
    expect(Object.keys(legacy)).not.toContain('prevHash');
    expect(Object.keys(legacy)).not.toContain('hash');
    expect(Object.keys(legacy)).not.toContain('requestId');
    // …and a row without request_id must round-trip without the key too.
    const noRequestId = auditMapper.fromRow({
      ...row,
      request_id: null,
      created_at: new Date(event.createdAt)
    });
    expect(Object.keys(noRequestId)).not.toContain('requestId');
    expect(noRequestId.prevHash).toBe(event.prevHash);
  });
});
