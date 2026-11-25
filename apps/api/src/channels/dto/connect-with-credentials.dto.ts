import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { IsEnum, IsObject } from 'class-validator';
import {
  type ChannelSettings,
  ChannelType,
  isFalabellaSettings,
  isWooCommerceSettings,
} from '@crossmart/connectors';
import type { CompletedAuthorization, SellerCredentialsRequest } from '@crossmart/core';
import { CHANNEL_TYPE_SCHEMA_NAME } from '../channels.constants.js';
import { ChannelConnectionDto } from './channel-connection.dto.js';
import { FalabellaCredentialsDto } from './falabella-credentials.dto.js';
import { FalabellaSettingsDto } from './falabella-settings.dto.js';
import { WooCommerceCredentialsDto } from './woocommerce-credentials.dto.js';
import { WooCommerceSettingsDto } from './woocommerce-settings.dto.js';

export class ConnectWithCredentialsDto implements SellerCredentialsRequest {
  @ApiProperty({
    enum: ChannelType,
    enumName: CHANNEL_TYPE_SCHEMA_NAME,
    description: 'A channel connected with credentials: `falabella` or `woocommerce`',
  })
  @IsEnum(ChannelType)
  channel: ChannelType;

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(FalabellaCredentialsDto) },
      { $ref: getSchemaPath(WooCommerceCredentialsDto) },
    ],
    description: 'The credentials the channel issued, with the fields of its schema',
  })
  @IsObject()
  credentials: Record<string, unknown>;
}

/** Result of a non-mutating credentials test (`POST .../credentials/test`). */
export class TestedCredentialsDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty()
  externalAccountId: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty({ type: FalabellaSettingsDto, nullable: true })
  falabella: FalabellaSettingsDto | null;

  @ApiProperty({ type: WooCommerceSettingsDto, nullable: true })
  woocommerce: WooCommerceSettingsDto | null;

  static from(result: {
    externalAccountId: string;
    displayName: string;
    settings: ChannelSettings;
  }): TestedCredentialsDto {
    return Object.assign(new TestedCredentialsDto(), {
      ok: true,
      externalAccountId: result.externalAccountId,
      displayName: result.displayName,
      falabella: isFalabellaSettings(result.settings)
        ? FalabellaSettingsDto.from(result.settings)
        : null,
      woocommerce: isWooCommerceSettings(result.settings)
        ? WooCommerceSettingsDto.from(result.settings)
        : null,
    });
  }
}

/** A connection made with credentials, and whether the account was connected before. */
export class ConnectedChannelDto {
  @ApiProperty({ type: ChannelConnectionDto })
  connection: ChannelConnectionDto;

  @ApiProperty({ description: 'True when the account was connected before and got new keys' })
  reconnected: boolean;

  static from(completed: CompletedAuthorization): ConnectedChannelDto {
    return Object.assign(new ConnectedChannelDto(), {
      connection: ChannelConnectionDto.from(completed.connection),
      reconnected: completed.reconnected,
    });
  }
}
