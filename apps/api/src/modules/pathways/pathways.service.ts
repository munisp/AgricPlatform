import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type {
  CampusClub,
  CampusClubMembership,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PathwayTrack,
  StageProgress,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  CAMPUS_CLUB_MEMBERSHIP_REPOSITORY,
  CAMPUS_CLUB_REPOSITORY,
  PATHWAY_ENROLMENT_REPOSITORY,
  PATHWAY_STAGE_REPOSITORY,
  PATHWAY_TEMPLATE_REPOSITORY,
  STAGE_PROGRESS_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CampusClubMembershipRepository,
  CampusClubRepository
} from '../../database/repositories/campus-club.repository.js';
import type {
  PathwayEnrolmentRepository,
  StageProgressRepository
} from '../../database/repositories/pathway-enrolment.repository.js';
import type {
  PathwayStageRepository,
  PathwayTemplateRepository
} from '../../database/repositories/pathway.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateTemplateInput {
  track: PathwayTrack;
  name: string;
  description?: string;
  stages: Array<{ title: string; requiredActions?: string[] }>;
}

/** Per-user enrolment with template + stage progress summary for `/pathway-enrolments/mine`. */
export interface MyPathwayEnrolmentSummary {
  enrolment: PathwayEnrolment;
  template: PathwayTemplate;
  stagesTotal: number;
  stagesCompleted: number;
  currentStageTitle?: string;
}

export interface CreateClubInput {
  name: string;
  institution: string;
  state: string;
  coordinatorUserId: string;
  isNyscCdsGroup?: boolean;
}

type Actor = Pick<User, 'id' | 'roles'>;

