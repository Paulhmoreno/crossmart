import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '@crossmart/common';
import {
  type Actor,
  MercadoLibreAppConfigService,
  MercadoLibreSetupService,
  WorkspacePermission,
} from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { CurrentActor } from '../../auth/decorators/current-actor.decorator.js';
import { CurrentPrincipal } from '../../auth/decorators/current-principal.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { Principal } from '../../auth/entities/principal.js';
import { PrincipalKind } from '../../auth/enums/principal-kind.enum.js';
import { isPlatformAdmin } from '../../auth/platform-admin.js';
import { requireUser } from '../../auth/principal.utils.js';
import {
  CHANNEL_CONNECTIONS_ROUTE,
  CHANNELS_TAG,
  CONNECTION_ID_PARAM,
  MERCADOLIBRE_APP_CONFIG_PATH,
  MERCADOLIBRE_LISTING_SETUP_PATH,
  MERCADOLIBRE_REFRESH_PATH,
} from '../channels.constants.js';
import { ChannelConnectionDto } from '../dto/channel-connection.dto.js';
import {
  MercadoLibreAppConfigDto,
  UpdateMercadoLibreAppConfigDto,
} from '../dto/mercadolibre-app-config.dto.js';
import { UpdateMercadoLibreListingSetupDto } from '../dto/update-mercadolibre-listing-setup.dto.js';

const INSTANCE_ADMIN_ONLY =
  'Only an instance administrator can configure Mercado Libre OAuth app credentials.';

/** Commercial listing setup and self-hosted OAuth app configuration for Mercado Libre. */
@ApiTags(CHANNELS_TAG)
@Controller(CHANNEL_CONNECTIONS_ROUTE)
export class MercadoLibreAccountController {
  constructor(
    private readonly setup: MercadoLibreSetupService,
    private readonly appConfigService: MercadoLibreAppConfigService,
    private readonly config: AppConfigService,
  ) {}

  @Get(MERCADOLIBRE_APP_CONFIG_PATH)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Read Mercado Libre OAuth app configuration status and effective Redirect URI',
    description: 'Never returns the Secret Key.',
  })
  @ApiOkResponse({ type: MercadoLibreAppConfigDto })
  async getAppConfig(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) _workspaceId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MercadoLibreAppConfigDto> {
    const status = await this.appConfigService.getStatus();
    return MercadoLibreAppConfigDto.from(status, this.canConfigureOAuthApp(principal));
  }

  @Put(MERCADOLIBRE_APP_CONFIG_PATH)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Save encrypted Mercado Libre OAuth App ID and Secret Key',
    description:
      'Restricted to instance administrators. Persists credentials encrypted with EnvelopeEncryption ' +
      'and resolves them dynamically across API and worker without restarts.',
  })
  @ApiOkResponse({ type: MercadoLibreAppConfigDto })
  async saveAppConfig(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Body() body: UpdateMercadoLibreAppConfigDto,
  ): Promise<MercadoLibreAppConfigDto> {
    if (!this.canConfigureOAuthApp(principal)) {
      throw new ForbiddenException(INSTANCE_ADMIN_ONLY);
    }
    const { userId } = requireUser(principal);
    const status = await this.appConfigService.save(workspaceId, body.toInput(), userId);
    return MercadoLibreAppConfigDto.from(status, true);
  }

  /**
   * Instance administrator check:
   * - When `PLATFORM_ADMIN_EMAILS` is configured, strictly requires a verified platform admin user.
   * - When empty (single-tenant self-hosted install), allows signed-in human admins with
   *   `ManageChannels` (never API keys or agents).
   */
  private canConfigureOAuthApp(principal: Principal): boolean {
    if (principal.kind !== PrincipalKind.User) return false;
    if (this.config.platformAdminEmails.size > 0) {
      return isPlatformAdmin(principal, this.config.platformAdminEmails);
    }
    return true;
  }

  @Put(MERCADOLIBRE_LISTING_SETUP_PATH)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Save commercial listing setup for a Mercado Libre connection',
    description:
      'Configures the default listing type, shipping mode, local pickup, warranty terms, ' +
      'and order import toggle for this Mercado Libre store.',
  })
  @ApiOkResponse({ type: ChannelConnectionDto })
  async saveListingSetup(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
    @Body() body: UpdateMercadoLibreListingSetupDto,
    @CurrentActor() actor: Actor,
  ): Promise<ChannelConnectionDto> {
    const saved = await this.setup.saveListingSetup(
      workspaceId,
      connectionId,
      body.toInput(),
      actor,
    );
    return ChannelConnectionDto.from(saved);
  }

  @Post(MERCADOLIBRE_REFRESH_PATH)
  @RequirePermission(WorkspacePermission.ManageChannels)
  @ApiOperation({
    summary: 'Refresh available listing types from Mercado Libre',
    description: 'Reads the live listing types offered by Mercado Libre for the store’s site.',
  })
  @ApiOkResponse({ type: ChannelConnectionDto })
  async refreshListingTypes(
    @Param(WORKSPACE_ID_PARAM, ParseUUIDPipe) workspaceId: string,
    @Param(CONNECTION_ID_PARAM, ParseUUIDPipe) connectionId: string,
  ): Promise<ChannelConnectionDto> {
    const saved = await this.setup.refreshListingTypes(workspaceId, connectionId);
    return ChannelConnectionDto.from(saved);
  }
}
