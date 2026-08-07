import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { LivestockPassportHub } from '@/components/livestock-passport-live';

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

const HEAD_HASH = 'a'.repeat(64);
const CODE = 'LSP.NG-BOV-KD-000123.ab12cd34.0123456789abcdef';

const PASSPORT_DOC = {
  passport: {
    id: 'lsp-1',
    animalId: 'NG-BOV-KD-000123',
    passportCode: CODE,
    codeNonce: 'ab12cd34',
    codeSignature: `${'0'.repeat(48)}0123456789abcdef`,
    ownerUserId: 'user-adamu',
    status: 'active',
    tagCheckBasis: 'stub',
    tagCheckDetail: 'STUB — simulated check.',
    issuedBy: 'user-adamu',
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z'
  },
  animal: {
    id: 'NG-BOV-KD-000123',
    species: 'cattle',
    breed: 'White Fulani',
    sex: 'female',
    birthDate: '2022-03-15',
    state: 'Kaduna',
    status: 'alive',
    ownerUserId: 'user-adamu'
  },
  owner: { userId: 'user-adamu', fullName: 'Adamu Bello' },
  vaccinationSummary: {
    requiredVaccinations: ['FMD', 'CBPP', 'Anthrax'],
    completedVaccinations: ['FMD'],
    coverage: 1 / 3,
    vaccinationCount: 1,
    treatmentCount: 0,
    activeWithdrawal: false,
    lastVaccinationAt: '2026-06-01T09:00:00.000Z'
  },
  movementSummary: {
    totalMovements: 0,
    movementsWithPermit: 0,
    openMovements: 0,
    revokedPermits: 0,
    legal: true
  },
  insurancePolicies: [],
  passportTransfers: [],
  chain: { passportId: 'lsp-1', eventCount: 1, valid: true, headHash: HEAD_HASH, events: [] }
};

const EVENTS_PAYLOAD = {
  passport: PASSPORT_DOC.passport,
  events: [
    {
      id: 'lspe-1',
      passportId: 'lsp-1',
      seq: 0,
      type: 'ISSUED',
      actorId: 'user-adamu',
      payload: { animalId: 'NG-BOV-KD-000123' },
      prevEventHash: '0'.repeat(64),
      eventHash: HEAD_HASH,
      createdAt: '2026-08-01T08:00:00.000Z'
    }
  ],
  verification: {
    passportId: 'lsp-1',
    eventCount: 1,
    valid: true,
    headHash: HEAD_HASH,
    events: [
      {
        eventId: 'lspe-1',
        passportId: 'lsp-1',
        seq: 0,
        type: 'ISSUED',
        hashValid: true,
        prevLinkValid: true,
        valid: true,
        expectedHash: HEAD_HASH,
        storedHash: HEAD_HASH
      }
    ]
  }
};

const VERIFY_VIEW = {
  verified: true,
  passportCode: CODE,
  passportStatus: 'active',
  animal: {
    id: 'NG-BOV-KD-000123',
    species: 'cattle',
    breed: 'White Fulani',
    sex: 'female',
    birthDate: '2022-03-15',
    state: 'Kaduna',
    status: 'alive'
  },
  ownerInitials: 'A.B.',
  vaccinationSummary: {
    requiredVaccinations: ['FMD', 'CBPP', 'Anthrax'],
    completedVaccinations: ['FMD'],
    coverage: 1 / 3,
    activeWithdrawal: false
  },
  movementLegality: { totalMovements: 0, movementsWithPermit: 0, legal: true },
  encumbrance: { activeLien: false, insured: false },
  tagCheck: { basis: 'stub', stub: true },
  chain: { eventCount: 1, valid: true, headHash: HEAD_HASH },
  qr: { code: CODE, verifyPath: `/api/v1/livestock-passport/verify/${encodeURIComponent(CODE)}` },
  disclaimers: [
    'Tag check basis is STUB: a deterministic simulation — no national animal-ID authority or RFID registry was contacted.',
    'The digital passport aggregates platform records; it is not a government-issued document.'
  ]
};

