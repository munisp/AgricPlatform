import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  DiseaseSurveillanceBoard,
  HealthLedger,
  MovementPanel,
  PermitPanel,
  RecallConsole,
  RecordHealthForm
} from '@/components/livestock-health-live';

expect.extend(toHaveNoViolations);

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

function previewRole(role: string, userId: string) {
  window.sessionStorage.setItem(
    'agric.session',
    JSON.stringify({ userId, displayName: role, role, isDevPreview: true })
  );
}

const RECORD = {
  id: 'hr-1',
  animalId: 'NG-BOV-KD-000123',
  recordType: 'vaccination',
  product: 'FMD',
  batchNumber: 'FMD-2026-041',
  dose: '2 ml',
  administeredAt: '2026-06-01T09:00:00.000Z',
  vetUserId: 'user-vet',
  signature: 'sig-demo-fmd',
  signedAt: '2026-06-01T09:01:00.000Z',
  createdAt: '2026-06-01T09:01:00.000Z'
};

const REVERSAL = {
  ...RECORD,
  id: 'hr-2',
  notes: 'Reversal of hr-1.',
  reversalOfId: 'hr-1'
};

const PERMIT = {
  id: 'permit-1',
  permitNumber: 'PMT-KD-KN-3F9A2C71',
  fromState: 'Kaduna',
  toState: 'Kano',
  validFrom: '2026-06-18T00:00:00.000Z',
  validUntil: '2099-06-25T00:00:00.000Z',
  status: 'issued',
  issuedBy: 'user-vet',
  createdAt: '2026-06-18T10:00:00.000Z',
  updatedAt: '2026-06-18T10:00:00.000Z'
};

