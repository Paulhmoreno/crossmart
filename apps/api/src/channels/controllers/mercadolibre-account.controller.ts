import { Body, Controller, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, MercadoLibreSetupService, WorkspacePermission } from '@crossmart/core';
import { WORKSPACE_ID_PARAM } from '../../auth/auth.constants.js';
import { CurrentActor } from '../../auth/decorators/current-actor.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import {
  CHANNEL_CONNECTIONS_ROUTE,
  CHANNELS_TAG,
  CONNECTION_ID_PARAM,
  MERCADOLIBRE_LISTING_SETUP_PATH,
  MERCADOLIBRE_REFRESH_PATH,
} from '../channels.constants.js';
import { ChannelConnectionDto } from '../dto/channel-connection.dto.js';
import { UpdateMercadoLibreListingSetupDto } from '../dto/update-mercadolibre-listing-setup.dto.js';

/** Commercial listing setup for a connected Mercado Libre store. */
@ApiTags(CHANNELS_TAG)
@Controller(CHANNEL_CONNECTIONS_ROUTE)
export class MercadoLibreAccountController {
  constructor(private readonly setup: MercadoLibreSetupService) {}

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
