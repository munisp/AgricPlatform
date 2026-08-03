import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  AgentActivityLogEntry,
  AgentAssignment,
  AgentAssignmentStatus
} from '@agric-platform/shared';

/**
 * Wave AGENTS field-agent (enumerator) persistence (migration 023, schema
 * `agents`). Enumerators are field staff who capture farmer data on behalf of
 * farmer users; these ports back the field-agents module (assignment
 * lifecycle, per-agent productivity, append-only activity trail). Both
 * implementations (in-memory below, pg in field-agents.pg-repository.ts)
 * must stay behaviourally identical.
 */

// ---------------------------------------------------------------------------
// Agent assignments (agents.agent_assignments)
// ---------------------------------------------------------------------------

export interface AgentAssignmentCriteria {
  agentUserId?: string;
  farmerUserId?: string;
  chapterId?: string;
  status?: AgentAssignmentStatus;
  state?: string;
  lga?: string;
  createdBy?: string;
}

export interface AgentAssignmentRepository {
  create(assignment: AgentAssignment): Promise<AgentAssignment>;
  findById(id: string): Promise<AgentAssignment | undefined>;
  getById(id: string): Promise<AgentAssignment>;
  find(criteria: AgentAssignmentCriteria): Promise<AgentAssignment[]>;
  /**
   * Applies a whitelisted patch (completed_count/status/updated_at flow
   * through here). Throws NotFoundException when the id does not exist.
   */
  update(id: string, patch: Partial<AgentAssignment>): Promise<AgentAssignment>;
  /** Distinct agent ids that have at least one assignment. */
  listAgentIds(): Promise<string[]>;
}

export function agentAssignmentMatcher(
  criteria: AgentAssignmentCriteria
): (assignment: AgentAssignment) => boolean {
  return (assignment) =>
    (!criteria.agentUserId || assignment.agentUserId === criteria.agentUserId) &&
    (!criteria.farmerUserId || assignment.farmerUserId === criteria.farmerUserId) &&
    (!criteria.chapterId || assignment.chapterId === criteria.chapterId) &&
    (!criteria.status || assignment.status === criteria.status) &&
    (!criteria.state || assignment.state === criteria.state) &&
    (!criteria.lga || assignment.lga === criteria.lga) &&
    (!criteria.createdBy || assignment.createdBy === criteria.createdBy);
}

// ---------------------------------------------------------------------------
// Agent activity log (agents.agent_activity_log) — append-only
// ---------------------------------------------------------------------------

export interface AgentActivityCriteria {
  agentUserId?: string;
  assignmentId?: string;
  subjectUserId?: string;
  action?: string;
}

export interface AgentActivityLogRepository {
  append(entry: AgentActivityLogEntry): Promise<AgentActivityLogEntry>;
  find(criteria: AgentActivityCriteria): Promise<AgentActivityLogEntry[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementations (default when DATABASE_URL is not configured)
// ---------------------------------------------------------------------------

export class InMemoryAgentAssignmentRepository implements AgentAssignmentRepository {
  private readonly assignments = new Map<string, AgentAssignment>();

  constructor(seed: readonly AgentAssignment[] = []) {
    for (const assignment of seed) {
      this.assignments.set(assignment.id, { ...assignment });
    }
  }

  async create(assignment: AgentAssignment): Promise<AgentAssignment> {
    if (this.assignments.has(assignment.id)) {
      throw new BadRequestException(`Agent assignment '${assignment.id}' already exists`);
    }
    this.assignments.set(assignment.id, { ...assignment });
    return { ...assignment };
  }

  async findById(id: string): Promise<AgentAssignment | undefined> {
    const assignment = this.assignments.get(id);
    return assignment ? { ...assignment } : undefined;
  }

  async getById(id: string): Promise<AgentAssignment> {
    const assignment = await this.findById(id);
    if (!assignment) {
      throw new NotFoundException(`Agent assignment '${id}' not found`);
    }
    return assignment;
  }

  async find(criteria: AgentAssignmentCriteria): Promise<AgentAssignment[]> {
    const matches = agentAssignmentMatcher(criteria);
    return [...this.assignments.values()]
      .filter(matches)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((assignment) => ({ ...assignment }));
  }

  async update(id: string, patch: Partial<AgentAssignment>): Promise<AgentAssignment> {
    const assignment = this.assignments.get(id);
    if (!assignment) {
      throw new NotFoundException(`Agent assignment '${id}' not found`);
    }
    const updated = { ...assignment, ...patch, id: assignment.id };
    this.assignments.set(id, updated);
    return { ...updated };
  }

  async listAgentIds(): Promise<string[]> {
    return [...new Set([...this.assignments.values()].map((a) => a.agentUserId))].sort();
  }
}

export function createInMemoryAgentAssignmentRepository(): InMemoryAgentAssignmentRepository {
  return new InMemoryAgentAssignmentRepository();
}

export class InMemoryAgentActivityLogRepository implements AgentActivityLogRepository {
  private readonly entries = new Map<string, AgentActivityLogEntry>();

  async append(entry: AgentActivityLogEntry): Promise<AgentActivityLogEntry> {
    if (this.entries.has(entry.id)) {
      throw new BadRequestException(`Agent activity entry '${entry.id}' already exists`);
    }
    this.entries.set(entry.id, { ...entry, meta: { ...entry.meta } });
    return { ...entry, meta: { ...entry.meta } };
  }

  async find(criteria: AgentActivityCriteria): Promise<AgentActivityLogEntry[]> {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (!criteria.agentUserId || entry.agentUserId === criteria.agentUserId) &&
          (!criteria.assignmentId || entry.assignmentId === criteria.assignmentId) &&
          (!criteria.subjectUserId || entry.subjectUserId === criteria.subjectUserId) &&
          (!criteria.action || entry.action === criteria.action)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((entry) => ({ ...entry, meta: { ...entry.meta } }));
  }
}

export function createInMemoryAgentActivityLogRepository(): InMemoryAgentActivityLogRepository {
  return new InMemoryAgentActivityLogRepository();
}