const FLAG = {
  id: 'flag-1',
  disease: 'PPR',
  state: 'Kaduna',
  suspectedSpecies: 'goat',
  reporterUserId: 'user-adamu',
  status: 'reported',
  createdAt: '2026-07-22T08:00:00.000Z',
  updatedAt: '2026-07-22T08:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  const method = init?.method ?? 'GET';

  if (path.endsWith('/api/v1/livestock-health/records') && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ data: { ...RECORD, id: 'hr-new', ...body } });
  }
  if (path.endsWith('/api/v1/livestock-health/records/hr-new/verify')) {
    return jsonResponse({ data: { recordId: 'hr-new', ok: true, reversed: false } });
  }
  if (path.endsWith('/api/v1/livestock-health/records/hr-1/verify')) {
    return jsonResponse({ data: { recordId: 'hr-1', ok: true, reversed: true } });
  }
  if (path.endsWith('/api/v1/livestock-health/animals/NG-BOV-KD-000123/records')) {
    return jsonResponse({ data: [RECORD, REVERSAL] });
  }
  if (path.endsWith('/api/v1/livestock-health/animals/NG-BOV-KD-000123/movements')) {
    return jsonResponse({
      data: [
        {
          id: 'move-1',
          animalId: 'NG-BOV-KD-000123',
          fromState: 'Kano',
          toState: 'Kaduna',
          departedAt: '2026-07-26T05:30:00.000Z',
          transportMode: 'trek',
          purpose: 'grazing',
          recordedBy: 'user-adamu',
          createdAt: '2026-07-26T05:30:00.000Z'
        }
      ]
    });
  }
  if (path.endsWith('/api/v1/livestock-health/movements') && method === 'POST') {
    return jsonResponse({ data: { id: 'move-new' } });
  }
  if (path.endsWith('/api/v1/livestock-health/movements/move-1/arrive') && method === 'POST') {
    return jsonResponse({ data: { id: 'move-1', arrivedAt: '2026-07-28T10:00:00.000Z' } });
  }
  if (path.endsWith(`/api/v1/livestock-health/permits/${PERMIT.permitNumber}/verify`)) {
    return jsonResponse({
      data: {
        permit: PERMIT,
        subjects: [{ permitId: 'permit-1', subjectType: 'animal', subjectId: 'NG-BOV-KD-000123' }],
        verification: 'valid'
      }
    });
  }
  if (path.endsWith('/api/v1/livestock-health/permits/permit-1/revoke') && method === 'POST') {
    return jsonResponse({ data: { ...PERMIT, status: 'revoked', revokedReason: 'Fraud' } });
  }
  if (path.endsWith('/api/v1/livestock-health/permits') && method === 'POST') {
    return jsonResponse({ data: PERMIT });
  }
  if (path.endsWith('/api/v1/livestock-health/recalls') && method === 'POST') {
    return jsonResponse({
      data: {
        recall: {
          id: 'recall-new',
          scope: 'animal',
          animalId: 'NG-BOV-KD-000123',
          reason: 'Batch QC failure',
          status: 'initiated',
          initiatedBy: 'user-regulator',
          createdAt: '2026-08-01T00:00:00.000Z'
        },
        animals: [{ recallId: 'recall-new', animalId: 'NG-BOV-KD-000123', ownerUserId: 'user-adamu' }]
      }
    });
  }
  if (path.endsWith('/api/v1/livestock-health/recalls') && method === 'GET') {
    return jsonResponse({
      data: [
        {
          id: 'recall-1',
          scope: 'region',
          state: 'Kaduna',
          reason: 'Batch OXY-2026-118 QC failure',
          status: 'notified',
          initiatedBy: 'user-regulator',
          createdAt: '2026-07-18T11:00:00.000Z'
        }
      ]
    });
  }
  if (path.endsWith('/api/v1/livestock-health/recalls/recall-1/resolve') && method === 'POST') {
    return jsonResponse({ data: { id: 'recall-1', status: 'resolved' } });
  }
  if (path.endsWith('/api/v1/livestock-health/recalls/recall-1')) {
    return jsonResponse({
      data: {
        recall: { id: 'recall-1', status: 'notified' },
        animals: [{ recallId: 'recall-1', animalId: 'NG-BOV-KD-000123', ownerUserId: 'user-adamu' }]
      }
    });
  }
  if (path.endsWith('/api/v1/livestock-health/disease-flags/flag-1/confirm') && method === 'POST') {
    return jsonResponse({ data: { ...FLAG, status: 'confirmed', confirmedBy: 'user-vet' } });
  }
  if (path.endsWith('/api/v1/livestock-health/disease-flags/flag-1/retract') && method === 'POST') {
    return jsonResponse({ data: { ...FLAG, status: 'retracted', retractedReason: 'False positive' } });
  }
  if (path.endsWith('/api/v1/livestock-health/disease-flags') && method === 'POST') {
    return jsonResponse({ data: { ...FLAG, id: 'flag-new' } });
  }
  if (path.endsWith('/api/v1/livestock-health/disease-flags')) {
    return jsonResponse({ data: [FLAG] });
  }
  if (path.endsWith('/api/v1/livestock-health/disease-map')) {
    return jsonResponse({
      data: [
        {
          state: 'Kaduna',
          disease: 'PPR',
          confirmedFlags: 3,
          latestReportedAt: '2026-07-23T10:00:00.000Z'
        }
      ]
    });
  }
  return jsonResponse({ data: null });
}

