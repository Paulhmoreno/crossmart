import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { AnthropicAiProvider } from './providers/anthropic/anthropic-ai.provider.js';
import { AnthropicClientFactory } from './providers/anthropic/anthropic-client.factory.js';
import { AiProvider } from './providers/ai-provider.js';
import { AiUsageRepository } from './repositories/ai-usage.repository.js';
import { PlatformAiUsageRepository } from './repositories/platform-ai-usage.repository.js';
import { AiConfigService } from './services/ai-config.service.js';
import { AiCredentialsVault } from './services/ai-credentials.vault.js';
import { AiGateway } from './services/ai-gateway.service.js';
import { AiUsageService } from './services/ai-usage.service.js';

/**
 * The AI layer: the `AiProvider` abstraction (Anthropic and OpenAI-compatible), per-workspace
 * encrypted provider configuration, metering of every call, and `AiGateway`, through which
 * agents call the model.
 */
@Module({
  imports: [EntitlementsModule, CredentialsModule, ActivityModule],
  providers: [
    AnthropicClientFactory,
    { provide: AiProvider, useClass: AnthropicAiProvider },
    AiCredentialsVault,
    AiConfigService,
    AiUsageRepository,
    PlatformAiUsageRepository,
    AiUsageService,
    AiGateway,
  ],
  exports: [AiGateway, AiUsageService, AiConfigService],
})
export class AiModule {}
