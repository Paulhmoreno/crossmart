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
  AiConnectionsService,
  type AiConnectionView,
  type ListAiModelsResult,
  type ListProviderModelsInput,
  type SaveAiConnectionInput,
  type TestAiConfigResult,
  type TestAiConnectionInput,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { CurrentActor } from '../../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { AI_ROUTE, AI_TAG } from '../ai.constants.js';

const CONNECTION_ID_PARAM = 'connectionId';

/** Multi-provider AI connections per workspace (OpenAI, Anthropic, Gemini, OpenAI-compatible, Anthropic-compatible). */
@ApiTags(AI_TAG)
@Controller(`${AI_ROUTE}/connections`)
export class AiConnectionsController {
  constructor(private readonly connections: AiConnectionsService) {}

  @Get()
  @RequirePermission(WorkspacePermission.ViewWorkspace)
  @ApiOperation({
    summary: 'List AI provider connections for this workspace (never returns secrets)',
  })
  list(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string): Promise<AiConnectionView[]> {
    return this.connections.listConnections(workspaceId);
  }

  @Post()
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Create an encrypted AI provider connection' })
  create(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: SaveAiConnectionInput,
    @CurrentActor() actor: Actor,
  ): Promise<AiConnectionView> {
    return this.connections.createConnection(workspaceId, body, actor);
  }

  @Put(`:${CONNECTION_ID_PARAM}`)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Update an encrypted AI provider connection' })
  update(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
    @Body() body: SaveAiConnectionInput,
    @CurrentActor() actor: Actor,
  ): Promise<AiConnectionView> {
    return this.connections.updateConnection(workspaceId, connectionId, body, actor);
  }

  @Delete(`:${CONNECTION_ID_PARAM}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Delete an AI provider connection (blocked if assigned to any agent)' })
  delete(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
    @CurrentActor() actor: Actor,
  ): Promise<void> {
    return this.connections.deleteConnection(workspaceId, connectionId, actor);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'Test AI provider connection credentials and probe real capabilities' })
  test(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: TestAiConnectionInput,
  ): Promise<TestAiConfigResult> {
    return this.connections.testConnection(workspaceId, body);
  }

  @Post('models')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageWorkspace)
  @ApiOperation({ summary: 'List models exposed by the provider API when supported' })
  listModels(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: ListProviderModelsInput,
  ): Promise<ListAiModelsResult> {
    return this.connections.listModels(workspaceId, body);
  }
}
