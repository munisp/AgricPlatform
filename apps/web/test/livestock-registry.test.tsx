import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { MyAnimals, RegisterAnimalForm, LotsPanel, PastoralistProfileForm } from '@/components/livestock-live';
import { AnimalDetail } from '@/components/livestock-animal-detail';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

const ANIMAL = {
  id: 'NG-BOV-KD-000123',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  birthDate: '2022-03-15',
  tagId: 'TAG-KD-0412',
  ownerUserId: 'user-adamu',
  state: 'Kaduna',
  lga: 'Zaria',
  status: 'alive',
  sireId: 'NG-BOV-KD-000011',
  damId: 'NG-BOV-KD-000087',
  createdAt: '2026-05-02T08:00:00.000Z',
  updatedAt: '2026-07-20T09:30:00.000Z'
};

const LOT = {
  id: 'LOT-CAP-KD-000003',
  species: 'goat',
  quantity: 14,
  ownerUserId: 'user-adamu',
  state: 'Kaduna',
  lga: 'Zaria',
  status: 'open',
  createdAt: '2026-05-20T07:00:00.000Z',
  updatedAt: '2026-05-20T07:00:00.000Z'
};

const ACTIVE_LIEN = {
  id: 'lien-1',
  subjectType: 'animal',
  subjectId: 'NG-BOV-KD-000123',
  lenderUserId: 'user-lender',
  borrowerUserId: 'user-adamu',
  principalKobo: 30_000_000,
  terms: '6-month input credit.',
  status: 'active',
  registeredAt: '2026-06-05T09:00:00.000Z',
  createdAt: '2026-06-05T09:00:00.000Z',
  updatedAt: '2026-06-05T09:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  const method = init?.method ?? 'GET';
  if (path.endsWith('/api/v1/livestock/animals/mine')) return jsonResponse({ data: [ANIMAL] });
  if (path.endsWith(`/api/v1/livestock/animals/${ANIMAL.id}/transfers`)) {
    return jsonResponse({
      data: [
        {
          id: 'transfer-1',
          animalId: ANIMAL.id,
          fromUserId: 'user-hassan',
          toUserId: 'user-adamu',
          transferType: 'sale',
          effectiveAt: '2026-05-02T08:00:00.000Z',
          recordedBy: 'user-hassan',
          createdAt: '2026-05-02T08:00:00.000Z'
        }
      ]
    });
  }
  if (path.endsWith(`/api/v1/livestock/animals/${ANIMAL.id}/transfer`) && method === 'POST') {
    return jsonResponse({
      data: {
        id: 'transfer-new',
        animalId: ANIMAL.id,
        fromUserId: 'user-adamu',
        toUserId: 'user-hassan',
        transferType: 'sale',
        effectiveAt: '2026-08-01T00:00:00.000Z',
        recordedBy: 'user-adamu',
        createdAt: '2026-08-01T00:00:00.000Z'
      }
    });
  }
  if (path.endsWith(`/api/v1/livestock/animals/${ANIMAL.id}`)) return jsonResponse({ data: ANIMAL });
  if (path.endsWith('/api/v1/livestock/animals') && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    return jsonResponse({
      data: { ...ANIMAL, id: 'NG-CAP-KD-000999', species: body.species, breed: body.breed }
    });
  }
  if (path.endsWith('/api/v1/livestock/lots/mine')) return jsonResponse({ data: [LOT] });
  if (path.endsWith(`/api/v1/livestock/lots/${LOT.id}`)) {
    return jsonResponse({ data: { ...LOT, animalIds: ['NG-CAP-KD-000045'] } });
  }
  if (path.endsWith('/api/v1/livestock/pastoralist-profile')) {
    return jsonResponse({
      data: {
        userId: 'user-adamu',
        grazingZoneId: 'GZ-04',
        primarySpecies: ['cattle'],
        updatedAt: '2026-07-01T08:00:00.000Z'
      }
    });
  }
  if (path.endsWith('/api/v1/livestock-finance/liens')) return jsonResponse({ data: [] });
  if (path.endsWith(`/api/v1/livestock-health/animals/${ANIMAL.id}/grade`)) {
    return jsonResponse({
      data: {
        animalId: ANIMAL.id,
        species: 'cattle',
        grade: 'B',
        score: 68,
        components: {
          vaccinationCoverage: 2 / 3,
          vaccinationPoints: 30,
          treatmentPoints: 12,
          movementPoints: 10,
          agePoints: 16,
          movementCount: 2,
          requiredVaccinations: ['FMD', 'CBPP', 'Anthrax'],
          completedVaccinations: ['FMD', 'Anthrax']
        },
        computedAt: '2026-07-31T08:00:00.000Z'
      }
    });
  }
  return jsonResponse({ data: null });
}

