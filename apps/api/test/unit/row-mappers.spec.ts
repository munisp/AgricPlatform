import { describe, expect, it } from 'vitest';
import type { MarketplaceListing, Profile } from '@agric-platform/shared';
import {
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
});