const PENDING_TRANSFER = {
  id: 'lspt-1',
  passportId: 'lsp-1',
  animalId: 'NG-BOV-KD-000123',
  fromUserId: 'user-hassan',
  toUserId: 'user-adamu',
  status: 'pending',
  initiatedAt: '2026-08-02T08:00:00.000Z',
  createdAt: '2026-08-02T08:00:00.000Z',
  updatedAt: '2026-08-02T08:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const method = init?.method ?? 'GET';
  if (path.endsWith('/api/v1/livestock-passport/mine')) return jsonResponse({ data: [PASSPORT_DOC] });
  if (path.endsWith('/api/v1/livestock-passport/lsp-1/events')) {
    return jsonResponse({ data: EVENTS_PAYLOAD });
  }
  if (path.includes('/api/v1/livestock-passport/animals/') && method === 'POST') {
    return jsonResponse({ data: PASSPORT_DOC });
  }
  if (path.includes('/api/v1/livestock-passport/verify/')) {
    const code = decodeURIComponent(path.split('/verify/')[1] ?? '');
    if (code === CODE) return jsonResponse({ data: VERIFY_VIEW });
    return jsonResponse({ error: { message: 'Passport code is invalid or unknown' } }, 404);
  }
  if (path.endsWith('/api/v1/livestock-passport/transfers') && method === 'GET') {
    const direction = parsed.searchParams.get('direction');
    return jsonResponse({ data: direction === 'incoming' ? [PENDING_TRANSFER] : [] });
  }
  if (path.endsWith('/api/v1/livestock-passport/transfers/lspt-1/confirm') && method === 'POST') {
    return jsonResponse({ data: { ...PENDING_TRANSFER, status: 'confirmed' } });
  }
  if (path.endsWith('/api/v1/livestock-passport/lsp-1/transfers') && method === 'POST') {
    return jsonResponse({ data: PENDING_TRANSFER });
  }
  return jsonResponse({ data: null });
}

describe('Livestock passport console', () => {
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

  it('lists passports with code, vaccination coverage and the chain badge', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByText(CODE)).toBeTruthy();
    });
    expect(screen.getAllByText('NG-BOV-KD-000123').length).toBeGreaterThan(0);
    expect(screen.getByText(/33%/)).toBeTruthy();
    expect(screen.getByText('✓ chain')).toBeTruthy();
    expect(screen.getByText(/STUB — simulated check/)).toBeTruthy();
  });

  it('shows the empty state when no passports exist', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/livestock-passport/mine')) return jsonResponse({ data: [] });
      return router(url);
    });
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByText('No passports yet.')).toBeTruthy();
    });
  });

  it('expands the hash-chained event log with per-event verification', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByText(CODE)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'View event chain' }));
    await waitFor(() => {
      expect(screen.getByText('ISSUED')).toBeTruthy();
    });
    expect(screen.getByTestId('chain-status').textContent).toContain('Hash chain verified');
  });

  it('issues a passport for a typed animal ID', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByLabelText('Animal ID')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Animal ID'), {
      target: { value: 'NG-BOV-KD-000123' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue passport' }));
    await waitFor(() => {
      expect(screen.getByText(/Passport issued/)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find((args: unknown[]) =>
      String(args[0]).includes('/api/v1/livestock-passport/animals/NG-BOV-KD-000123')
    );
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('initiates an ownership transfer with the buyer id', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByLabelText('Buyer user ID')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Buyer user ID'), { target: { value: 'user-chidi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Initiate transfer' }));
    await waitFor(() => {
      expect(screen.getByText(/Transfer initiated/)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      (args: unknown[]) =>
        String(args[0]).endsWith('/api/v1/livestock-passport/lsp-1/transfers') &&
        (args[1] as RequestInit | undefined)?.method === 'POST'
    );
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
      toUserId: 'user-chidi'
    });
  });

  it('confirms an incoming transfer as the buyer', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByTestId('transfer-lspt-1')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm transfer' }));
    await waitFor(() => {
      expect(screen.getByText(/Transfer confirmed/)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find((args: unknown[]) =>
      String(args[0]).endsWith('/api/v1/livestock-passport/transfers/lspt-1/confirm')
    );
    expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('verifies a genuine code and renders the redacted public view', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByLabelText('Passport code')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Passport code'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(screen.getByTestId('verify-result')).toBeTruthy();
    });
    const result = screen.getByTestId('verify-result');
    expect(result.textContent).toContain('Verified passport');
    expect(result.textContent).toContain('A.B.');
    // Redaction: no owner full name or user id leaks into the public view.
    expect(result.textContent).not.toContain('Adamu');
    expect(result.textContent).not.toContain('user-adamu');
    expect(result.textContent).toContain('STUB');
    expect(result.textContent).toContain('Hash chain verified');
    expect(result.textContent).toContain('/api/v1/livestock-passport/verify/');
  });

  it('shows the invalid-code notice for forged codes', async () => {
    renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByLabelText('Passport code')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Passport code'), {
      target: { value: `${CODE.slice(0, -4)}ffff` }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(screen.getByText(/forged codes fail verification/)).toBeTruthy();
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<LivestockPassportHub />);
    await waitFor(() => {
      expect(screen.getByText(CODE)).toBeTruthy();
    });
    const results = await axe(container, AXE_OPTIONS);
    expect(results).toHaveNoViolations();
  });
});
