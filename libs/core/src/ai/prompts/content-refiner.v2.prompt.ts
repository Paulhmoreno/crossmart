import { ContentField } from '../../content-generation/enums/content-field.enum.js';
import type { ChannelContentRules } from '../../content-generation/rules/channel-content-rules.js';
import {
  channelRuleLines,
  type ContentGeneratorProduct,
  PROMPT_LINE,
  promptBullets,
} from './content-generator.v1.prompt.js';
import { commercialWritingRules } from './content-generator.v2.prompt.js';

/**
 * The Content Refiner's prompt, version 2: rewrites catalog or channel fields on request
 * using natural Ecuadorian/LATAM Spanish, strict anti-hallucination rules, and 3-tier quality.
 */
export const CONTENT_REFINER_PROMPT_VERSION = 'content-refiner/v2';

export interface ContentRefinerV2Input {
  fields: readonly ContentField[];
  instruction: string | null;
  product: ContentGeneratorProduct;
  current: { title: string; descriptionHtml: string };
}

const FIELD_NAMES: Record<ContentField, string> = {
  [ContentField.Title]: 'title',
  [ContentField.Description]: 'description',
  [ContentField.ShortDescription]: 'short description',
  [ContentField.Tags]: 'tags',
};
const AND = ' and ';
const PAIR_FIELD_COUNT = 2;

function formatFieldList(fields: readonly ContentField[]): string {
  const labels = fields.map((field) => FIELD_NAMES[field]);
  if (labels.length <= PAIR_FIELD_COUNT) return labels.join(AND);
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export function contentRefinerV2SystemPrompt(rules: ChannelContentRules): string {
  return [
    `You are a senior e-commerce copywriter. You rewrite product listing text for ${rules.channelName}.`,
    '',
    'Rules for this channel:',
    promptBullets(channelRuleLines(rules)),
    '',
    'Commercial quality & safety standards:',
    promptBullets([
      ...commercialWritingRules(rules),
      'Rewrite only the fields requested in the output schema.',
      'When shortDescription is requested: write 1 or 2 crisp plain-text sentences (max 300 characters, no HTML) summarizing the product and its practical use for storefront previews or WooCommerce short description.',
      'When tags are requested: return 3 to 8 concise, relevant search keywords in Spanish (brand, product type, confirmed model/connector, usage); no duplicates, no hashtags, no invented specs.',
      'Follow the merchant’s instruction when provided (including an explicit language request), within the safety and channel rules above.',
    ]),
  ].join(PROMPT_LINE);
}

export function contentRefinerV2UserPrompt(input: ContentRefinerV2Input): string {
  const fields = formatFieldList(input.fields);
  const data = { product: input.product, currentText: input.current };
  return [
    `Rewrite the ${fields} of this product.`,
    ...(input.instruction
      ? ['<merchant_instruction>', input.instruction, '</merchant_instruction>']
      : []),
    '<product_data>',
    JSON.stringify(data),
    '</product_data>',
  ].join(PROMPT_LINE);
}