describe('Livestock health', () => {
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

  it('gates the vet record form by role', async () => {
    renderWithProviders(<RecordHealthForm />);
    // Default persona is farmer — the form is hidden behind the hint.
    expect(screen.getByTestId('role-gate-hint')).toBeTruthy();
    expect(screen.queryByLabelText('Animal ID')).toBeNull();
  });

  it('signs a record, shows the HMAC signature and verifies it', async () => {
    previewRole('vet', 'user-vet');
    renderWithProviders(<RecordHealthForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Animal ID')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Animal ID'), { target: { value: 'NG-BOV-KD-000123' } });
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'FMD' } });
    fireEvent.change(screen.getByLabelText('Batch number'), { target: { value: 'FMD-2026-041' } });
    fireEvent.change(screen.getByLabelText('Dose'), { target: { value: '2 ml' } });
    fireEvent.change(screen.getByLabelText('Administered at'), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and save record' }));

    await waitFor(() => {
      expect(screen.getByTestId('health-record-signature')).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).pathname.endsWith('/api/v1/livestock-health/records') &&
        (init as RequestInit)?.method === 'POST'
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      animalId: 'NG-BOV-KD-000123',
      recordType: 'vaccination',
      product: 'FMD',
      batchNumber: 'FMD-2026-041',
      dose: '2 ml'
    });

    fireEvent.click(screen.getByRole('button', { name: 'Verify signature' }));
    await waitFor(() => {
      expect(screen.getByText('signature valid')).toBeTruthy();
    });
  });

  it('renders the append-only ledger with reversal entries marked', async () => {
    renderWithProviders(<HealthLedger animalId="NG-BOV-KD-000123" />);
    await waitFor(() => {
      expect(screen.getByText('reversal of hr-1')).toBeTruthy();
    });
    expect(screen.getByText('original')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify signature of record hr-1' }));
    await waitFor(() => {
      expect(screen.getByText('valid')).toBeTruthy();
    });
  });

  it('starts a movement and records arrival', async () => {
    renderWithProviders(<MovementPanel />);
    fireEvent.change(screen.getByLabelText('Animal ID'), { target: { value: 'NG-BOV-KD-000123' } });
    fireEvent.change(screen.getByLabelText('From state'), { target: { value: 'Kano' } });
    fireEvent.change(screen.getByLabelText('To state'), { target: { value: 'Kaduna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start movement' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          new URL(String(url)).pathname.endsWith('/api/v1/livestock-health/movements') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ animalId: 'NG-BOV-KD-000123', fromState: 'Kano', toState: 'Kaduna' });
      expect(body.lotId).toBeUndefined();
    });

    fireEvent.change(screen.getByLabelText('Movement history for animal'), {
      target: { value: 'NG-BOV-KD-000123' }
    });
    const arriveButton = await screen.findByRole('button', {
      name: 'Record arrival of movement move-1'
    });
    fireEvent.click(arriveButton);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-health/movements/move-1/arrive')
      );
      expect(call).toBeTruthy();
    });
  });

  it('verifies a permit and shows the verification pill', async () => {
    renderWithProviders(<PermitPanel />);
    fireEvent.change(screen.getByLabelText('Verify permit (ID or number)'), {
      target: { value: PERMIT.permitNumber }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify permit' }));
    await waitFor(() => {
      expect(screen.getByTestId('permit-verification')).toBeTruthy();
    });
    expect(screen.getByLabelText('Permit verification: valid')).toBeTruthy();
    expect(screen.getByText(/PMT-KD-KN-3F9A2C71/)).toBeTruthy();
  });

  it('gates the recall console to regulators and previews affected animals', async () => {
    renderWithProviders(<RecallConsole />);
    expect(screen.getByTestId('role-gate-hint')).toBeTruthy();
    cleanup();
    clearApiCache();

    previewRole('regulator', 'user-regulator');
    renderWithProviders(<RecallConsole />);
    await waitFor(() => {
      expect(screen.getByLabelText('Reason')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Animal ID'), { target: { value: 'NG-BOV-KD-000123' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Batch QC failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Initiate recall' }));
    await waitFor(() => {
      expect(screen.getByTestId('recall-preview')).toBeTruthy();
    });
    expect(screen.getByText(/1 affected animal/)).toBeTruthy();
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).pathname.endsWith('/api/v1/livestock-health/recalls') &&
        (init as RequestInit)?.method === 'POST'
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({ animalId: 'NG-BOV-KD-000123', reason: 'Batch QC failure' });
  });

  it('reports, confirms and maps disease flags', async () => {
    previewRole('vet', 'user-vet');
    renderWithProviders(<DiseaseSurveillanceBoard />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm PPR flag in Kaduna' })).toBeTruthy();
    });
    // Disease map table groups confirmed flags by state.
    const mapRegion = screen.getByText('State disease map (confirmed)').closest('article')!;
    expect(mapRegion.textContent).toContain('Kaduna');
    expect(mapRegion.textContent).toContain('PPR');
    expect(mapRegion.textContent).toContain('3');

    // Confirm a reported flag as a vet.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm PPR flag in Kaduna' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-health/disease-flags/flag-1/confirm')
      );
      expect(call).toBeTruthy();
    });

    // Report a new flag.
    fireEvent.change(screen.getByLabelText('Disease'), { target: { value: 'Newcastle' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report flag' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          new URL(String(url)).pathname.endsWith('/api/v1/livestock-health/disease-flags') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ disease: 'Newcastle', state: 'Kano' });
    });
  });

  it('RecordHealthForm composite has no axe violations', async () => {
    previewRole('vet', 'user-vet');
    const { container } = renderWithProviders(<RecordHealthForm />);
    await waitFor(() => {
      expect(container.textContent).toContain('Record vaccination or treatment');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('DiseaseSurveillanceBoard composite has no axe violations', async () => {
    const { container } = renderWithProviders(<DiseaseSurveillanceBoard />);
    await waitFor(() => {
      expect(container.textContent).toContain('Kaduna');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
