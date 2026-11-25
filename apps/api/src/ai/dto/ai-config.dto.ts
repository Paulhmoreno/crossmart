import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  type AiCapabilities,
  AiConfigSource,
  type AiModelOption,
  AiProviderName,
  type ListAiModelsResult,
  type TestAiConfigResult,
  type WorkspaceAiConfigView,
} from '@crossmart/core';
import { AiConfigStatus } from '@crossmart/database';
import {
  AI_CONFIG_SOURCE_SCHEMA_NAME,
  AI_CONFIG_STATUS_SCHEMA_NAME,
  AI_PROVIDER_SCHEMA_NAME,
} from '../ai.constants.js';

const MAX_URL_LENGTH = 500;
const MAX_MODEL_LENGTH = 200;
const MAX_KEY_LENGTH = 512;

export class AiCapabilitiesDto implements AiCapabilities {
  @ApiProperty()
  structuredOutput: boolean;

  @ApiProperty()
  jsonSchema: boolean;

  @ApiProperty()
  streaming: boolean;

  @ApiProperty()
  toolCalling: boolean;

  @ApiProperty()
  vision: boolean;

  @ApiProperty()
  modelsEndpoint: boolean;

  static from(capabilities: AiCapabilities): AiCapabilitiesDto {
    return Object.assign(new AiCapabilitiesDto(), capabilities);
  }
}

export class AiConfigDto {
  @ApiProperty()
  configured: boolean;

  @ApiProperty({ enum: AiConfigSource, enumName: AI_CONFIG_SOURCE_SCHEMA_NAME })
  source: AiConfigSource;

  @ApiProperty({ enum: AiProviderName, enumName: AI_PROVIDER_SCHEMA_NAME })
  provider: AiProviderName;

  @ApiProperty({ type: String, nullable: true, example: 'https://api.openai.com/v1' })
  baseUrl: string | null;

  @ApiProperty({ example: 'gpt-4o-mini' })
  model: string;

  @ApiProperty({
    description: 'True when an encrypted API key is stored; the key is never returned',
  })
  hasApiKey: boolean;

  @ApiProperty({ enum: AiConfigStatus, enumName: AI_CONFIG_STATUS_SCHEMA_NAME })
  status: AiConfigStatus;

  @ApiProperty({ type: AiCapabilitiesDto })
  capabilities: AiCapabilitiesDto;

  @ApiProperty({ type: String, nullable: true })
  lastError: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastTestedAt: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;

  static from(view: WorkspaceAiConfigView): AiConfigDto {
    return Object.assign(new AiConfigDto(), {
      configured: view.configured,
      source: view.source,
      provider: view.provider,
      baseUrl: view.baseUrl,
      model: view.model,
      hasApiKey: view.hasApiKey,
      status: view.status,
      capabilities: AiCapabilitiesDto.from(view.capabilities),
      lastError: view.lastError,
      lastTestedAt: view.lastTestedAt ? view.lastTestedAt.toISOString() : null,
      updatedAt: view.updatedAt ? view.updatedAt.toISOString() : null,
    });
  }
}

export class SaveAiConfigDto {
  @ApiProperty({ enum: AiProviderName, enumName: AI_PROVIDER_SCHEMA_NAME })
  @IsEnum(AiProviderName)
  provider: AiProviderName;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://api.openai.com/v1',
    description: 'API base URL for OpenAI-compatible servers',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
  baseUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    writeOnly: true,
    description:
      'Provider API key. Omit to keep the encrypted key already saved for this provider.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_KEY_LENGTH)
  apiKey?: string | null;

  @ApiProperty({ example: 'gpt-4o-mini', description: 'Model identifier' })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MODEL_LENGTH)
  model: string;
}

export class TestAiConfigDto extends SaveAiConfigDto {}

export class TestAiConfigResultDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ enum: AiProviderName, enumName: AI_PROVIDER_SCHEMA_NAME })
  provider: AiProviderName;

  @ApiProperty({ type: String, nullable: true })
  resolvedModel: string | null;

  @ApiProperty()
  latencyMs: number;

  @ApiProperty({ type: AiCapabilitiesDto })
  capabilities: AiCapabilitiesDto;

  @ApiProperty({ type: String, nullable: true })
  error: string | null;

  static from(result: TestAiConfigResult): TestAiConfigResultDto {
    return Object.assign(new TestAiConfigResultDto(), {
      ...result,
      capabilities: AiCapabilitiesDto.from(result.capabilities),
    });
  }
}

export class ListAiModelsDto {
  @ApiProperty({ enum: AiProviderName, enumName: AI_PROVIDER_SCHEMA_NAME })
  @IsEnum(AiProviderName)
  provider: AiProviderName;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
  baseUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, writeOnly: true })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_KEY_LENGTH)
  apiKey?: string | null;
}

export class AiModelOptionDto implements AiModelOption {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: String, nullable: true })
  ownedBy: string | null;

  static from(option: AiModelOption): AiModelOptionDto {
    return Object.assign(new AiModelOptionDto(), option);
  }
}

export class ListAiModelsResultDto {
  @ApiProperty()
  supported: boolean;

  @ApiProperty({ type: [AiModelOptionDto] })
  models: AiModelOptionDto[];

  @ApiProperty({ type: String, nullable: true })
  error: string | null;

  static from(result: ListAiModelsResult): ListAiModelsResultDto {
    return Object.assign(new ListAiModelsResultDto(), {
      supported: result.supported,
      models: result.models.map((item) => AiModelOptionDto.from(item)),
      error: result.error,
    });
  }
}
