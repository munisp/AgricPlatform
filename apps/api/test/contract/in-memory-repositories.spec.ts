import { describe } from 'vitest';
import { InMemoryCertificateRepository } from '../../src/database/repositories/certificate.repository.js';
import { InMemoryConsentRepository } from '../../src/database/repositories/consent.repository.js';
import { InMemoryCourseRepository } from '../../src/database/repositories/course.repository.js';
import { InMemoryEnrolmentRepository } from '../../src/database/repositories/enrolment.repository.js';
import {
  InMemoryCropPlantingRepository,
  InMemoryFarmExpenseRepository,
  InMemoryFarmPlotRepository,
  InMemoryHarvestRecordRepository
} from '../../src/database/repositories/farms.repository.js';
import { InMemoryForumTopicRepository } from '../../src/database/repositories/forum-topic.repository.js';
import { InMemoryListingRepository } from '../../src/database/repositories/listing.repository.js';
import { InMemoryOpportunityRepository } from '../../src/database/repositories/opportunity.repository.js';
import { InMemoryOrderRepository } from '../../src/database/repositories/order.repository.js';
import { InMemoryTopicFlagRepository } from '../../src/database/repositories/topic-flag.repository.js';
import { InMemoryUserRepository } from '../../src/database/repositories/user.repository.js';
import { contractCases } from './cases.js';
import { runRepositoryContract } from './repository.contract.js';

/**
 * Repository contract suite against the in-memory implementations
 * (always on). Repositories are constructed with empty seeds so contract
 * records stay isolated from demo data.
 */
describe('in-memory repository contracts', () => {
  const bind = (name: string): unknown => {
    switch (name) {
      case 'user':
        return new InMemoryUserRepository();
      case 'course':
        return new InMemoryCourseRepository();
      case 'enrolment':
        return new InMemoryEnrolmentRepository();
      case 'certificate':
        return new InMemoryCertificateRepository();
      case 'forumTopic':
        return new InMemoryForumTopicRepository();
      case 'topicFlag':
        return new InMemoryTopicFlagRepository();
      case 'opportunity':
        return new InMemoryOpportunityRepository();
      case 'listing':
        return new InMemoryListingRepository();
      case 'order':
        return new InMemoryOrderRepository();
      case 'consent':
        return new InMemoryConsentRepository();
      case 'farmPlot':
        return new InMemoryFarmPlotRepository();
      case 'cropPlanting':
        return new InMemoryCropPlantingRepository();
      case 'harvestRecord':
        return new InMemoryHarvestRecordRepository();
      case 'farmExpense':
        return new InMemoryFarmExpenseRepository();
      default:
        throw new Error(`unknown contract repo ${name}`);
    }
  };
  for (const testCase of contractCases(bind)) {
    runRepositoryContract(testCase);
  }
});
