import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { MercadoLibreAppConfigStatus, SaveMercadoLibreAppConfigInput } from '@crossmart/core';

const MAX_CREDENTIAL_LENGTH = 256;

export class MercadoLibreAppConfigDto {
  @ApiProperty({ description: 'Whether Mercado Libre OAuth app credentials are configured' })
  configured: boolean;

  @ApiProperty({
    enum: ['database', 'env', 'none'],
    description: 'Active credential source (database takes precedence over env)',
  })
  source: 'database' | 'env' | 'none';

  @ApiProperty({ type: String, nullable: true, example: '5503910054141466' })
  clientId: string | null;

  @ApiProperty({ description: 'True when a Secret Key is stored; secret is never returned' })
  hasClientSecret: boolean;

  @ApiProperty({
    example: 'https://api.example.com/api/v1/channels/mercado_libre/oauth/callback',
    description: 'Effective OAuth Redirect URI to register in Mercado Libre DevCenter',
  })
  redirectUri: string;

  @ApiProperty({ description: 'Number of active Mercado Libre store connections on this instance' })
  activeConnections: number;

  @ApiProperty({ description: 'Whether the signed-in user may configure OAuth app credentials' })
  canManage: boolean;

  static from(status: MercadoLibreAppConfigStatus, canManage: boolean): MercadoLibreAppConfigDto {
    return Object.assign(new MercadoLibreAppConfigDto(), {
      ...status,
      canManage,
    });
  }
}

export class UpdateMercadoLibreAppConfigDto {
  @ApiProperty({ example: '5503910054141466', maxLength: MAX_CREDENTIAL_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CREDENTIAL_LENGTH)
  clientId: string;

  @ApiPropertyOptional({
    description:
      'Mercado Libre Secret Key; optional when keeping the stored secret for the same App ID',
    maxLength: MAX_CREDENTIAL_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CREDENTIAL_LENGTH)
  clientSecret?: string;

  toInput(): SaveMercadoLibreAppConfigInput {
    return {
      clientId: this.clientId.trim(),
      ...(this.clientSecret !== undefined ? { clientSecret: this.clientSecret.trim() } : {}),
    };
  }
}
