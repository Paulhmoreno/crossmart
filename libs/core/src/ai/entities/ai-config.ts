import type { AiConfigStatus } from '@crossmart/database';
import type { AiProviderName } from '../enums/ai-provider-name.enum.js';

/** Capabilities verified against the configured provider and model. */
export interface AiCapabilities {
  structuredOutput: boolean;
  jsonSchema: boolean;
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  modelsEndpoint: boolean;
}

export const UNKNOWN_AI_CAPABILITIES: AiCapabilities = {
  structuredOutput: false,
  jsonSchema: false,
  streaming: false,
  toolCalling: false,
  vision: false,
  modelsEndpoint: false,
};

export const ANTHROPIC_DEFAULT_CAPABILITIES: AiCapabilities = {
  structuredOutput: true,
  jsonSchema: true,
  streaming: true,
  toolCalling: true,
  vision: true,
  modelsEndpoint: false,
};

export enum AiConfigSource {
  Workspace = 'workspace',
  Environment = 'environment',
  None = 'none',
}

export interface AiSealedSecret {
  apiKey: string;
}

export interface AiModelOption {
  id: string;
  ownedBy: string | null;
}

/** Public view of a workspace's AI configuration. Never includes the API key. */
export interface WorkspaceAiConfigView {
  configured: boolean;
  source: AiConfigSource;
  provider: AiProviderName;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  status: AiConfigStatus;
  capabilities: AiCapabilities;
  lastError: string | null;
  lastTestedAt: Date | null;
  updatedAt: Date | null;
}

export interface SaveAiConfigInput {
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
  model: string;
}

export interface TestAiConfigInput {
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
  model: string;
}

export interface TestAiConfigResult {
  ok: boolean;
  provider: AiProviderName;
  resolvedModel: string | null;
  latencyMs: number;
  capabilities: AiCapabilities;
  error: string | null;
}

export interface ListAiModelsInput {
  provider: AiProviderName;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface ListAiModelsResult {
  supported: boolean;
  models: AiModelOption[];
  error: string | null;
}
