import type { Certificate } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedCertificates } from '../seed-data.js';

export interface CertificateCriteria {
  userId?: string;
  verificationCode?: string;
}

export interface CertificateRepository extends AsyncRepository<Certificate, CertificateCriteria> {
  /**
   * Allocates the next `NYFN-CERT-YYYY-####` verification code. The pg
   * implementation reads learning.certificate_counters with
   * UPDATE … RETURNING so concurrent issuances cannot collide.
   */
  allocateVerificationCode(): Promise<string>;
}

export function certificateMatcher(
  criteria: CertificateCriteria
): (certificate: Certificate) => boolean {
  return (certificate) =>
    (!criteria.userId || certificate.userId === criteria.userId) &&
    (!criteria.verificationCode || certificate.verificationCode === criteria.verificationCode);
}

export class InMemoryCertificateRepository
  extends InMemoryRepository<Certificate, CertificateCriteria>
  implements CertificateRepository
{
  constructor(
    seed: readonly Certificate[] = [],
    private sequence = 2 // seed data already holds NYFN-CERT-2026-0001
  ) {
    super(seed, certificateMatcher);
  }

  async allocateVerificationCode(): Promise<string> {
    const year = new Date().getFullYear();
    const code = `NYFN-CERT-${year}-${String(this.sequence).padStart(4, '0')}`;
    this.sequence += 1;
    return code;
  }
}

export function createInMemoryCertificateRepository(): InMemoryCertificateRepository {
  return new InMemoryCertificateRepository(seedCertificates);
}
