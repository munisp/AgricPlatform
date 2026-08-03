import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AGENT_CASE_STATUSES, type AgentCaseStatus } from '../../database/repositories/voice.repository.js';
import { VoiceService, type StartVoiceSessionInput, type VoiceTurnInput } from './voice.service.js';

@ApiTags('voice')
@UseGuards(RolesGuard)
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('sessions')
  @Authenticated()
  @ApiOperation({
    summary:
      'Start a voice-agronomist session (IVR | USSD | ASSISTED). Farmer identity resolves via the phone directory; locale is captured but responses are en-only this wave.'
  })
  async startSession(@CurrentUser() actor: User | null, @Body() body: StartVoiceSessionInput) {
    return { data: await this.voice.startSession(actor, body) };
  }

  @Post('sessions/:id/turns')
  @Authenticated()
  @ApiOperation({
    summary:
      'Submit one utterance (text, audioUrl for ASR, or ussdInput for menus); returns the grounded reply or the safe fallback with auto-escalation.'
  })
  async addTurn(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() body: VoiceTurnInput
  ) {
    return { data: await this.voice.handleTurn(actor, id, body ?? {}) };
  }

  @Get('sessions/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Session detail with the full transcript turns.' })
  async getSession(@CurrentUser() actor: User | null, @Param('id') id: string) {
    return { data: await this.voice.getSessionTranscript(actor, id) };
  }

  @Post('sessions/:id/escalate')
  @Authenticated()
  @ApiOperation({
    summary: 'Manually escalate a session to a human agronomist (idempotent per session).'
  })
  async escalate(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() body?: { reason?: 'requested' | 'low_confidence' | 'no_grounding' }
  ) {
    return { data: await this.voice.escalate(actor, id, body?.reason ?? 'requested') };
  }

  @Get('agent-cases')
  @Roles('agronomist', 'admin')
  @ApiOperation({
    summary: 'Agent escalation queue (agronomist/admin). Ordered by SLA deadline.'
  })
  async listCases(
    @CurrentUser() actor: User | null,
    @Query('status') status?: string,
    @Query('overdue') overdue?: string
  ) {
    const parsed = AGENT_CASE_STATUSES.includes(status as AgentCaseStatus)
      ? (status as AgentCaseStatus)
      : undefined;
    return {
      data: await this.voice.listAgentCases(actor, {
        ...(parsed ? { status: parsed } : {}),
        overdueOnly: overdue === 'true'
      })
    };
  }

  @Get('agent-cases/:id')
  @Roles('agronomist', 'admin')
  @ApiOperation({
    summary: 'Agent case detail: case, session and transcript with RAG citations.'
  })
  async getCase(@CurrentUser() actor: User | null, @Param('id') id: string) {
    return { data: await this.voice.getAgentCase(actor, id) };
  }

  @Post('agent-cases/:id/respond')
  @Roles('agronomist', 'admin')
  @ApiOperation({
    summary: 'Agent first response (self-assigns when open); resolve=true closes the case and session.'
  })
  async respond(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() body: { response: string; resolve?: boolean }
  ) {
    return { data: await this.voice.respondToCase(actor, id, body ?? { response: '' }) };
  }
}
