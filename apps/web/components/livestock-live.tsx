'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ANIMAL_SEXES,
  ANIMAL_STATUSES,
  LIVESTOCK_BREEDS,
  LIVESTOCK_SPECIES,
  NIGERIAN_STATES
} from '@agric-platform/shared';
import type {
  Animal,
  AnimalSex,
  AnimalStatus,
  LivestockLot,
  LivestockSpecies
} from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  createLot,
  enrolLivestock,
  fetchLot,
  listMyAnimals,
  listMyLots,
  fetchMyPastoralistProfile,
  registerAnimal,
  setLotAnimals,
  upsertPastoralistProfile
} from '@/lib/api/endpoints';
import type { LotWithAnimals } from '@/lib/api/endpoints';
import { demoAnimals, demoLotDetail, demoLots, demoPastoralistProfile } from '@/lib/content';
import { CheckRow, Field, Select, TextArea, TextInput } from '@/components/forms';
import { AutoBadge, Card, StatusBadge } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/livestock/*.
const FALLBACK_ANIMALS = demoAnimals;
const FALLBACK_LOTS = demoLots;
const FALLBACK_PROFILE = demoPastoralistProfile;

/* ------------------------------ enrolment ------------------------------ */

/** Livestock-domain enrolment (farmer role marker + livestock_records consent). */
export function LivestockEnrolCard() {
  const { userId, hydrated } = useAppState();
  const enrol = useApiMutation<void, unknown>({
    mutationFn: () => enrolLivestock(userId).then((res) => res.data),
    queue: {
      kind: 'livestock.enrol',
      label: () => 'Livestock enrolment',
      method: 'POST',
      path: () => '/livestock/enrol',
      payload: () => ({ userId })
    }
  });

  return (
    <Card title="Livestock enrolment">
      <p className="small muted">
        Enrolling binds your farmer marker and records your livestock records consent — required
        before you can certify animals for trade.
      </p>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        {enrol.status === 'success' ? <StatusBadge tone="success">enrolled</StatusBadge> : null}
        {enrol.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!hydrated || enrol.status === 'pending' || enrol.status === 'success'}
          onClick={() => void enrol.mutate()}
        >
          {enrol.status === 'pending' ? 'Enrolling…' : 'Enrol in livestock'}
        </button>
      </div>
      {enrol.status === 'error' ? <ApiErrorNotice error={enrol.error} /> : null}
    </Card>
  );
}

/* ------------------------------ my animals ----------------------------- */

