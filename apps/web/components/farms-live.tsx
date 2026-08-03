'use client';

import { useState } from 'react';
import {
  FARM_EXPENSE_CATEGORIES,
  HARVEST_QUALITY_GRADES,
  HARVEST_UNITS,
  isValidBoundaryGeojson,
  NIGERIAN_STATES,
  SOIL_TYPES
} from '@agric-platform/shared';
import type {
  CropPlanting,
  FarmExpense,
  FarmPlot,
  FarmSummary,
  HarvestRecord,
  PlantingStatus
} from '@agric-platform/shared';
import { useT } from '@/lib/i18n';
import { invalidateApiQueries, useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  createCropPlanting,
  createFarmExpense,
  createFarmPlot,
  fetchFarmSummary,
  listCropPlantings,
  listFarmExpenses,
  listFarmPlots,
  listHarvestRecords,
  recordHarvest,
  transitionCropPlanting,
  updateFarmPlot
} from '@/lib/api/endpoints';
import {
  demoCropPlantings,
  demoFarmExpenses,
  demoFarmPlots,
  demoFarmSummary,
  demoHarvestRecords
} from '@/lib/content';
import { Field, Select, TextArea, TextInput } from '@/components/forms';
import { AutoBadge, Card, EmptyState, Section } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';

/* ------------------------------ summary -------------------------------- */

