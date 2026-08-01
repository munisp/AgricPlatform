'use client';

import { useState } from 'react';
import { NIGERIAN_STATES, VALUE_CHAINS, formatNaira } from '@agric-platform/shared';
import type { MarketplaceListing } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { Field, QueuedNotice, Select, TextInput } from '@/components/forms';
import { AutoBadge } from '@/components/ui';

const KINDS = ['produce', 'input', 'service', 'equipment', 'storage', 'transport'] as const;

interface ListingDraft {
  kind: string;
  title: string;
  crop: string;
  quantity: string;
  unit: string;
  priceNaira: string;
  state: string;
  lga: string;
}

const EMPTY: ListingDraft = {
  kind: 'produce',
  title: '',
  crop: '',
  quantity: '',
  unit: 'tonne',
  priceNaira: '',
  state: '',
  lga: ''
};

export function ListingForm() {
  const { enqueue } = useAppState();
  const [draft, setDraft] = useState<ListingDraft>(EMPTY);
  const [myListings, setMyListings] = usePersistentState<MarketplaceListing[]>('agric.my-listings', []);
  const [notice, setNotice] = useState<string | null>(null);

  const patch = (partial: Partial<ListingDraft>) => setDraft((current) => ({ ...current, ...partial }));

  const valid =
    draft.title.trim().length >= 6 &&
    Number(draft.quantity) > 0 &&
    Number(draft.priceNaira) > 0 &&
    draft.state !== '';

  const submit = () => {
    if (!valid) return;
    const listing: MarketplaceListing = {
      id: `listing-local-${Date.now()}`,
      sellerId: 'local-user',
      kind: draft.kind as MarketplaceListing['kind'],
      title: draft.title.trim(),
      crop: draft.crop || undefined,
      quantity: Number(draft.quantity),
      unit: draft.unit.trim() || 'unit',
      priceNaira: Number(draft.priceNaira),
      location: { state: draft.state, lga: draft.lga.trim() || draft.state },
      isActive: true
    };
    setMyListings((current) => [listing, ...current]);
    enqueue('marketplace.listing.created', `Listing: ${listing.title}`);
    setNotice(listing.title);
    setDraft(EMPTY);
  };

  return (
    <div className="stack-lg">
      <div className="card">
        <h3>Create a listing</h3>
        <p className="small muted">
          Listings are saved offline first and published when the marketplace service is reachable.
        </p>
        <div className="form-grid cols-2">
          <Field id="lf-kind" label="Listing kind">
            <Select id="lf-kind" value={draft.kind} onChange={(e) => patch({ kind: e.target.value })}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-crop" label="Crop (optional)">
            <Select id="lf-crop" value={draft.crop} onChange={(e) => patch({ crop: e.target.value })}>
              <option value="">Not crop-specific</option>
              {VALUE_CHAINS.map((chain) => (
                <option key={chain} value={chain}>
                  {chain}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-title" label="Title" hint="At least 6 characters.">
            <TextInput
              id="lf-title"
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Fresh cassava tubers — 5 tonnes"
            />
          </Field>
          <Field id="lf-price" label="Total price (₦)">
            <TextInput
              id="lf-price"
              value={draft.priceNaira}
              onChange={(e) => patch({ priceNaira: e.target.value.replace(/[^0-9]/g, '') })}
              inputMode="numeric"
              placeholder="185000"
            />
          </Field>
          <Field id="lf-qty" label="Quantity">
            <TextInput
              id="lf-qty"
              value={draft.quantity}
              onChange={(e) => patch({ quantity: e.target.value.replace(/[^0-9.]/g, '') })}
              inputMode="decimal"
              placeholder="5"
            />
          </Field>
          <Field id="lf-unit" label="Unit">
            <TextInput
              id="lf-unit"
              value={draft.unit}
              onChange={(e) => patch({ unit: e.target.value })}
              placeholder="tonne / bag / hectare slot"
            />
          </Field>
          <Field id="lf-state" label="State">
            <Select id="lf-state" value={draft.state} onChange={(e) => patch({ state: e.target.value })}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-lga" label="LGA">
            <TextInput
              id="lf-lga"
              value={draft.lga}
              onChange={(e) => patch({ lga: e.target.value })}
              placeholder="e.g. Zaria"
            />
          </Field>
        </div>
        <div className="cluster" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={submit}>
            Save listing
          </button>
        </div>
      </div>

      {notice ? <QueuedNotice label={`"${notice}"`} /> : null}

      {myListings.length > 0 ? (
        <section aria-label="My offline listings">
          <h3>My listings on this device</h3>
          <ul className="row-list">
            {myListings.map((listing) => (
              <li className="row-item" key={listing.id}>
                <div className="row-main">
                  <div className="row-title">{listing.title}</div>
                  <div className="small muted">
                    {listing.quantity} {listing.unit} · {listing.location.state}
                    {listing.location.lga ? `, ${listing.location.lga}` : ''}
                  </div>
                </div>
                <span style={{ fontWeight: 700 }}>{formatNaira(listing.priceNaira)}</span>
                <AutoBadge value={listing.kind} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