describe('Livestock registry', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lists my animals with species/status/state filters', async () => {
    renderWithProviders(<MyAnimals />);
    await waitFor(() => {
      expect(screen.getByText('NG-BOV-KD-000123')).toBeTruthy();
    });
    expect(screen.getByLabelText('Species')).toBeTruthy();
    expect(screen.getByLabelText('Status')).toBeTruthy();
    expect(screen.getByLabelText('State')).toBeTruthy();
    expect(screen.getByText(/White Fulani cattle/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View animal' }).getAttribute('href')).toBe(
      '/livestock/animals/NG-BOV-KD-000123'
    );
  });

  it('shows the offline notice and fixture data when the API is down', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    renderWithProviders(<MyAnimals />);
    await waitFor(() => {
      expect(screen.getByText(/Offline — showing saved reference data/)).toBeTruthy();
    });
    expect(screen.getByText('NG-CAP-KD-000045')).toBeTruthy();
  });

  it('cascades breeds from the selected species and posts the registration', async () => {
    renderWithProviders(<RegisterAnimalForm />);
    const saveButton = screen.getByRole('button', { name: 'Save animal' });
    // Validation: no state selected yet.
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Species'), { target: { value: 'goat' } });
    const breedSelect = screen.getByLabelText(/Breed/) as HTMLSelectElement;
    const options = [...breedSelect.options].map((option) => option.value);
    expect(options).toEqual(['West African Dwarf', 'Sahel', 'Red Sokoto']);

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kaduna' } });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/NG-CAP-KD-000999/)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).pathname.endsWith('/api/v1/livestock/animals') &&
        (init as RequestInit)?.method === 'POST'
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({ species: 'goat', breed: 'West African Dwarf', sex: 'female', state: 'Kaduna' });
  });

  it('manages lots and their members', async () => {
    renderWithProviders(<LotsPanel />);
    await waitFor(() => {
      expect(screen.getByText('LOT-CAP-KD-000003')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Manage members' }));
    await waitFor(() => {
      expect(screen.getByText('NG-CAP-KD-000045')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Remove NG-CAP-KD-000045 from LOT-CAP-KD-000003' })).toBeTruthy();
  });

  it('loads the pastoralist profile into the editor', async () => {
    renderWithProviders(<PastoralistProfileForm />);
    await waitFor(() => {
      expect((screen.getByLabelText(/Grazing zone/) as HTMLInputElement).value).toBe('GZ-04');
    });
    expect((screen.getByLabelText('cattle') as HTMLInputElement).checked).toBe(true);
  });

  it('shows lineage, grade badge and transfer history on the animal detail', async () => {
    renderWithProviders(<AnimalDetail animalId={ANIMAL.id} />);
    await waitFor(() => {
      expect(screen.getByText('Grade B')).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: 'NG-BOV-KD-000011' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'NG-BOV-KD-000087' })).toBeTruthy();
    expect(screen.getByText(/user-hassan → user-adamu/)).toBeTruthy();
    // Rubric tooltip on the grade badge.
    expect(screen.getByLabelText(/Trust grade B/)).toBeTruthy();
  });

  it('warns about an active lien and disables transfer', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith('/api/v1/livestock-finance/liens')) {
        return jsonResponse({ data: [ACTIVE_LIEN] });
      }
      return router(url, init);
    });
    renderWithProviders(<AnimalDetail animalId={ANIMAL.id} />);
    await waitFor(() => {
      expect(screen.getByTestId('lien-warning')).toBeTruthy();
    });
    expect(screen.getByTestId('transfer-lien-block')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Transfer ownership' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('posts an ownership transfer when no lien is active', async () => {
    renderWithProviders(<AnimalDetail animalId={ANIMAL.id} />);
    await waitFor(() => {
      expect(screen.getByLabelText('New owner (user ID)')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('New owner (user ID)'), {
      target: { value: 'user-hassan' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes(`/api/v1/livestock/animals/${ANIMAL.id}/transfer`) &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ toUserId: 'user-hassan', transferType: 'sale' });
    });
    await waitFor(() => {
      expect(screen.getByText('transferred')).toBeTruthy();
    });
  });

  it('MyAnimals composite has no axe violations', async () => {
    const { container } = renderWithProviders(<MyAnimals />);
    await waitFor(() => {
      expect(container.textContent).toContain('NG-BOV-KD-000123');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('AnimalDetail composite has no axe violations', async () => {
    const { container } = renderWithProviders(<AnimalDetail animalId={ANIMAL.id} />);
    await waitFor(() => {
      expect(container.textContent).toContain('Grade B');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
