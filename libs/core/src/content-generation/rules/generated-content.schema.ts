import { z } from 'zod';
import { RATIONALE_MAX_LENGTH } from '../content-generation.constants.js';
import { ContentField } from '../enums/content-field.enum.js';
import { ContentQualityTier } from '../enums/content-quality-tier.enum.js';
import type { ChannelContentRules } from './channel-content-rules.js';

export const SHORT_DESCRIPTION_MAX_LENGTH = 300;
export const GENERATED_TAG_MAX_LENGTH = 40;
export const GENERATED_TAGS_MAX_COUNT = 10;
export const QUALITY_NOTE_MAX_LENGTH = 240;

const qualityTierSchema = z
  .nativeEnum(ContentQualityTier)
  .describe(
    'Verification tier: verified_with_sources, commercial_assisted, or generic_provisional',
  );

const qualityNoteSchema = z
  .string()
  .min(1)
  .max(QUALITY_NOTE_MAX_LENGTH)
  .describe('One short Spanish sentence explaining why this quality tier applies');

/** The Content Generator's answer: a title and a description, each with why it is better. */
export interface GeneratedContent {
  title: string;
  titleRationale: string;
  descriptionHtml: string;
  descriptionRationale: string;
  qualityTier?: ContentQualityTier;
  qualityNote?: string;
}

/**
 * The schema the model's answer must match for one channel. It is sent to the model as the
 * output format and checked again on the answer, so a title over the channel's limit is
 * rejected, never stored.
 */
export function generatedContentSchema(rules: ChannelContentRules): z.ZodType<GeneratedContent> {
  const rationale = z.string().min(1).max(RATIONALE_MAX_LENGTH);
  return z.object({
    title: titleField(rules),
    titleRationale: rationale.describe('Why this title works better on the channel'),
    descriptionHtml: descriptionField(rules),
    descriptionRationale: rationale.describe('Why this description works better'),
    qualityTier: qualityTierSchema.optional(),
    qualityNote: qualityNoteSchema.optional(),
  });
}

/** A rewrite of the fields asked for; the others are absent. */
export interface ContentDraftOutput {
  title?: string;
  descriptionHtml?: string;
  shortDescription?: string;
  tags?: string[];
  qualityTier?: ContentQualityTier;
  qualityNote?: string;
}

/** The schema of a rewrite: only the fields asked for, each within the channel's limits. */
export function contentDraftSchema(
  rules: ChannelContentRules,
  fields: ReadonlySet<ContentField>,
): z.ZodType<ContentDraftOutput> {
  const shape: Record<string, z.ZodTypeAny> = {
    qualityTier: qualityTierSchema.optional(),
    qualityNote: qualityNoteSchema.optional(),
  };
  if (fields.has(ContentField.Title)) {
    shape.title = titleField(rules);
  }
  if (fields.has(ContentField.Description)) {
    shape.descriptionHtml = descriptionField(rules);
  }
  if (fields.has(ContentField.ShortDescription)) {
    shape.shortDescription = z
      .string()
      .min(1)
      .max(SHORT_DESCRIPTION_MAX_LENGTH)
      .describe('Plain-text commercial summary (1-2 sentences, no HTML)');
  }
  if (fields.has(ContentField.Tags)) {
    shape.tags = z
      .array(z.string().min(1).max(GENERATED_TAG_MAX_LENGTH))
      .min(1)
      .max(GENERATED_TAGS_MAX_COUNT)
      .describe('Relevant Spanish commercial search tags');
  }
  return z.object(shape) as z.ZodType<ContentDraftOutput>;
}

function titleField(rules: ChannelContentRules): z.ZodString {
  return z.string().min(1).max(rules.titleMaxLength).describe('The new listing title');
}

function descriptionField(rules: ChannelContentRules): z.ZodString {
  return z
    .string()
    .min(1)
    .max(rules.descriptionMaxLength)
    .describe('The new listing description, as HTML');
}