export function MyAnimals({ refreshKey = 0 }: { refreshKey?: number }) {
  const { hydrated } = useAppState();
  const [species, setSpecies] = useState<'' | LivestockSpecies>('');
  const [status, setStatus] = useState<'' | AnimalStatus>('');
  const [state, setState] = useState('');

  const query = useApiQuery(
    hydrated ? `livestock:animals:mine:${species}:${status}:${state}:${refreshKey}` : null,
    () =>
      listMyAnimals({
        species: species || undefined,
        status: status || undefined,
        state: state || undefined
      }).then((res) => res.data),
    { fallbackData: FALLBACK_ANIMALS, enabled: hydrated }
  );

  // Client-side filter keeps the offline fixture consistent with the filters.
  const animals = (query.data ?? []).filter(
    (animal) =>
      (!species || animal.species === species) &&
      (!status || animal.status === status) &&
      (!state || animal.state === state)
  );

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <fieldset className="filter-bar">
        <legend className="sr-only">Filter animals</legend>
        <Field id="animal-filter-species" label="Species">
          <Select
            id="animal-filter-species"
            value={species}
            onChange={(event) => setSpecies(event.target.value as '' | LivestockSpecies)}
          >
            <option value="">All species</option>
            {LIVESTOCK_SPECIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="animal-filter-status" label="Status">
          <Select
            id="animal-filter-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as '' | AnimalStatus)}
          >
            <option value="">All statuses</option>
            {ANIMAL_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="animal-filter-state" label="State">
          <Select
            id="animal-filter-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="">All states</option>
            {NIGERIAN_STATES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={animals}
        onRetry={query.refresh}
        empty={<p className="small muted">No animals match these filters — register one below.</p>}
      >
        <div className="grid grid-3">
          {animals.map((animal) => (
            <Card key={animal.id} title={animal.id}>
              <p className="small muted">
                {animal.breed} {animal.species} · {animal.sex} · {animal.state}
                {animal.lga ? `, ${animal.lga}` : ''}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <AutoBadge value={animal.status} />
                <Link className="btn btn-ghost btn-small" href={`/livestock/animals/${animal.id}`}>
                  View animal
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}

/* --------------------------- register an animal ------------------------ */

export function RegisterAnimalForm({ onRegistered }: { onRegistered?: () => void }) {
  const { hydrated } = useAppState();
  const [species, setSpecies] = useState<LivestockSpecies>('cattle');
  const [breed, setBreed] = useState<string>(LIVESTOCK_BREEDS.cattle[0]);
  const [sex, setSex] = useState<AnimalSex>('female');
  const [birthDate, setBirthDate] = useState('');
  const [tagId, setTagId] = useState('');
  const [eid, setEid] = useState('');
  const [state, setState] = useState('');
  const [lga, setLga] = useState('');
  const [sireId, setSireId] = useState('');
  const [damId, setDamId] = useState('');
  const [notes, setNotes] = useState('');
  const [issuedId, setIssuedId] = useState<string | null>(null);

  // Species → breed cascading from the shared registry constants.
  const breeds = LIVESTOCK_BREEDS[species];
  const onSpeciesChange = (next: LivestockSpecies) => {
    setSpecies(next);
    setBreed(LIVESTOCK_BREEDS[next][0]);
  };

  const valid = breed.trim().length > 0 && state.length > 0;

  const register = useApiMutation<void, Animal>({
    mutationFn: () =>
      registerAnimal({
        species,
        breed,
        sex,
        birthDate: birthDate || undefined,
        tagId: tagId.trim() || undefined,
        eid: eid.trim() || undefined,
        state,
        lga: lga.trim() || undefined,
        sireId: sireId.trim() || undefined,
        damId: damId.trim() || undefined,
        notes: notes.trim() || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.animal.registered',
      label: () => `Register ${breed} ${species}`,
      method: 'POST',
      path: () => '/livestock/animals',
      payload: () => ({ species, breed, sex, state, lga: lga.trim() || undefined })
    },
    onSuccess: (animal) => {
      setIssuedId(animal.id);
      onRegistered?.();
    }
  });

  return (
    <Card title="Register an animal">
      <p className="small muted">
        A national ID (NG-SPECIES-STATE-serial) is issued on registration. Tag and EID are optional
        but recommended for market access.
      </p>
      <div className="form-grid cols-2">
        <Field id="reg-species" label="Species">
          <Select
            id="reg-species"
            value={species}
            onChange={(event) => onSpeciesChange(event.target.value as LivestockSpecies)}
          >
            {LIVESTOCK_SPECIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="reg-breed" label="Breed" hint="Breeds follow the selected species.">
          <Select
            id="reg-breed"
            value={breed}
            onChange={(event) => setBreed(event.target.value)}
          >
            {breeds.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="reg-sex" label="Sex">
          <Select id="reg-sex" value={sex} onChange={(event) => setSex(event.target.value as AnimalSex)}>
            {ANIMAL_SEXES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="reg-birthdate" label="Birth date (optional)">
          <TextInput
            id="reg-birthdate"
            type="date"
            value={birthDate}
            onChange={(event) => setBirthDate(event.target.value)}
          />
        </Field>
        <Field id="reg-state" label="State">
          <Select id="reg-state" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">Select state…</option>
            {NIGERIAN_STATES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="reg-lga" label="LGA (optional)">
          <TextInput
            id="reg-lga"
            value={lga}
            onChange={(event) => setLga(event.target.value)}
            placeholder="e.g. Zaria"
          />
        </Field>
        <Field id="reg-tag" label="Ear tag (optional)">
          <TextInput
            id="reg-tag"
            value={tagId}
            onChange={(event) => setTagId(event.target.value)}
            placeholder="e.g. TAG-KD-0412"
          />
        </Field>
        <Field id="reg-eid" label="EID / RFID (optional)">
          <TextInput
            id="reg-eid"
            value={eid}
            onChange={(event) => setEid(event.target.value)}
            placeholder="e.g. RFID-982-000123"
          />
        </Field>
        <Field id="reg-sire" label="Sire ID (optional)">
          <TextInput
            id="reg-sire"
            value={sireId}
            onChange={(event) => setSireId(event.target.value)}
            placeholder="e.g. NG-BOV-KD-000011"
          />
        </Field>
        <Field id="reg-dam" label="Dam ID (optional)">
          <TextInput
            id="reg-dam"
            value={damId}
            onChange={(event) => setDamId(event.target.value)}
            placeholder="e.g. NG-BOV-KD-000087"
          />
        </Field>
      </div>
      <Field id="reg-notes" label="Notes (optional)">
        <TextArea id="reg-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        {register.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!hydrated || !valid || register.status === 'pending'}
          onClick={() => void register.mutate()}
        >
          {register.status === 'pending' ? 'Registering…' : 'Save animal'}
        </button>
      </div>
      {issuedId ? (
        <p className="notice notice-info" role="status">
          Animal registered with national ID <strong>{issuedId}</strong>.
        </p>
      ) : null}
      {register.status === 'error' ? <ApiErrorNotice error={register.error} /> : null}
    </Card>
  );
}

/* --------------------------------- lots -------------------------------- */

function LotMembers({ lot }: { lot: LivestockLot }) {
  const [animalId, setAnimalId] = useState('');
  const detail = useApiQuery(
    `livestock:lot:${lot.id}`,
    () => fetchLot(lot.id).then((res) => res.data),
    // Offline fallback only — live detail from GET /api/v1/livestock/lots/:id.
    { fallbackData: lot.id === demoLotDetail.id ? demoLotDetail : { ...lot, animalIds: [] } }
  );
  const members = detail.data?.animalIds ?? [];

  const update = useApiMutation<{ add?: string[]; remove?: string[] }, LotWithAnimals>({
    mutationFn: (input) => setLotAnimals(lot.id, input).then((res) => res.data),
    onSuccess: () => {
      setAnimalId('');
      detail.refresh();
    }
  });

  return (
    <div>
      <p className="small muted">
        {members.length} registered member{members.length === 1 ? '' : 's'}
        {detail.source === 'fallback' ? ' (offline reference)' : ''}
      </p>
      {members.length > 0 ? (
        <ul className="row-list">
          {members.map((member) => (
            <li className="row-item" key={member}>
              <div className="row-main small">{member}</div>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={update.status === 'pending'}
                onClick={() => void update.mutate({ remove: [member] })}
                aria-label={`Remove ${member} from ${lot.id}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cluster" style={{ marginTop: '0.5rem' }}>
        <Field id={`lot-add-${lot.id}`} label={`Add animal to ${lot.id}`}>
          <TextInput
            id={`lot-add-${lot.id}`}
            value={animalId}
            onChange={(event) => setAnimalId(event.target.value)}
            placeholder="NG-CAP-KD-000045"
          />
        </Field>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={animalId.trim().length < 4 || update.status === 'pending'}
          onClick={() => void update.mutate({ add: [animalId.trim()] })}
        >
          Add animal
        </button>
      </div>
      {update.status === 'error' ? <ApiErrorNotice error={update.error} /> : null}
    </div>
  );
}

export function LotsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const { hydrated } = useAppState();
  const [species, setSpecies] = useState<LivestockSpecies>('chicken');
  const [quantity, setQuantity] = useState('');
  const [state, setState] = useState('');
  const [lga, setLga] = useState('');
  const [formationRule, setFormationRule] = useState('');
  const [managingId, setManagingId] = useState<string | null>(null);

  const query = useApiQuery(
    hydrated ? `livestock:lots:mine:${refreshKey}` : null,
    () => listMyLots().then((res) => res.data),
    { fallbackData: FALLBACK_LOTS, enabled: hydrated }
  );

  const quantityNumber = Number(quantity);
  const valid = Number.isInteger(quantityNumber) && quantityNumber >= 1 && state.length > 0;

  const create = useApiMutation<void, LivestockLot>({
    mutationFn: () =>
      createLot({
        species,
        quantity: quantityNumber,
        state,
        lga: lga.trim() || undefined,
        formationRule: formationRule.trim() || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.lot.created',
      label: () => `Create ${species} lot`,
      method: 'POST',
      path: () => '/livestock/lots',
      payload: () => ({ species, quantity: quantityNumber, state })
    },
    onSuccess: () => {
      setQuantity('');
      setFormationRule('');
      query.refresh();
    }
  });

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={<p className="small muted">No lots yet — create one below for flocks and pens.</p>}
      >
        <div className="grid grid-2">
          {(query.data ?? []).map((lot) => (
            <Card key={lot.id} title={lot.id}>
              <p className="small muted">
                {lot.quantity} {lot.species} · {lot.state}
                {lot.lga ? `, ${lot.lga}` : ''}
                {lot.formationRule ? ` · ${lot.formationRule}` : ''}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <AutoBadge value={lot.status} />
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  aria-expanded={managingId === lot.id}
                  onClick={() => setManagingId(managingId === lot.id ? null : lot.id)}
                >
                  {managingId === lot.id ? 'Close members' : 'Manage members'}
                </button>
              </div>
              {managingId === lot.id ? <LotMembers lot={lot} /> : null}
            </Card>
          ))}
        </div>
      </QueryState>

      <Card title="Create a lot" className="mt-card">
        <div className="form-grid cols-2">
          <Field id="lot-species" label="Species">
            <Select
              id="lot-species"
              value={species}
              onChange={(event) => setSpecies(event.target.value as LivestockSpecies)}
            >
              {LIVESTOCK_SPECIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lot-quantity" label="Quantity">
            <TextInput
              id="lot-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="e.g. 120"
            />
          </Field>
          <Field id="lot-state" label="State">
            <Select id="lot-state" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="lot-lga" label="LGA (optional)">
            <TextInput
              id="lot-lga"
              value={lga}
              onChange={(event) => setLga(event.target.value)}
            />
          </Field>
        </div>
        <Field id="lot-rule" label="Formation rule (optional)">
          <TextInput
            id="lot-rule"
            value={formationRule}
            onChange={(event) => setFormationRule(event.target.value)}
            placeholder="e.g. Broiler cycle 2026-Q3, same hatch date"
          />
        </Field>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {create.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hydrated || !valid || create.status === 'pending'}
            onClick={() => void create.mutate()}
          >
            {create.status === 'pending' ? 'Creating…' : 'Save lot'}
          </button>
        </div>
        {create.status === 'error' ? <ApiErrorNotice error={create.error} /> : null}
      </Card>
    </>
  );
}

/* ------------------------- pastoralist profile ------------------------- */

export function PastoralistProfileForm() {
  const { hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? 'livestock:pastoralist-profile:mine' : null,
    () => fetchMyPastoralistProfile().then((res) => res.data),
    { fallbackData: FALLBACK_PROFILE, enabled: hydrated }
  );

  const [grazingZoneId, setGrazingZoneId] = useState<string | null>(null);
  const [migrationPattern, setMigrationPattern] = useState<string | null>(null);
  const [primarySpecies, setPrimarySpecies] = useState<LivestockSpecies[] | null>(null);

  const currentGrazing = grazingZoneId ?? query.data?.grazingZoneId ?? '';
  const currentMigration = migrationPattern ?? query.data?.migrationPattern ?? '';
  const currentSpecies = primarySpecies ?? query.data?.primarySpecies ?? [];

  const save = useApiMutation<void, unknown>({
    mutationFn: () =>
      upsertPastoralistProfile({
        grazingZoneId: currentGrazing.trim() || undefined,
        migrationPattern: currentMigration.trim() || undefined,
        primarySpecies: currentSpecies
      }).then((res) => res.data),
    queue: {
      kind: 'livestock.pastoralist-profile.saved',
      label: () => 'Save pastoralist profile',
      method: 'PUT',
      path: () => '/livestock/pastoralist-profile',
      payload: () => ({
        grazingZoneId: currentGrazing.trim() || undefined,
        migrationPattern: currentMigration.trim() || undefined,
        primarySpecies: currentSpecies
      })
    },
    onSuccess: () => query.refresh()
  });

  const toggleSpecies = (option: LivestockSpecies, checked: boolean) => {
    const next = checked
      ? [...currentSpecies, option]
      : currentSpecies.filter((item) => item !== option);
    setPrimarySpecies(next);
  };

  return (
    <Card title="Grazing profile">
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <div className="form-grid cols-2">
        <Field id="pp-zone" label="Grazing zone (optional)">
          <TextInput
            id="pp-zone"
            value={currentGrazing}
            onChange={(event) => setGrazingZoneId(event.target.value)}
            placeholder="e.g. GZ-NORTH-KADUNA-04"
          />
        </Field>
        <Field id="pp-migration" label="Migration pattern (optional)">
          <TextInput
            id="pp-migration"
            value={currentMigration}
            onChange={(event) => setMigrationPattern(event.target.value)}
            placeholder="Dry-season route and wet-season return"
          />
        </Field>
      </div>
      <fieldset className="filter-bar" style={{ marginTop: '0.5rem' }}>
        <legend className="small" style={{ fontWeight: 600 }}>
          Primary species
        </legend>
        {LIVESTOCK_SPECIES.map((option) => (
          <CheckRow
            key={option}
            id={`pp-species-${option}`}
            checked={currentSpecies.includes(option)}
            onChange={(checked) => toggleSpecies(option, checked)}
            label={option}
          />
        ))}
      </fieldset>
      <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
        {save.status === 'success' ? <StatusBadge tone="success">saved</StatusBadge> : null}
        {save.status === 'queued' ? <StatusBadge tone="warning">queued</StatusBadge> : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!hydrated || currentSpecies.length === 0 || save.status === 'pending'}
          onClick={() => void save.mutate()}
        >
          {save.status === 'pending' ? 'Saving…' : 'Save profile'}
        </button>
      </div>
      {save.status === 'error' ? <ApiErrorNotice error={save.error} /> : null}
    </Card>
  );
}

/* --------------------------------- hub --------------------------------- */

import { T } from '@/lib/i18n';
import { Section } from '@/components/ui';

/**
 * /livestock hub — registry surfaces for the farmer/pastoralist persona.
 * Holds the refresh key shared by the register form and the animals list.
 */
export function LivestockHub() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <Section kicker={<T k="livestock.animalsKicker" />} title={<T k="livestock.animalsTitle" />}>
        <MyAnimals refreshKey={refreshKey} />
      </Section>

      <Section kicker={<T k="livestock.registerKicker" />} title={<T k="livestock.registerTitle" />}>
        <div className="grid grid-2">
          <RegisterAnimalForm onRegistered={() => setRefreshKey((key) => key + 1)} />
          <LivestockEnrolCard />
        </div>
      </Section>

      <Section kicker={<T k="livestock.lotsKicker" />} title={<T k="livestock.lotsTitle" />}>
        <LotsPanel />
      </Section>

      <Section kicker={<T k="livestock.profileKicker" />} title={<T k="livestock.profileTitle" />}>
        <PastoralistProfileForm />
      </Section>
    </>
  );
}
