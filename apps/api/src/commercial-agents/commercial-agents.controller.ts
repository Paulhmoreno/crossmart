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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  AgentConfigsService,
  type AgentConfigView,
  type SalesConversationDetail,
  type SalesConversationSummary,
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
  updateAgentConfig(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('agentKey') agentKey: string,
    @Body() body: UpdateAgentConfigInput,
    @CurrentActor() actor: Actor,
  ): Promise<AgentConfigView> {
    return this.configs.update(workspaceId, agentKey, body, actor);
  }

  @Post('internal-agents/sales/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Immediately stop automatic Sales Agent responses' })
  stopSalesAgent(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @CurrentActor() actor: Actor,
  ): Promise<AgentConfigView> {
    return this.configs.stopSalesAgent(workspaceId, actor);
  }

  @Get('sales-agent/conversations')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'List Sales Agent conversations (isolated from Crossmart Agent)' })
  listSalesConversations(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<SalesConversationSummary[]> {
    return this.salesAgent.listConversations(workspaceId);
  }

  @Post('sales-agent/conversations')
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Create a simulated buyer conversation for testing the Sales Agent' })
  createSalesConversation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: { title?: string },
    @CurrentActor() actor: Actor,
  ): Promise<SalesConversationDetail> {
    return this.salesAgent.createSimulatedConversation(workspaceId, actor.userId, body?.title);
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
  @ApiOperation({ summary: 'Send a simulated buyer message to the Sales Agent' })
  sendSimulatedMessage(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: { text: string },
  ): Promise<SalesConversationDetail> {
    return this.salesAgent.sendSimulatedBuyerMessage(workspaceId, conversationId, body.text);
  }

  @Delete('sales-agent/conversations/:conversationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({ summary: 'Delete a Sales Agent simulated conversation' })
  deleteSalesConversation(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<void> {
    return this.salesAgent.deleteConversation(workspaceId, conversationId);
  }
}
