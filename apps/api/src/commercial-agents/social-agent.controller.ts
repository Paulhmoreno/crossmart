import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  SocialAgentService,
  SocialIntelligenceService,
  type VisualCompositionInput,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../auth/auth.constants.js';
import { CurrentActor } from '../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { openAgentSseStream } from './agent-sse.helper.js';

@ApiTags('Social Marketing Agent')
@Controller('workspaces/:workspaceId/social-agent')
export class SocialAgentController {
  constructor(
    private readonly agent: SocialAgentService,
    private readonly intelligence: SocialIntelligenceService,
  ) {}

  @Get('overview')
  @RequirePermission(WorkspacePermission.ViewProducts)
  @ApiOperation({ summary: 'Operational overview, React Flow nodes, opportunities, items, and events' })
  overview(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.agent.getOperationalOverview(workspaceId);
  }

  @Post('supervisor/chat')
  @RequirePermission(WorkspacePermission.EditProducts)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Natural-language conversation with the Social Agent Supervisor' })
  chat(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body()
    body: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      locale?: string;
    },
  ) {
    return this.agent.chatWithSupervisor(workspaceId, body);
  }

  @Post('supervisor/stream')
  @RequirePermission(WorkspacePermission.EditProducts)
  @ApiOperation({ summary: 'Streaming SSE conversation with the Social Agent Supervisor' })
  async streamChat(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body()
    body: {
      message: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      locale?: string;
    },
    @Res() res: Response,
  ) {
    const stream = openAgentSseStream(res);
    try {
      await this.agent.streamSupervisorTurn(workspaceId, body, stream.sink, stream.signal);
    } finally {
      stream.close();
    }
  }

  @Post('supervisor/cancel/:turnId')
  @RequirePermission(WorkspacePermission.EditProducts)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an active Social Agent Supervisor turn' })
  cancelTurn(@Param('turnId') turnId: string) {
    return { cancelled: this.agent.cancelSupervisorTurn(turnId) };
  }

  @Put('policy')
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Update Social Agent autonomy mode, pause state, and creative budget limits' })
  updatePolicy(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.intelligence.updatePolicy(workspaceId, body);
  }

  @Get('items')
  @RequirePermission(WorkspacePermission.ViewProducts)
  listItems(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Query('status') status?: string,
  ) {
    return this.intelligence.listContentItems(workspaceId, status);
  }

  @Post('items')
  @RequirePermission(WorkspacePermission.EditProducts)
  createItem(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body()
    body: {
      kind?: string;
      title: string;
      objective?: string;
      pillar?: string;
      caption?: string;
      productionMode?: string;
      productionSpec?: Record<string, unknown>;
      productIds?: string[];
      creativeProfileId?: string | null;
      targetChannelIds?: string[];
    },
  ) {
    return this.intelligence.createContentItem(workspaceId, body);
  }

  @Patch('items/:itemId')
  @RequirePermission(WorkspacePermission.EditProducts)
  updateItem(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.intelligence.updateContentItem(workspaceId, itemId, body);
  }

  @Post('items/:itemId/approve')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  approveItem(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.intelligence.approveContentItem(workspaceId, itemId, actor);
  }

  @Post('items/:itemId/reject')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  rejectItem(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: { reason?: string },
  ) {
    return this.intelligence.rejectContentItem(workspaceId, itemId, body?.reason);
  }

  @Post('items/:itemId/trypost')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  pushToTryPost(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: { mode: 'idea' | 'draft' | 'scheduled'; channelIds?: string[]; scheduledAt?: string },
  ) {
    return this.intelligence.pushToTryPost(workspaceId, itemId, body);
  }

  @Post('compose-svg')
  @RequirePermission(WorkspacePermission.EditProducts)
  @HttpCode(HttpStatus.OK)
  composeSvg(@Body() body: VisualCompositionInput) {
    return this.intelligence.generateSvgComposition(body);
  }

  @Get('profiles')
  @RequirePermission(WorkspacePermission.ViewProducts)
  listProfiles(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.intelligence.listCreativeProfiles(workspaceId);
  }

  @Post('profiles')
  @RequirePermission(WorkspacePermission.EditProducts)
  createProfile(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body()
    body: {
      name: string;
      objective?: string;
      instructions: string;
      references?: string[];
      restrictions?: string[];
      assets?: Array<{ name: string; kind: string; url?: string }>;
    },
  ) {
    return this.intelligence.createCreativeProfile(workspaceId, body);
  }

  @Delete('profiles/:profileId')
  @RequirePermission(WorkspacePermission.EditProducts)
  archiveProfile(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('profileId', ParseUUIDPipe) profileId: string,
  ) {
    return this.intelligence.archiveCreativeProfile(workspaceId, profileId);
  }
}
