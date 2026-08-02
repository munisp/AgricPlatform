import type { VaultDocument } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedVaultDocuments } from '../seed-data.js';

export interface DocumentCriteria {
  userId?: string;
  status?: VaultDocument['status'];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DocumentRepository extends AsyncRepository<VaultDocument, DocumentCriteria> {}

export function documentMatcher(criteria: DocumentCriteria): (document: VaultDocument) => boolean {
  return (document) =>
    (!criteria.userId || document.userId === criteria.userId) &&
    (!criteria.status || document.status === criteria.status);
}

export class InMemoryDocumentRepository
  extends InMemoryRepository<VaultDocument, DocumentCriteria>
  implements DocumentRepository
{
  constructor(seed: readonly VaultDocument[] = []) {
    super(seed, documentMatcher);
  }
}

export function createInMemoryDocumentRepository(): InMemoryDocumentRepository {
  return new InMemoryDocumentRepository(seedVaultDocuments);
}
