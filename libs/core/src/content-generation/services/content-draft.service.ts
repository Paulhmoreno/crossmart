import { Injectable } from '@nestjs/common';
import { AI_MAX_OUTPUT_TOKENS } from '../../ai/ai.constants.js';
import { AiFeature } from '../../ai/enums/ai-feature.enum.js';
import { AiOutputRejectedError } from '../../ai/errors/ai.errors.js';
import {
  contentRefinerV2SystemPrompt,
  contentRefinerV2UserPrompt,
} from '../../ai/prompts/content-refiner.v2.prompt.js';
import { AiGateway } from '../../ai/services/ai-gateway.service.js';
import { EMPTY_AFTER_CLEANING } from '../content-generation.constants.js';
import type { ContentDraft, ContentDraftRequest } from '../entities/content-draft.js';
import type { ChannelContentRules } from '../rules/channel-content-rules.js';
import { cleanDescription, cleanTitle } from '../rules/content-cleaning.js';
import {
  type ContentDraftOutput,
  contentDraftSchema,
  GENERATED_TAG_MAX_LENGTH,
  GENERATED_TAGS_MAX_COUNT,
  SHORT_DESCRIPTION_MAX_LENGTH,
} from '../rules/generated-content.schema.js';
import {
  classifyProductQualityTier,
  type ProductQualityClassification,
  promptProduct,
} from '../rules/prompt-product.js';
import { ContentField } from '../enums/content-field.enum.js';
import { ContentQualityTier } from '../enums/content-quality-tier.enum.js';
import { ContentDraftTargetLoader } from './content-draft-target.loader.js';

function cleanTags(rawTags: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of rawTags) {
    const plain = cleanTitle(raw).replace(/^#+/, '').trim();
    if (!plain) continue;
    const bounded = plain.slice(0, GENERATED_TAG_MAX_LENGTH).trim();
    const key = bounded.toLowerCase();
    if (!bounded || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(bounded);
    if (cleaned.length >= GENERATED_TAGS_MAX_COUNT) break;
  }
  return cleaned;
}

/**
 * Rewrites the fields a merchant is editing, right away, for them to keep or change before
 * saving. Unlike the Content Generator's suggestions, nothing is queued or stored; only the
 * call is metered.
 */
@Injectable()
export class ContentDraftService {
  constructor(
    private readonly ai: AiGateway,
    private readonly targets: ContentDraftTargetLoader,
  ) {}

  async draft(request: ContentDraftRequest): Promise<ContentDraft> {
    await this.ai.assertConfiguredForWorkspace(request.workspaceId);
    const target = await this.targets.load(request);
    const fields = new Set(request.fields);
    const product = promptProduct(target.product);
    const classification = classifyProductQualityTier(product);
    const { output } = await this.ai.generate(
      { workspaceId: request.workspaceId, feature: AiFeature.ContentDraft },
      {
        system: contentRefinerV2SystemPrompt(target.rules),
        prompt: contentRefinerV2UserPrompt({
          fields: [...fields],
          instruction: request.instruction,
          product,
          current: { ...target.saved, ...request.current },
        }),
        schema: contentDraftSchema(target.rules, fields),
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      },
    );
    const includeTier =
      fields.has(ContentField.ShortDescription) ||
      fields.has(ContentField.Tags) ||
      output.qualityTier !== undefined;
    return this.clean(output, target.rules, includeTier ? classification : null);
  }

  /** Titles lose any markup and descriptions keep only what the channel takes. */
  private clean(
    output: ContentDraftOutput,
    rules: ChannelContentRules,
    classification: ProductQualityClassification | null,
  ): ContentDraft {
    const title = output.title === undefined ? null : cleanTitle(output.title);
    const descriptionHtml =
      output.descriptionHtml === undefined ? null : cleanDescription(output.descriptionHtml, rules);
    const shortDescription =
      output.shortDescription === undefined
        ? undefined
        : cleanTitle(output.shortDescription).slice(0, SHORT_DESCRIPTION_MAX_LENGTH).trim();
    const tags = output.tags === undefined ? undefined : cleanTags(output.tags);

    if (
      title === '' ||
      descriptionHtml === '' ||
      shortDescription === '' ||
      (tags !== undefined && tags.length === 0)
    ) {
      throw new AiOutputRejectedError(EMPTY_AFTER_CLEANING);
    }

    const resolvedTier = classification
      ? this.capTier(output.qualityTier, classification.tier)
      : undefined;
    const resolvedNote = classification
      ? output.qualityNote?.trim() || classification.note
      : undefined;

    return {
      title,
      descriptionHtml,
      ...(shortDescription !== undefined ? { shortDescription } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(resolvedTier ? { qualityTier: resolvedTier } : {}),
      ...(resolvedNote ? { qualityNote: resolvedNote } : {}),
    };
  }

  /** Prevents a model from claiming VerifiedWithSources when no public technical docs exist. */
  private capTier(
    modelTier: ContentQualityTier | undefined,
    truthfulTier: ContentQualityTier,
  ): ContentQualityTier {
    if (!modelTier) return truthfulTier;
    if (
      modelTier === ContentQualityTier.VerifiedWithSources &&
      truthfulTier !== ContentQualityTier.VerifiedWithSources
    ) {
      return truthfulTier;
    }
    return modelTier;
  }
}
