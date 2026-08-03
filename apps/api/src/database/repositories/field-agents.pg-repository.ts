import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  AgentActivityLogEntry,
  AgentAssignment,
  AgentAssignmentStatus
} from '@agric-platform/shared';
import { mapPgError, ts } from '../pg/pg-repository.base.js';
import type {
  AgentActivityCriteria,
  AgentActivityLogRepository,
  AgentAssignmentCriteria,
  AgentAssignmentRepository
} from './field-agents.repository.js';

/**
 * PostgreSQL implementations of the Wave AGENTS field-agent ports (migration
 * 023, schema `agents`). Hand-rolled SQL mirrors the in-memory
 * implementations in field-agents.repository.ts one-to-one.
 */

// ---------------------------------------------------------------------------
// agents.agent_assignments
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  agent_user_id: string;
  farmer_user_id: string | null;
  chapter_id: string | null;
  state: string;
  lga: string;
  ward: string | null;
  purpose: string;
  target_count: number;
  completed_count: number;
  status: string;
  due_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function assignmentFromRow(row: AssignmentRow): AgentAssignment {
  return {
    id: row.id,
    agentUserId: row.agent_user_id,
    ...(row.farmer_user_id ? { farmerUserId: row.farmer_user_id } : {}),
    ...(row.chapter_id ? { chapterId: row.chapter_id } : {}),
    state: row.state,
    lga: row.lga,
    ...(row.ward ? { ward: row.ward } : {}),
    purpose: row.purpose,
    targetCount: row.target_count,
    completedCount: row.completed_count,
    status: row.status as AgentAssignmentStatus,
    ...(row.due_at ? { dueAt: ts(row.due_at) } : {}),
    createdBy: row.created_by,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

const ASSIGNMENT_COLUMNS =
  'id, agent_user_id, farmer_user_id, chapter_id, state, lga, ward, purpose, ' +
  'target_count, completed_count, status, due_at, created_by, created_at, updated_at';

/** Column whitelist for update patches. */
const ASSIGNMENT_MUTABLE_COLUMNS: Record<string, string> = {
  farmerUserId: 'farmer_user_id',
  chapterId: 'chapter_id',
  state: 'state',
  lga: 'lga',
  ward: 'ward',
  purpose: 'purpose',
  targetCount: 'target_count',
  completedCount: 'completed_count',
  status: 'status',
  dueAt: 'due_at',
  updatedAt: 'updated_at'
};

/** Criteria → whitelisted WHERE fragments (mirrors agentAssignmentMatcher). */
const ASSIGNMENT_FILTERS: Record<string, string> = {
  agentUserId: 'agent_user_id',
  farmerUserId: 'farmer_user_id',
  chapterId: 'chapter_id',
  status: 'status',
  state: 'state',
  lga: 'lga',
  createdBy: 'created_by'
};

export class PgAgentAssignmentRepository implements AgentAssignmentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(assignment: AgentAssignment): Promise<AgentAssignment> {
    try {
      await this.pool.query(
        `INSERT INTO agents.agent_assignments
           (id, agent_user_id, farmer_user_id, chapter_id, state, lga, ward, purpose,
            target_count, completed_count, status, due_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          assignment.id,
          assignment.agentUserId,
          assignment.farmerUserId ?? null,
          assignment.chapterId ?? null,
          assignment.state,
          assignment.lga,
          assignment.ward ?? null,
          assignment.purpose,
          assignment.targetCount,
          assignment.completedCount,
          assignment.status,
          assignment.dueAt ?? null,
          assignment.createdBy,
          assignment.createdAt,
          assignment.updatedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return assignment;
  }

  async findById(id: string): Promise<AgentAssignment | undefined> {
    const result = await this.pool.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM agents.agent_assignments WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? assignmentFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<AgentAssignment> {
    const assignment = await this.findById(id);
    if (!assignment) {
      throw new NotFoundException(`Agent assignment '${id}' not found`);
    }
    return assignment;
  }

  async find(criteria: AgentAssignmentCriteria): Promise<AgentAssignment[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(ASSIGNMENT_FILTERS)) {
      const value = (criteria as Record<string, unknown>)[key];
      if (value !== undefined) {
        params.push(value);
        clauses.push(`${column} = $${params.length}`);
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM agents.agent_assignments ${where}
       ORDER BY created_at, id`,
      params
    );
    return result.rows.map(assignmentFromRow);
  }

  async update(id: string, patch: Partial<AgentAssignment>): Promise<AgentAssignment> {
    const entries = Object.entries(patch)
      .map(([key, value]) => ({ column: ASSIGNMENT_MUTABLE_COLUMNS[key], value }))
      .filter((entry) => entry.column !== undefined);
    if (entries.length === 0) {
      return this.getById(id);
    }
    const assignments = entries.map((entry, index) => `${entry.column} = $${index + 2}`).join(', ');
    const result = await this.pool.query(
      `UPDATE agents.agent_assignments SET ${assignments} WHERE id = $1
       RETURNING ${ASSIGNMENT_COLUMNS}`,
      [id, ...entries.map((entry) => entry.value ?? null)]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Agent assignment '${id}' not found`);
    }
    return assignmentFromRow(result.rows[0]);
  }

  async listAgentIds(): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT agent_user_id FROM agents.agent_assignments ORDER BY agent_user_id`
    );
    return result.rows.map((row: { agent_user_id: string }) => row.agent_user_id);
  }
}

export function createPgAgentAssignmentRepository(pool: pg.Pool): PgAgentAssignmentRepository {
  return new PgAgentAssignmentRepository(pool);
}

// ---------------------------------------------------------------------------
// agents.agent_activity_log (append-only)
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  agent_user_id: string;
  assignment_id: string | null;
  action: string;
  subject_user_id: string | null;
  meta: Record<string, unknown> | string | null;
  created_at: Date | string;
}

function activityFromRow(row: ActivityRow): AgentActivityLogEntry {
  const meta =
    row.meta === null
      ? {}
      : typeof row.meta === 'string'
        ? (JSON.parse(row.meta) as Record<string, unknown>)
        : row.meta;
  return {
    id: row.id,
    agentUserId: row.agent_user_id,
    ...(row.assignment_id ? { assignmentId: row.assignment_id } : {}),
    action: row.action,
    ...(row.subject_user_id ? { subjectUserId: row.subject_user_id } : {}),
    meta,
    createdAt: ts(row.created_at)
  };
}

const ACTIVITY_COLUMNS = 'id, agent_user_id, assignment_id, action, subject_user_id, meta, created_at';

const ACTIVITY_FILTERS: Record<string, string> = {
  agentUserId: 'agent_user_id',
  assignmentId: 'assignment_id',
  subjectUserId: 'subject_user_id',
  action: 'action'
};

export class PgAgentActivityLogRepository implements AgentActivityLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(entry: AgentActivityLogEntry): Promise<AgentActivityLogEntry> {
    try {
      await this.pool.query(
        `INSERT INTO agents.agent_activity_log
           (id, agent_user_id, assignment_id, action, subject_user_id, meta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.id,
          entry.agentUserId,
          entry.assignmentId ?? null,
          entry.action,
          entry.subjectUserId ?? null,
          JSON.stringify(entry.meta ?? {}),
          entry.createdAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return entry;
  }

  async find(criteria: AgentActivityCriteria): Promise<AgentActivityLogEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(ACTIVITY_FILTERS)) {
      const value = (criteria as Record<string, unknown>)[key];
      if (value !== undefined) {
        params.push(value);
        clauses.push(`${column} = $${params.length}`);
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${ACTIVITY_COLUMNS} FROM agents.agent_activity_log ${where}
       ORDER BY created_at, id`,
      params
    );
    return result.rows.map(activityFromRow);
  }
}

export function createPgAgentActivityLogRepository(pool: pg.Pool): PgAgentActivityLogRepository {
  return new PgAgentActivityLogRepository(pool);
}