@Injectable()
export class PathwaysService {
  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(PATHWAY_TEMPLATE_REPOSITORY) private readonly templates: PathwayTemplateRepository,
    @Inject(PATHWAY_STAGE_REPOSITORY) private readonly stages: PathwayStageRepository,
    @Inject(PATHWAY_ENROLMENT_REPOSITORY) private readonly enrolments: PathwayEnrolmentRepository,
    @Inject(STAGE_PROGRESS_REPOSITORY) private readonly progress: StageProgressRepository,
    @Inject(CAMPUS_CLUB_REPOSITORY) private readonly clubs: CampusClubRepository,
    @Inject(CAMPUS_CLUB_MEMBERSHIP_REPOSITORY) private readonly memberships: CampusClubMembershipRepository
  ) {}

  // -- Templates -----------------------------------------------------------------

  async listTemplates(track?: PathwayTrack): Promise<PathwayTemplate[]> {
    return this.templates.find({ track });
  }

  async getTemplate(id: string): Promise<{ template: PathwayTemplate; stages: PathwayStage[] }> {
    const template = await this.templates.getById(id);
    return { template, stages: await this.stagesForTemplate(id) };
  }

  private async stagesForTemplate(templateId: string): Promise<PathwayStage[]> {
    const stages = await this.stages.find({ templateId });
    return stages.sort((a, b) => a.sequence - b.sequence);
  }

  async createTemplate(input: CreateTemplateInput, actorId: string): Promise<PathwayTemplate> {
    if (input.stages.length === 0) {
      throw new BadRequestException('A pathway template needs at least one stage');
    }
    const template: PathwayTemplate = {
      id: newId('pathway'),
      track: input.track,
      name: input.name,
      description: input.description,
      createdAt: new Date().toISOString()
    };
    const created = await this.templates.create(template);
    let sequence = 1;
    for (const stage of input.stages) {
      await this.stages.create({
        id: newId('stage'),
        templateId: created.id,
        title: stage.title,
        sequence: sequence++,
        requiredActions: stage.requiredActions ?? []
      });
    }
    await this.domainEvents.publish('pathways.template.created', { templateId: created.id }, actorId);
    return created;
  }

  // -- Enrolment & stage progression -----------------------------------------------

  async enrol(templateId: string, userId: string): Promise<PathwayEnrolment> {
    await this.templates.getById(templateId);
    const stages = await this.stagesForTemplate(templateId);
    if (await this.enrolments.findOne({ templateId, userId, status: 'active' })) {
      throw new ConflictException('User already has an active enrolment on this pathway');
    }
    const enrolment: PathwayEnrolment = {
      id: newId('pathway-enrolment'),
      templateId,
      userId,
      status: 'active',
      currentStageId: stages[0]?.id,
      enrolledAt: new Date().toISOString()
    };
    const created = await this.enrolments.create(enrolment);
    if (stages[0]) {
      await this.progress.create({
        id: newId('stage-progress'),
        enrolmentId: created.id,
        stageId: stages[0].id,
        status: 'pending'
      });
    }
    await this.domainEvents.publish('pathways.enrolment.started', { enrolmentId: created.id, templateId }, userId);
    return created;
  }

  async getEnrolment(id: string): Promise<{ enrolment: PathwayEnrolment; progress: StageProgress[] }> {
    const enrolment = await this.enrolments.getById(id);
    return { enrolment, progress: await this.progress.find({ enrolmentId: id }) };
  }

  /** Own enrolments (ownership-scoped by user id) with template and stage progress summary. */
  async listMyEnrolments(userId: string): Promise<MyPathwayEnrolmentSummary[]> {
    const enrolments = await this.enrolments.find({ userId });
    const summaries: MyPathwayEnrolmentSummary[] = [];
    for (const enrolment of enrolments) {
      const template = await this.templates.findById(enrolment.templateId);
      if (!template) {
        continue; // dangling enrolment (template removed) — never leak, just skip
      }
      const stages = await this.stagesForTemplate(enrolment.templateId);
      const progress = await this.progress.find({ enrolmentId: enrolment.id });
      summaries.push({
        enrolment,
        template,
        stagesTotal: stages.length,
        stagesCompleted: progress.filter((entry) => entry.status === 'completed').length,
        currentStageTitle: stages.find((stage) => stage.id === enrolment.currentStageId)?.title
      });
    }
    return summaries.sort((a, b) => b.enrolment.enrolledAt.localeCompare(a.enrolment.enrolledAt));
  }

  /** Completes the current stage (evidence required) and advances to the next. */
  async completeCurrentStage(
    enrolmentId: string,
    evidence: string,
    actor: Actor
  ): Promise<PathwayEnrolment> {
    const enrolment = await this.enrolments.getById(enrolmentId);
    if (actor.id !== enrolment.userId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Members may only progress their own pathway');
    }
    if (enrolment.status !== 'active') {
      throw new ConflictException('Pathway enrolment is not active');
    }
    if (!evidence || evidence.trim() === '') {
      throw new BadRequestException('Completion evidence is required');
    }
    if (!enrolment.currentStageId) {
      throw new ConflictException('Pathway has no current stage');
    }
    const currentProgress = await this.progress.findOne({
      enrolmentId,
      stageId: enrolment.currentStageId
    });
    if (!currentProgress) {
      throw new ConflictException('No progress record for the current stage');
    }
    if (currentProgress.status === 'completed') {
      throw new ConflictException('Current stage is already completed');
    }
    await this.progress.update(currentProgress.id, {
      status: 'completed',
      evidence,
      completedAt: new Date().toISOString()
    });
    const stages = await this.stagesForTemplate(enrolment.templateId);
    const currentIndex = stages.findIndex((stage) => stage.id === enrolment.currentStageId);
    const next = stages[currentIndex + 1];
    let patch: Partial<PathwayEnrolment>;
    if (next) {
      await this.progress.create({
        id: newId('stage-progress'),
        enrolmentId,
        stageId: next.id,
        status: 'pending'
      });
      patch = { currentStageId: next.id };
    } else {
      patch = { status: 'completed', completedAt: new Date().toISOString() };
    }
    const updated = await this.enrolments.update(enrolmentId, patch);
    await this.domainEvents.publish(
      'pathways.stage.completed',
      { enrolmentId, stageId: enrolment.currentStageId, completed: !next },
      actor.id
    );
    return updated;
  }

  // -- Campus clubs ------------------------------------------------------------------

  async listClubs(filter: {
    state?: string;
    institution?: string;
    isNyscCdsGroup?: boolean;
  }): Promise<CampusClub[]> {
    return this.clubs.find(filter);
  }

  async getClub(id: string): Promise<{ club: CampusClub; members: CampusClubMembership[] }> {
    const club = await this.clubs.getById(id);
    return { club, members: await this.memberships.find({ clubId: id }) };
  }

  async createClub(input: CreateClubInput, actorId: string): Promise<CampusClub> {
    const club: CampusClub = {
      id: newId('club'),
      name: input.name,
      institution: input.institution,
      state: input.state,
      coordinatorUserId: input.coordinatorUserId,
      isNyscCdsGroup: input.isNyscCdsGroup ?? false,
      memberCount: 0,
      createdAt: new Date().toISOString()
    };
    const created = await this.clubs.create(club);
    await this.joinClub(created.id, input.coordinatorUserId, 'coordinator');
    await this.domainEvents.publish('pathways.club.created', { clubId: created.id }, actorId);
    return created;
  }

  async joinClub(
    clubId: string,
    userId: string,
    role: CampusClubMembership['role'] = 'member'
  ): Promise<CampusClubMembership> {
    await this.clubs.getById(clubId);
    if (await this.memberships.findOne({ clubId, userId })) {
      throw new ConflictException('User is already a member of this club');
    }
    const membership: CampusClubMembership = {
      id: newId('club-member'),
      clubId,
      userId,
      role,
      joinedAt: new Date().toISOString()
    };
    const created = await this.memberships.create(membership);
    const club = await this.clubs.getById(clubId);
    await this.clubs.update(clubId, { memberCount: club.memberCount + 1 });
    await this.domainEvents.publish('pathways.club.member_joined', { clubId, userId }, userId);
    return created;
  }
}