/** Per-owner aggregate cards (GET /farms/summary). */
export function FarmSummaryCards() {
  const { t } = useT();
  const query = useApiQuery<FarmSummary>(
    'farms.summary',
    () => fetchFarmSummary().then((res) => res.data),
    { fallbackData: demoFarmSummary }
  );
  const summary = query.data;
  if (!summary) {
    return query.error ? <ApiErrorNotice error={query.error} onRetry={query.refresh} /> : null;
  }
  return (
    <Section kicker={t('farms.summaryKicker')} title={t('farms.summaryTitle')}>
      {query.source === 'fallback' ? (
        <OfflineDataNotice>{t('farms.offlineNotice')}</OfflineDataNotice>
      ) : null}
      <div className="card-grid">
        <Card>
          <strong>{summary.plotCount}</strong>
          <p className="small muted">{t('farms.summaryPlots')}</p>
        </Card>
        <Card>
          <strong>{summary.totalHectares}</strong>
          <p className="small muted">{t('farms.summaryHectares')}</p>
        </Card>
        <Card>
          <strong>{summary.activePlantings}</strong>
          <p className="small muted">{t('farms.summaryActivePlantings')}</p>
        </Card>
        <Card>
          <strong>₦{(summary.totalExpensesKobo / 100).toLocaleString('en-NG')}</strong>
          <p className="small muted">{t('farms.summaryExpenses')}</p>
        </Card>
      </div>
      {summary.harvestByCrop.length > 0 ? (
        <Card>
          <h3>{t('farms.summaryHarvest')}</h3>
          <ul>
            {summary.harvestByCrop.map((row) => (
              <li key={row.crop}>
                {row.crop}: {row.totalQuantity} ({row.harvestCount})
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}

/* ------------------------------ plot form ------------------------------ */

interface PlotFormState {
  name: string;
  state: string;
  lga: string;
  centroidLat: string;
  centroidLong: string;
  sizeHectares: string;
  soilType: string;
  boundary: string;
}

function emptyPlotForm(): PlotFormState {
  return {
    name: '',
    state: 'Kaduna',
    lga: '',
    centroidLat: '',
    centroidLong: '',
    sizeHectares: '',
    soilType: '',
    boundary: ''
  };
}

function plotFormFrom(plot: FarmPlot): PlotFormState {
  return {
    name: plot.name,
    state: plot.state,
    lga: plot.lga,
    centroidLat: String(plot.centroidLat),
    centroidLong: String(plot.centroidLong),
    sizeHectares: String(plot.sizeHectares),
    soilType: plot.soilType ?? '',
    boundary: plot.boundaryGeojson ? JSON.stringify(plot.boundaryGeojson) : ''
  };
}

/** Create/edit plot form with GeoJSON boundary validation. */
export function PlotForm({
  plot,
  onSaved,
  onCancel
}: {
  plot?: FarmPlot;
  onSaved: (saved: FarmPlot) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [form, setForm] = useState<PlotFormState>(plot ? plotFormFrom(plot) : emptyPlotForm());
  const [boundaryError, setBoundaryError] = useState<string | null>(null);

  const save = useApiMutation<PlotFormState, FarmPlot>({
    mutationFn: async (input) => {
      const body = {
        name: input.name.trim(),
        state: input.state,
        lga: input.lga.trim(),
        centroidLat: Number(input.centroidLat),
        centroidLong: Number(input.centroidLong),
        sizeHectares: Number(input.sizeHectares),
        soilType: (input.soilType || undefined) as FarmPlot['soilType'],
        boundaryGeojson: input.boundary.trim()
          ? (JSON.parse(input.boundary) as unknown)
          : undefined
      };
      const res = plot
        ? await updateFarmPlot(plot.id, body)
        : await createFarmPlot(body);
      return res.data;
    },
    queue: {
      kind: plot ? 'farms.plot.updated' : 'farms.plot.created',
      label: (input) => `${plot ? 'Update' : 'Register'} plot ${input.name}`,
      method: plot ? 'PATCH' : 'POST',
      path: () => (plot ? `/farms/plots/${plot.id}` : '/farms/plots'),
      payload: (input) => ({
        name: input.name.trim(),
        state: input.state,
        lga: input.lga.trim(),
        centroidLat: Number(input.centroidLat),
        centroidLong: Number(input.centroidLong),
        sizeHectares: Number(input.sizeHectares)
      })
    },
    onSuccess: (saved) => {
      invalidateApiQueries('farms.plots', 'farms.summary');
      onSaved(saved);
    },
    onQueued: () => {
      invalidateApiQueries('farms.plots', 'farms.summary');
      onCancel();
    }
  });

  function set<K extends keyof PlotFormState>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function validateBoundary(raw: string): boolean {
    if (!raw.trim()) {
      setBoundaryError(null);
      return true;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidBoundaryGeojson(parsed)) {
        setBoundaryError(t('farms.boundaryInvalid'));
        return false;
      }
      setBoundaryError(null);
      return true;
    } catch {
      setBoundaryError(t('farms.boundaryInvalid'));
      return false;
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!validateBoundary(form.boundary)) return;
    await save.mutate(form);
  }

  return (
    <Card>
      <h3>{plot ? t('farms.editPlot') : t('farms.createPlot')}</h3>
      <form onSubmit={submit}>
        <Field id="plot-name" label={t('farms.nameLabel')}>
          <TextInput
            id="plot-name"
            required
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
          />
        </Field>
        <Field id="plot-state" label={t('farms.stateLabel')}>
          <Select
            id="plot-state"
            value={form.state}
            onChange={(event) => set('state', event.target.value)}
          >
            {NIGERIAN_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="plot-lga" label={t('farms.lgaLabel')}>
          <TextInput
            id="plot-lga"
            required
            value={form.lga}
            onChange={(event) => set('lga', event.target.value)}
          />
        </Field>
        <Field id="plot-lat" label={t('farms.centroidLatLabel')}>
          <TextInput
            id="plot-lat"
            required
            type="number"
            step="any"
            min={-90}
            max={90}
            value={form.centroidLat}
            onChange={(event) => set('centroidLat', event.target.value)}
          />
        </Field>
        <Field id="plot-long" label={t('farms.centroidLongLabel')}>
          <TextInput
            id="plot-long"
            required
            type="number"
            step="any"
            min={-180}
            max={180}
            value={form.centroidLong}
            onChange={(event) => set('centroidLong', event.target.value)}
          />
        </Field>
        <Field id="plot-size" label={t('farms.sizeLabel')}>
          <TextInput
            id="plot-size"
            required
            type="number"
            step="any"
            min={0.01}
            value={form.sizeHectares}
            onChange={(event) => set('sizeHectares', event.target.value)}
          />
        </Field>
        <Field id="plot-soil" label={t('farms.soilLabel')}>
          <Select
            id="plot-soil"
            value={form.soilType}
            onChange={(event) => set('soilType', event.target.value)}
          >
            <option value="">{t('farms.soilNone')}</option>
            {SOIL_TYPES.map((soil) => (
              <option key={soil} value={soil}>
                {soil}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="plot-boundary" label={t('farms.boundaryLabel')} hint={t('farms.boundaryHint')}>
          <TextArea
            id="plot-boundary"
            rows={3}
            value={form.boundary}
            onChange={(event) => set('boundary', event.target.value)}
            onBlur={() => validateBoundary(form.boundary)}
          />
        </Field>
        {boundaryError ? (
          <p className="notice notice-critical" role="alert">
            {boundaryError}
          </p>
        ) : null}
        {save.status === 'error' ? <ApiErrorNotice error={save.error} /> : null}
        {save.status === 'success' ? <p role="status">{t('farms.savedPlot')}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={save.status === 'pending'}>
          {save.status === 'pending' ? t('farms.saving') : t('farms.savePlot')}
        </button>{' '}
        <button className="btn btn-ghost" type="button" onClick={onCancel}>
          {t('farms.closeForm')}
        </button>
      </form>
    </Card>
  );
}

/* ---------------------------- planting form ---------------------------- */

function PlantingForm({ plotId, onSaved }: { plotId: string; onSaved: () => void }) {
  const { t } = useT();
  const [crop, setCrop] = useState('');
  const [variety, setVariety] = useState('');
  const [season, setSeason] = useState('');
  const [plantedAt, setPlantedAt] = useState('');
  const [expectedHarvestAt, setExpectedHarvestAt] = useState('');

  const save = useApiMutation<unknown, CropPlanting>({
    mutationFn: () =>
      createCropPlanting(plotId, {
        crop: crop.trim(),
        variety: variety.trim() || undefined,
        season: season.trim(),
        plantedAt: new Date(plantedAt).toISOString(),
        expectedHarvestAt: expectedHarvestAt
          ? new Date(expectedHarvestAt).toISOString()
          : undefined
      }).then((res) => res.data),
    queue: {
      kind: 'farms.planting.created',
      label: () => `Record planting on ${plotId}`,
      method: 'POST',
      path: () => `/farms/plots/${plotId}/plantings`,
      payload: () => ({ crop: crop.trim(), season: season.trim(), plantedAt })
    },
    onSuccess: () => {
      invalidateApiQueries(`farms.plantings.${plotId}`, 'farms.summary');
      onSaved();
    }
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save.mutate(undefined);
      }}
    >
      <Field id="planting-crop" label={t('farms.cropLabel')}>
        <TextInput
          id="planting-crop"
          required
          value={crop}
          onChange={(event) => setCrop(event.target.value)}
        />
      </Field>
      <Field id="planting-variety" label={t('farms.varietyLabel')}>
        <TextInput
          id="planting-variety"
          value={variety}
          onChange={(event) => setVariety(event.target.value)}
        />
      </Field>
      <Field id="planting-season" label={t('farms.seasonLabel')}>
        <TextInput
          id="planting-season"
          required
          placeholder="2026-wet"
          value={season}
          onChange={(event) => setSeason(event.target.value)}
        />
      </Field>
      <Field id="planting-planted" label={t('farms.plantedAtLabel')}>
        <TextInput
          id="planting-planted"
          required
          type="date"
          value={plantedAt}
          onChange={(event) => setPlantedAt(event.target.value)}
        />
      </Field>
      <Field id="planting-expected" label={t('farms.expectedHarvestLabel')}>
        <TextInput
          id="planting-expected"
          type="date"
          value={expectedHarvestAt}
          onChange={(event) => setExpectedHarvestAt(event.target.value)}
        />
      </Field>
      {save.status === 'error' ? <ApiErrorNotice error={save.error} /> : null}
      <button className="btn btn-primary btn-small" type="submit" disabled={save.status === 'pending'}>
        {save.status === 'pending' ? t('farms.saving') : t('farms.addPlanting')}
      </button>
    </form>
  );
}

/* ----------------------------- harvest form ---------------------------- */

function HarvestForm({ plantingId, onSaved }: { plantingId: string; onSaved: () => void }) {
  const { t } = useT();
  const [harvestedAt, setHarvestedAt] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<(typeof HARVEST_UNITS)[number]>('kg');
  const [grade, setGrade] = useState('');

  const save = useApiMutation<unknown, HarvestRecord>({
    mutationFn: () =>
      recordHarvest(plantingId, {
        harvestedAt: new Date(harvestedAt).toISOString(),
        quantity: Number(quantity),
        unit,
        qualityGrade: (grade || undefined) as HarvestRecord['qualityGrade']
      }).then((res) => res.data),
    queue: {
      kind: 'farms.harvest.recorded',
      label: () => `Record harvest for ${plantingId}`,
      method: 'POST',
      path: () => `/farms/plantings/${plantingId}/harvests`,
      payload: () => ({ harvestedAt, quantity: Number(quantity), unit })
    },
    onSuccess: () => {
      invalidateApiQueries(`farms.harvests.${plantingId}`, 'farms.summary');
      onSaved();
    }
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save.mutate(undefined);
      }}
    >
      <Field id="harvest-date" label={t('farms.harvestedAtLabel')}>
        <TextInput
          id="harvest-date"
          required
          type="date"
          value={harvestedAt}
          onChange={(event) => setHarvestedAt(event.target.value)}
        />
      </Field>
      <Field id="harvest-quantity" label={t('farms.quantityLabel')}>
        <TextInput
          id="harvest-quantity"
          required
          type="number"
          min={0}
          step="any"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Field id="harvest-unit" label={t('farms.unitLabel')}>
        <Select
          id="harvest-unit"
          value={unit}
          onChange={(event) => setUnit(event.target.value as typeof unit)}
        >
          {HARVEST_UNITS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="harvest-grade" label={t('farms.gradeLabel')}>
        <Select id="harvest-grade" value={grade} onChange={(event) => setGrade(event.target.value)}>
          <option value="">{t('farms.gradeNone')}</option>
          {HARVEST_QUALITY_GRADES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      {save.status === 'error' ? <ApiErrorNotice error={save.error} /> : null}
      <button className="btn btn-primary btn-small" type="submit" disabled={save.status === 'pending'}>
        {save.status === 'pending' ? t('farms.saving') : t('farms.recordHarvest')}
      </button>
    </form>
  );
}

/* ----------------------------- expense form ---------------------------- */

function ExpenseForm({ plotId, onSaved }: { plotId: string; onSaved: () => void }) {
  const { t } = useT();
  const [category, setCategory] = useState<(typeof FARM_EXPENSE_CATEGORIES)[number]>('seeds');
  const [amount, setAmount] = useState('');
  const [incurredAt, setIncurredAt] = useState('');
  const [note, setNote] = useState('');

  const save = useApiMutation<unknown, FarmExpense>({
    mutationFn: () =>
      createFarmExpense(plotId, {
        category,
        amountKobo: Math.round(Number(amount) * 100),
        incurredAt: new Date(incurredAt).toISOString(),
        note: note.trim() || undefined
      }).then((res) => res.data),
    queue: {
      kind: 'farms.expense.recorded',
      label: () => `Record expense on ${plotId}`,
      method: 'POST',
      path: () => `/farms/plots/${plotId}/expenses`,
      payload: () => ({ category, amountKobo: Math.round(Number(amount) * 100), incurredAt })
    },
    onSuccess: () => {
      invalidateApiQueries(`farms.expenses.${plotId}`, 'farms.summary');
      onSaved();
    }
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save.mutate(undefined);
      }}
    >
      <Field id="expense-category" label={t('farms.categoryLabel')}>
        <Select
          id="expense-category"
          value={category}
          onChange={(event) => setCategory(event.target.value as typeof category)}
        >
          {FARM_EXPENSE_CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="expense-amount" label={t('farms.amountLabel')}>
        <TextInput
          id="expense-amount"
          required
          type="number"
          min={0}
          step="any"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
      <Field id="expense-date" label={t('farms.incurredAtLabel')}>
        <TextInput
          id="expense-date"
          required
          type="date"
          value={incurredAt}
          onChange={(event) => setIncurredAt(event.target.value)}
        />
      </Field>
      <Field id="expense-note" label={t('farms.noteLabel')}>
        <TextInput
          id="expense-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {save.status === 'error' ? <ApiErrorNotice error={save.error} /> : null}
      <button className="btn btn-primary btn-small" type="submit" disabled={save.status === 'pending'}>
        {save.status === 'pending' ? t('farms.saving') : t('farms.addExpense')}
      </button>
    </form>
  );
}

/* ----------------------------- plot detail ----------------------------- */

type DetailTab = 'plantings' | 'harvests' | 'expenses';

/** Plot detail with plantings / harvests / expenses tabs. */
export function PlotDetail({ plot, onBack }: { plot: FarmPlot; onBack: () => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<DetailTab>('plantings');
  const [showPlantingForm, setShowPlantingForm] = useState(false);
  const [harvestFormFor, setHarvestFormFor] = useState<string | null>(null);
  const [showExpenseForm, setShowExpenseForm] = useState(false);

  const plantings = useApiQuery<CropPlanting[]>(
    `farms.plantings.${plot.id}`,
    () => listCropPlantings(plot.id).then((res) => res.data),
    { fallbackData: demoCropPlantings.filter((item) => item.plotId === plot.id) }
  );
  const firstPlantingId = plantings.data?.[0]?.id;
  const harvests = useApiQuery<HarvestRecord[]>(
    firstPlantingId ? `farms.harvests.${firstPlantingId}` : null,
    () => listHarvestRecords(firstPlantingId!).then((res) => res.data),
    { fallbackData: demoHarvestRecords.filter((item) => item.plantingId === firstPlantingId) }
  );
  const expenses = useApiQuery<FarmExpense[]>(
    `farms.expenses.${plot.id}`,
    () => listFarmExpenses(plot.id).then((res) => res.data),
    { fallbackData: demoFarmExpenses.filter((item) => item.plotId === plot.id) }
  );

  const fail = useApiMutation<string, CropPlanting>({
    mutationFn: (plantingId) =>
      transitionCropPlanting(plantingId, 'failed').then((res) => res.data),
    queue: {
      kind: 'farms.planting.status_changed',
      label: (plantingId) => `Mark planting ${plantingId} failed`,
      method: 'PATCH',
      path: (plantingId) => `/farms/plantings/${plantingId}`,
      payload: () => ({ status: 'failed' satisfies PlantingStatus })
    },
    onSuccess: () => invalidateApiQueries(`farms.plantings.${plot.id}`, 'farms.summary')
  });

  return (
    <Section kicker={t('farms.detailKicker')} title={plot.name}>
      <button className="btn btn-ghost btn-small" type="button" onClick={onBack}>
        {t('farms.backToPlots')}
      </button>
      <p className="small muted">
        {plot.lga}, {plot.state} · {t('farms.plotHectares', { count: plot.sizeHectares })}
        {plot.soilType ? ` · ${plot.soilType}` : ''} · v{plot.version}
      </p>
      <div role="tablist" aria-label={plot.name}>
        {(
          [
            ['plantings', t('farms.tabPlantings')],
            ['harvests', t('farms.tabHarvests')],
            ['expenses', t('farms.tabExpenses')]
          ] as Array<[DetailTab, string]>
        ).map(([name, label]) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'btn btn-secondary btn-small' : 'btn btn-ghost btn-small'}
            type="button"
            onClick={() => setTab(name)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'plantings' ? (
        <Card>
          {(plantings.data ?? []).length === 0 ? (
            <EmptyState title={t('farms.plantingsEmpty')} />
          ) : (
            (plantings.data ?? []).map((planting) => (
              <Card key={planting.id}>
                <p>
                  {planting.crop}
                  {planting.variety ? ` · ${planting.variety}` : ''} · {planting.season}{' '}
                  <AutoBadge value={planting.status} />
                </p>
                {planting.status === 'growing' ? (
                  <>
                    <button
                      className="btn btn-ghost btn-small"
                      type="button"
                      onClick={() =>
                        setHarvestFormFor(harvestFormFor === planting.id ? null : planting.id)
                      }
                    >
                      {t('farms.recordHarvest')}
                    </button>{' '}
                    <button
                      className="btn btn-ghost btn-small"
                      type="button"
                      onClick={() => void fail.mutate(planting.id)}
                    >
                      {t('farms.markFailed')}
                    </button>
                    {harvestFormFor === planting.id ? (
                      <HarvestForm
                        plantingId={planting.id}
                        onSaved={() => {
                          setHarvestFormFor(null);
                          plantings.refresh();
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
              </Card>
            ))
          )}
          <button
            className="btn btn-secondary btn-small"
            type="button"
            onClick={() => setShowPlantingForm((open) => !open)}
          >
            {showPlantingForm ? t('farms.closeForm') : t('farms.addPlanting')}
          </button>
          {showPlantingForm ? (
            <PlantingForm
              plotId={plot.id}
              onSaved={() => {
                setShowPlantingForm(false);
                plantings.refresh();
              }}
            />
          ) : null}
        </Card>
      ) : null}

      {tab === 'harvests' ? (
        <Card>
          {!firstPlantingId || (harvests.data ?? []).length === 0 ? (
            <EmptyState title={t('farms.harvestsEmpty')} />
          ) : (
            (harvests.data ?? []).map((harvest) => (
              <p key={harvest.id}>
                {harvest.quantity} {harvest.unit}
                {harvest.qualityGrade ? ` · ${t('farms.gradeLabel')} ${harvest.qualityGrade}` : ''}{' '}
                · {harvest.harvestedAt.slice(0, 10)}
              </p>
            ))
          )}
        </Card>
      ) : null}

      {tab === 'expenses' ? (
        <Card>
          {(expenses.data ?? []).length === 0 ? (
            <EmptyState title={t('farms.expensesEmpty')} />
          ) : (
            (expenses.data ?? []).map((expense) => (
              <p key={expense.id}>
                {expense.category} · ₦{(expense.amountKobo / 100).toLocaleString('en-NG')} ·{' '}
                {expense.incurredAt.slice(0, 10)}
                {expense.note ? ` · ${expense.note}` : ''}
              </p>
            ))
          )}
          <button
            className="btn btn-secondary btn-small"
            type="button"
            onClick={() => setShowExpenseForm((open) => !open)}
          >
            {showExpenseForm ? t('farms.closeForm') : t('farms.addExpense')}
          </button>
          {showExpenseForm ? (
            <ExpenseForm
              plotId={plot.id}
              onSaved={() => {
                setShowExpenseForm(false);
                expenses.refresh();
              }}
            />
          ) : null}
        </Card>
      ) : null}
    </Section>
  );
}

/* ------------------------------- hub ----------------------------------- */

/** Farms hub: summary cards, plot list and create/edit forms. */
export function FarmsHub() {
  const { t } = useT();
  const [selected, setSelected] = useState<FarmPlot | null>(null);
  const [editing, setEditing] = useState<FarmPlot | null>(null);
  const [showForm, setShowForm] = useState(false);

  const plots = useApiQuery<FarmPlot[]>('farms.plots', () => listFarmPlots().then((res) => res.data), {
    fallbackData: demoFarmPlots
  });

  if (selected) {
    return <PlotDetail plot={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <>
      <FarmSummaryCards />
      <Section kicker={t('farms.plotsKicker')} title={t('farms.plotsTitle')}>
        {plots.source === 'fallback' ? (
          <OfflineDataNotice>{t('farms.offlineNotice')}</OfflineDataNotice>
        ) : null}
        {plots.error && plots.source !== 'fallback' ? (
          <ApiErrorNotice error={plots.error} onRetry={plots.refresh} />
        ) : null}
        {(plots.data ?? []).length === 0 ? (
          <EmptyState title={t('farms.plotsEmpty')} />
        ) : (
          (plots.data ?? []).map((plot) => (
            <Card key={plot.id}>
              <p>
                <strong>{plot.name}</strong> — {plot.lga}, {plot.state}
              </p>
              <p className="small muted">
                {t('farms.plotHectares', { count: plot.sizeHectares })}
                {plot.soilType ? ` · ${plot.soilType}` : ''}
                {plot.boundaryGeojson ? ' · GeoJSON' : ''}
              </p>
              <button
                className="btn btn-secondary btn-small"
                type="button"
                onClick={() => setSelected(plot)}
              >
                {t('farms.detailKicker')}
              </button>{' '}
              <button
                className="btn btn-ghost btn-small"
                type="button"
                onClick={() => {
                  setEditing(plot);
                  setShowForm(true);
                }}
              >
                {t('farms.editPlot')}
              </button>
            </Card>
          ))
        )}
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            setEditing(null);
            setShowForm((open) => !open);
          }}
        >
          {showForm && !editing ? t('farms.closeForm') : t('farms.createPlot')}
        </button>
        {showForm ? (
          <PlotForm
            plot={editing ?? undefined}
            onSaved={() => {
              setShowForm(false);
              setEditing(null);
              plots.refresh();
            }}
            onCancel={() => {
              setShowForm(false);
              setEditing(null);
            }}
          />
        ) : null}
      </Section>
    </>
  );
}
