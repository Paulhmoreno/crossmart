import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  AgentConfigsService,
  type AgentConfigView,
  type ApproveKnowledgeProposalInput,
  type CreateKnowledgeProposalInput,
  type SalesChannelContext,
  type SalesConversationDetail,
  type SalesConversationSummary,
  type SalesEventView,
  type SalesKnowledgeEntryView,
  SalesKnowledgeService,
  type SalesLearningProposalView,
  type SalesOperationalOverview,
  SalesAgentService,
  type UpdateAgentConfigInput,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../auth/auth.constants.js';
import { CurrentActor } from '../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

@ApiTags('Commercial Agents')
@Controller(`workspaces/:${WORKSPACE_ID_PARAM}`)
export class CommercialAgentsController {
  constructor(
    private readonly configs: AgentConfigsService,
    private readonly salesAgent: SalesAgentService,
    private readonly knowledge: SalesKnowledgeService,
  ) {}

  @Get('internal-agents')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List internal agent configurations (Crossmart Agent & Sales Agent)' })
  listAgentConfigs(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<AgentConfigView[]> {
    return this.configs.list(workspaceId);
  }

  @Put('internal-agents/:agentKey')
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({
    summary: 'Update AI connection/model assignment and settings for an internal agent',
  })
  async updateAgentConfig(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('agentKey') agentKey: string,
    @Body() body: UpdateAgentConfigInput,
    @CurrentActor() actor: Actor,
  ): Promise<AgentConfigView> {
    const saved = await this.configs.update(workspaceId, agentKey, body, actor);
    if (agentKey === 'sales') {
      await this.knowledge.recordEvent(workspaceId, {
        type: 'config_changed',
        summary: `Sales Agent settings updated (${saved.salesMode})`,
        details: {
          salesMode: saved.salesMode,
          model: saved.model,
          authorizedInboxCount: saved.authorizedInboxIds.length,
        },
      });
    }
    return saved;
  }

  @Post('internal-agents/sales/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Immediately stop automatic Sales Agent responses' })
  async stopSalesAgent(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @CurrentActor() actor: Actor,
  ): Promise<AgentConfigView> {
    const saved = await this.configs.stopSalesAgent(workspaceId, actor);
    await this.knowledge.recordEvent(workspaceId, {
      type: 'config_changed',
      summary: 'Automatic Sales Agent responses stopped',
      details: { salesMode: saved.salesMode },
    });
    return saved;
  }

  @Get('sales-agent/overview')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Read real operational overview, verified nodes, metrics, and events' })
  getSalesOverview(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<SalesOperationalOverview> {
    return this.salesAgent.getOperationalOverview(workspaceId);
  }

  @Get('sales-agent/events')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List real commercial and operational Sales Agent events' })
  listSalesEvents(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<SalesEventView[]> {
    return this.knowledge.listEvents(workspaceId);
  }

  @Get('sales-agent/conversations')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List Sales Agent conversations (isolated by source)' })
  listSalesConversations(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Query('source') source?: string,
  ): Promise<SalesConversationSummary[]> {
    return this.salesAgent.listConversations(workspaceId, source);
  }

  @Post('sales-agent/conversations')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Create a supervisor or simulated buyer conversation' })
  createSalesConversation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body()
    body: {
      source?: 'supervisor' | 'simulator';
      title?: string;
      context?: SalesChannelContext;
    },
    @CurrentActor() actor: Actor,
  ): Promise<SalesConversationDetail> {
    return this.salesAgent.createConversation(workspaceId, actor.userId, body);
  }

  @Get('sales-agent/conversations/:conversationId')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Read a Sales Agent conversation and its messages' })
  getSalesConversation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<SalesConversationDetail> {
    return this.salesAgent.getConversation(workspaceId, conversationId);
  }

  @Post('sales-agent/conversations/:conversationId/messages')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Send a supervisor or simulated buyer message to the Sales Agent' })
  sendSalesMessage(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: { text: string; context?: SalesChannelContext },
  ): Promise<SalesConversationDetail> {
    return this.salesAgent.sendMessage(workspaceId, conversationId, body.text, body.context);
  }

  @Delete('sales-agent/conversations/:conversationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Delete a Sales Agent conversation' })
  deleteSalesConversation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<void> {
    return this.salesAgent.deleteConversation(workspaceId, conversationId);
  }

  // ─── Commercial Knowledge & Supervised Learning ─────────────────────────────

  @Get('sales-agent/knowledge')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List approved active commercial knowledge entries' })
  listKnowledge(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<SalesKnowledgeEntryView[]> {
    return this.knowledge.listEntries(workspaceId);
  }

  @Put('sales-agent/knowledge/:entryId')
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Update an approved commercial knowledge entry (bumps version)' })
  updateKnowledge(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() body: { category?: string; scope?: string; title?: string; content?: string },
    @CurrentActor() actor: Actor,
  ): Promise<SalesKnowledgeEntryView> {
    return this.knowledge.updateEntry(workspaceId, entryId, body, actor.userId);
  }

  @Delete('sales-agent/knowledge/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Archive a commercial knowledge entry' })
  archiveKnowledge(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<void> {
    return this.knowledge.archiveEntry(workspaceId, entryId);
  }

  @Get('sales-agent/learning-proposals')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List supervised learning proposals' })
  listLearningProposals(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<SalesLearningProposalView[]> {
    return this.knowledge.listProposals(workspaceId);
  }

  @Post('sales-agent/learning-proposals')
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Create a supervised learning proposal (pending human approval)' })
  createLearningProposal(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: CreateKnowledgeProposalInput,
  ): Promise<SalesLearningProposalView> {
    return this.knowledge.createProposal(workspaceId, body);
  }

  @Post('sales-agent/learning-proposals/:proposalId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Approve a learning proposal into persistent versioned knowledge' })
  approveLearningProposal(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ApproveKnowledgeProposalInput,
    @CurrentActor() actor: Actor,
  ): Promise<{ proposal: SalesLearningProposalView; entry: SalesKnowledgeEntryView }> {
    return this.knowledge.approveProposal(workspaceId, proposalId, actor.userId, body);
  }

  @Post('sales-agent/learning-proposals/:proposalId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Reject a pending learning proposal' })
  rejectLearningProposal(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @CurrentActor() actor: Actor,
  ): Promise<SalesLearningProposalView> {
    return this.knowledge.rejectProposal(workspaceId, proposalId, actor.userId);
  }
}
