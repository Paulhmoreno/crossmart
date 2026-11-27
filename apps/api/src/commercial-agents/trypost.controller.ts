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
  TryPostConnectionService,
  type UpsertTryPostInput,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../auth/auth.constants.js';
import { CurrentActor } from '../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

@ApiTags('Marketing — TryPost')
@Controller('workspaces/:workspaceId/connectors/trypost')
export class TryPostController {
  constructor(private readonly trypost: TryPostConnectionService) {}

  @Get()
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({ summary: 'Get TryPost connection status, accounts, and capabilities' })
  async getStatus(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return { connection: await this.trypost.getStatus(workspaceId) };
  }

  @Post('test')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test TryPost REST API key and discover social accounts & capabilities' })
  test(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: UpsertTryPostInput,
  ) {
    return this.trypost.testConnection(workspaceId, body);
  }

  @Put()
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Connect or update TryPost credentials (encrypted at rest)' })
  upsert(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: UpsertTryPostInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.trypost.upsertConnection(workspaceId, body, actor);
  }

  @Delete()
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Revoke TryPost credentials and disconnect' })
  disconnect(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.trypost.disconnect(workspaceId);
  }

  @Get('overview')
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({ summary: 'Read-only remote overview of TryPost ideas, posts, and analytics' })
  remoteOverview(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.trypost.fetchRemoteOverview(workspaceId);
  }
}
