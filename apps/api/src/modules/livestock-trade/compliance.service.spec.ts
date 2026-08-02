import { beforeEach, describe, expect, it } from 'vitest';
import type { Animal, OwnershipTransfer, User } from '@agric-platform/shared';
import {
  createInMemoryAnimalRepository,
  createInMemoryOwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import { ComplianceService } from './compliance.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const regulator = asUser('regulator-1', ['regulator']);
const admin = asUser('admin-1', ['admin']);
const farmer = asUser('farmer-1', ['farmer']);

const kadunaAnimal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: farmer.id,
  state: 'Kaduna',
  lga: 'Zaria',
  status: 'alive',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z'
};

const kanoAnimal: Animal = {
  ...kadunaAnimal,
  id: 'NG-CAP-KN-000002',
  species: 'goat',
  breed: 'Red Sokoto',
  state: 'Kano',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z'
};

const transfer: OwnershipTransfer = {
  id: 'transfer-1',
  animalId: kadunaAnimal.id,
  fromUserId: 'farmer-0',
  toUserId: farmer.id,
  transferType: 'sale',
  effectiveAt: '2026-02-15T00:00:00.000Z',
  recordedBy: 'farmer-0',
  createdAt: '2026-02-15T00:00:00.000Z'
};

describe('ComplianceService', () => {
  let service: ComplianceService;

  beforeEach(() => {
    const transfers = createInMemoryOwnershipTransferRepository([transfer]);
    const animals = createInMemoryAnimalRepository(transfers, [kadunaAnimal, kanoAnimal]);
    service = new ComplianceService(animals, transfers);
  });

  it('gates the export to regulator (or admin) roles', async () => {
    await expect(service.exportCsv(farmer, {})).rejects.toThrow('regulator');
    await expect(service.exportCsv(null, {})).rejects.toThrow('Authentication required');
    await expect(service.exportCsv(admin, {})).resolves.toContain('section,animals');
  });

  it('emits deterministic section headers and column ordering', async () => {
    const csv = await service.exportCsv(regulator, {});
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('section,animals');
    expect(lines[1]).toBe(
      'animal_id,species,breed,sex,owner_user_id,state,lga,status,created_at'
    );
    expect(csv).toContain('section,ownership_transfers');
    expect(csv).toContain(
      'id,animal_id,from_user_id,to_user_id,transfer_type,effective_at,recorded_by,created_at'
    );
    // Placeholder sections for the L1b health wave: headers, no rows.
    expect(csv).toContain('section,health_records\r\nanimal_id,recorded_at,record_type,summary');
    expect(csv).toContain('section,movements\r\nid,animal_id,from_state,to_state,moved_at');
  });

  it('includes animal rows sorted by id with all registry fields', async () => {
    const csv = await service.exportCsv(regulator, {});
    expect(csv).toContain(
      'NG-BOV-KD-000001,cattle,White Fulani,female,farmer-1,Kaduna,Zaria,alive,2026-02-01T00:00:00.000Z'
    );
    expect(csv).toContain('NG-CAP-KN-000002,goat,Red Sokoto');
    const animalRows = csv
      .split('\r\n')
      .filter((line) => line.startsWith('NG-'));
    expect(animalRows.map((row) => row.split(',')[0])).toEqual([
      'NG-BOV-KD-000001',
      'NG-CAP-KN-000002'
    ]);
  });

  it('includes transfer rows for exported animals', async () => {
    const csv = await service.exportCsv(regulator, {});
    expect(csv).toContain(
      'transfer-1,NG-BOV-KD-000001,farmer-0,farmer-1,sale,2026-02-15T00:00:00.000Z,farmer-0,2026-02-15T00:00:00.000Z'
    );
  });

  it('applies the state filter transitively to transfers', async () => {
    const csv = await service.exportCsv(regulator, { state: 'Kano' });
    expect(csv).toContain('NG-CAP-KN-000002');
    expect(csv).not.toContain('NG-BOV-KD-000001,cattle');
    expect(csv).not.toContain('transfer-1,');
  });

  it('applies the date range filter to animals and transfers', async () => {
    const csv = await service.exportCsv(regulator, {
      from: '2026-02-10T00:00:00.000Z',
      to: '2026-03-31T00:00:00.000Z'
    });
    expect(csv).toContain('NG-CAP-KN-000002');
    expect(csv).not.toContain('NG-BOV-KD-000001,cattle');
    // Transfer predates the range even though its animal is out of range too.
    expect(csv).not.toContain('transfer-1,');

    const febOnly = await service.exportCsv(regulator, {
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-28T00:00:00.000Z'
    });
    expect(febOnly).toContain('NG-BOV-KD-000001');
    expect(febOnly).toContain('transfer-1,');
    expect(febOnly).not.toContain('NG-CAP-KN-000002');
  });

  it('quotes CSV fields containing commas', async () => {
    const transfers = createInMemoryOwnershipTransferRepository();
    const animals = createInMemoryAnimalRepository(transfers, [
      { ...kadunaAnimal, lga: 'Zaria, North' }
    ]);
    const csv = await new ComplianceService(animals, transfers).exportCsv(regulator, {});
    expect(csv).toContain('"Zaria, North"');
  });
});
