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
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  OdooConnectionService,
  OdooEventIngestionService,
  OdooSyncService,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { CurrentActor } from '../../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import {
  OdooConnectionDto,
  OdooConnectionStateDto,
  OdooPreviewResponseDto,
  OdooSyncRunDto,
  OdooTestConnectionResponseDto,
  TestOdooConnectionDto,
  UpsertOdooConnectionDto,
} from '../dto/odoo-connection.dto.js';
import { PreviewOdooProductsQueryDto, StartOdooSyncDto } from '../dto/odoo-sync.dto.js';
import { ODOO_RUN_ID_PARAM, ODOO_SOURCE_ROUTE, ODOO_TAG } from '../odoo.constants.js';

@ApiTags(ODOO_TAG)
@Controller(ODOO_SOURCE_ROUTE)
export class OdooSourceController {
  constructor(
    private readonly connections: OdooConnectionService,
    private readonly sync: OdooSyncService,
    private readonly eventIngestion: OdooEventIngestionService,
  ) {}

  @Get('capabilities')
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({
    summary: 'Get Odoo crossmart_connector pairing status, module version, capabilities, and event metrics',
  })
  async getCapabilities(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.eventIngestion.getOperationalCapabilities(workspaceId);
  }

  @Post('pairing/generate')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate or rotate cryptographic HMAC pairing credentials for crossmart_connector',
  })
  async generatePairing(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: { rotate?: boolean },
    @CurrentActor() actor: Actor,
  ) {
    return this.eventIngestion.generatePairingCredentials(
      workspaceId,
      actor,
      Boolean(body?.rotate),
    );
  }

  @Post('pairing/revoke')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke crossmart_connector pairing credentials immediately',
  })
  async revokePairing(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.eventIngestion.revokePairingCredentials(workspaceId, actor);
  }

  @Post('pairing/test')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify bidirectional communication between Crossmart and Odoo crossmart_connector (read-only)',
  })
  async testPairing(@Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string) {
    return this.eventIngestion.testModulePairing(workspaceId);
  }

  @Get()
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({ summary: 'Get the workspace Odoo ERP source connection and recent sync runs' })
  @ApiOkResponse({ type: OdooConnectionStateDto })
  async getStatus(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
  ): Promise<OdooConnectionStateDto> {
    return OdooConnectionStateDto.from(await this.connections.getStatus(workspaceId));
  }

  @Post('test')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test read-only authentication and discover Odoo 18 capabilities' })
  @ApiOkResponse({ type: OdooTestConnectionResponseDto })
  async test(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: TestOdooConnectionDto,
  ): Promise<OdooTestConnectionResponseDto> {
    return Object.assign(
      new OdooTestConnectionResponseDto(),
      await this.connections.testConnection(workspaceId, body),
    );
  }

  @Put()
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({ summary: 'Connect Odoo or update credentials and optional advanced settings' })
  @ApiOkResponse({ type: OdooConnectionDto })
  async upsert(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: UpsertOdooConnectionDto,
    @CurrentActor() actor: Actor,
  ): Promise<OdooConnectionDto> {
    return OdooConnectionDto.from(
      await this.connections.upsertConnection(workspaceId, body, actor),
    );
  }

  @Delete()
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Disconnect Odoo and wipe stored credentials (imported products are preserved)',
  })
  @ApiOkResponse({ type: OdooConnectionDto })
  async disconnect(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @CurrentActor() actor: Actor,
  ): Promise<OdooConnectionDto> {
    return OdooConnectionDto.from(await this.connections.disconnect(workspaceId, actor));
  }

  @Get('preview')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Search and preview products from Odoo read-only before selective sync',
  })
  @ApiOkResponse({ type: OdooPreviewResponseDto })
  async preview(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Query() query: PreviewOdooProductsQueryDto,
  ): Promise<OdooPreviewResponseDto> {
    const items = await this.connections.previewProducts(workspaceId, query);
    return Object.assign(new OdooPreviewResponseDto(), { items });
  }

  @Post('sync')
  @RequirePermission(WorkspacePermission.ManageChannels)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Queue a read-only sync from Odoo (selected products or full catalog)' })
  @ApiOkResponse({ type: OdooSyncRunDto })
  async startSync(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Body() body: StartOdooSyncDto,
    @CurrentActor() actor: Actor,
  ): Promise<OdooSyncRunDto> {
    return OdooSyncRunDto.from(await this.sync.startSync(workspaceId, body, actor));
  }

  @Get(`sync-runs/:${ODOO_RUN_ID_PARAM}`)
  @RequirePermission(WorkspacePermission.ViewChannels)
  @ApiOperation({ summary: 'Get live progress and issues for an Odoo sync run' })
  @ApiOkResponse({ type: OdooSyncRunDto })
  async getSyncRun(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(ODOO_RUN_ID_PARAM, ParseUUIDPipe) runId: string,
  ): Promise<OdooSyncRunDto> {
    return OdooSyncRunDto.from(await this.sync.getSyncRun(workspaceId, runId));
  }
}
