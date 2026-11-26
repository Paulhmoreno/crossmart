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
  ChatwootConnectionsService,
  type ChatwootConnectionView,
  type SaveChatwootConnectionInput,
  type TestChatwootConnectionInput,
  type TestChatwootConnectionResult,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../auth/auth.constants.js';
import { CurrentActor } from '../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

const CONNECTION_ID_PARAM = 'connectionId';

@ApiTags('Communication')
@Controller(`workspaces/:${WORKSPACE_ID_PARAM}/connectors/chatwoot`)
export class ChatwootController {
  constructor(private readonly chatwoot: ChatwootConnectionsService) {}

  @Get()
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({ summary: 'List Chatwoot connections for this workspace (never returns secrets)' })
  list(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<ChatwootConnectionView[]> {
    return this.chatwoot.list(workspaceId);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Test Chatwoot URL and API access token, returning real accounts and inboxes',
  })
  test(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: TestChatwootConnectionInput,
  ): Promise<TestChatwootConnectionResult> {
    return this.chatwoot.testConnection(workspaceId, body);
  }

  @Post()
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Create an encrypted Chatwoot connection' })
  create(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: SaveChatwootConnectionInput,
    @CurrentActor() actor: Actor,
  ): Promise<ChatwootConnectionView> {
    return this.chatwoot.create(workspaceId, body, actor);
  }

  @Put(`:${CONNECTION_ID_PARAM}`)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Update an encrypted Chatwoot connection' })
  update(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
    @Body() body: SaveChatwootConnectionInput,
    @CurrentActor() actor: Actor,
  ): Promise<ChatwootConnectionView> {
    return this.chatwoot.update(workspaceId, connectionId, body, actor);
  }

  @Post(`:${CONNECTION_ID_PARAM}/refresh-inboxes`)
  @HttpCode(HttpStatus.OK)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Refresh real accounts and inboxes from Chatwoot' })
  refreshInboxes(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
  ): Promise<ChatwootConnectionView> {
    return this.chatwoot.refreshInboxes(workspaceId, connectionId);
  }

  @Delete(`:${CONNECTION_ID_PARAM}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Delete a Chatwoot connection' })
  delete(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
  ): Promise<void> {
    return this.chatwoot.delete(workspaceId, connectionId);
  }
}
