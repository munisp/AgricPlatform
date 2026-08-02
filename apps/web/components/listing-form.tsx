'use client';

import { useState } from 'react';
import { NIGERIAN_STATES, VALUE_CHAINS, formatNaira } from '@agric-platform/shared';
import type { MarketplaceListing } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation } from '@/lib/api/hooks';
import { createListing } from '@/lib/api/endpoints';
import { usePersistentState } from '@/lib/use-persistent-state';
import { useFormDraft } from '@/lib/drafts';
import { useT } from '@/lib/i18n';
import { DraftRestoredNotice, Field, QueuedNotice, Select, TextInput } from '@/components/forms';
import { ApiErrorNotice } from '@/components/api-state';
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

/** The draft counts as real content once title, price or quantity is typed. */
function isEmptyDraft(draft: ListingDraft): boolean {
  return draft.title.trim() === '' && draft.priceNaira === '' && draft.quantity === '';
}

export function ListingForm() {
  const { t } = useT();
  const { userId } = useAppState();
  // IndexedDB draft persistence (Appendix F Phase-1): autosave on keystroke,
  // restore on reload, clear on successful submit.
  const { draft, setDraft, restored, clearDraft } = useFormDraft<ListingDraft>(
    'listing-create',
    EMPTY,
    isEmptyDraft
  );
  const [myListings, setMyListings] = usePersistentState<MarketplaceListing[]>('agric.my-listings', []);
  const [notice, setNotice] = useState<{ title: string; queued: boolean } | null>(null);

  const patch = (partial: Partial<ListingDraft>) => setDraft((current) => ({ ...current, ...partial }));

  const valid =
    draft.title.trim().length >= 6 &&
    Number(draft.quantity) > 0 &&
    Number(draft.priceNaira) > 0 &&
    draft.state !== '';

  const listingPayload = () => ({
    sellerId: userId,
    kind: draft.kind as MarketplaceListing['kind'],
    title: draft.title.trim(),
    crop: draft.crop || undefined,
    quantity: Number(draft.quantity),
    unit: draft.unit.trim() || 'unit',
    priceNaira: Number(draft.priceNaira),
    location: { state: draft.state, lga: draft.lga.trim() || draft.state }
  });

  type ListingPayload = ReturnType<typeof listingPayload>;

  const mutation = useApiMutation<ListingPayload, unknown>({
    mutationFn: (payload) => createListing(payload).then((res) => res.data),
    queue: {
      kind: 'marketplace.listing.created',
      label: (payload) => `Listing: ${payload.title}`,
      method: 'POST',
      path: () => '/listings',
      payload: (payload) => payload
    },
    onSuccess: (result, payload) => {
      setNotice({ title: payload.title, queued: false });
      clearDraft();
    },
    onQueued: (payload) => {
      // Keep a device-local copy of offline-created listings.
      const listing: MarketplaceListing = {
        id: `listing-local-${Date.now()}`,
        isActive: true,
        ...payload
      };
      setMyListings((current) => [listing, ...current]);
      setNotice({ title: listing.title, queued: true });
      // Queued submissions hold the full payload in the sync queue, so the
      // form draft can be cleared safely.
      clearDraft();
    }
  });

  const submit = () => {
    if (!valid) return;
    // Keep the draft while saving; it is cleared on success/queued and kept
    // on failure so nothing typed is lost.
    void mutation.mutate(listingPayload());
  };

  return (
    <div className="stack-lg">
      <div className="card">
        <h3>{t('marketplace.formTitle')}</h3>
        <p className="small muted">
          {t('marketplace.formIntro')}
        </p>
        {restored ? <DraftRestoredNotice onDismiss={clearDraft} /> : null}
        <div className="form-grid cols-2">
          <Field id="lf-kind" label={t('marketplace.kindLabel')}>
            <Select id="lf-kind" value={draft.kind} onChange={(e) => patch({ kind: e.target.value })}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-crop" label={t('marketplace.cropLabel')}>
            <Select id="lf-crop" value={draft.crop} onChange={(e) => patch({ crop: e.target.value })}>
              <option value="">{t('marketplace.notCropSpecific')}</option>
              {VALUE_CHAINS.map((chain) => (
                <option key={chain} value={chain}>
                  {chain}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-title" label={t('marketplace.titleLabel')} hint={t('marketplace.titleHint')}>
            <TextInput
              id="lf-title"
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Fresh cassava tubers — 5 tonnes"
            />
          </Field>
          <Field id="lf-price" label={t('marketplace.priceLabel')}>
            <TextInput
              id="lf-price"
              value={draft.priceNaira}
              onChange={(e) => patch({ priceNaira: e.target.value.replace(/[^0-9]/g, '') })}
              inputMode="numeric"
              placeholder="185000"
            />
          </Field>
          <Field id="lf-qty" label={t('marketplace.quantityLabel')}>
            <TextInput
              id="lf-qty"
              value={draft.quantity}
              onChange={(e) => patch({ quantity: e.target.value.replace(/[^0-9.]/g, '') })}
              inputMode="decimal"
              placeholder="5"
            />
          </Field>
          <Field id="lf-unit" label={t('marketplace.unitLabel')}>
            <TextInput
              id="lf-unit"
              value={draft.unit}
              onChange={(e) => patch({ unit: e.target.value })}
              placeholder="tonne / bag / hectare slot"
            />
          </Field>
          <Field id="lf-state" label={t('marketplace.stateLabel')}>
            <Select id="lf-state" value={draft.state} onChange={(e) => patch({ state: e.target.value })}>
              <option value="">{t('marketplace.selectState')}</option>
              {NIGERIAN_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lf-lga" label={t('marketplace.lgaLabel')}>
            <TextInput
              id="lf-lga"
              value={draft.lga}
              onChange={(e) => patch({ lga: e.target.value })}
              placeholder="e.g. Zaria"
            />
          </Field>
        </div>
        <div className="cluster" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || mutation.status === 'pending'}
            onClick={submit}
          >
            {mutation.status === 'pending' ? t('marketplace.saving') : t('marketplace.saveListing')}
          </button>
        </div>
      </div>

      {notice?.queued ? <QueuedNotice label={`"${notice.title}"`} /> : null}
      {notice && !notice.queued ? (
        <div className="notice notice-success" role="status">
          <strong>Listing published.</strong> &quot;{notice.title}&quot; is live on the marketplace.
        </div>
      ) : null}
      {mutation.status === 'error' ? <ApiErrorNotice error={mutation.error} /> : null}

      {myListings.length > 0 ? (
        <section aria-label={t('marketplace.myListingsAria')}>
          <h3>{t('marketplace.myListings')}</h3>
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
