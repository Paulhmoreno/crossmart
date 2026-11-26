import { descriptionToPlainText, truncate } from '@crossmart/common';
import type { ListingDraft } from '../../sdk/capabilities/listing-publisher.js';
import {
  MERCADOLIBRE_DESCRIPTION_MAX_LENGTH,
  MERCADOLIBRE_TITLE_MAX_LENGTH,
} from '../mercadolibre.constants.js';

const HTML_TAGS = /<[^>]+>/gu;
const WHITESPACE_RUN = /\s+/gu;
const EXTERNAL_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CONTACT_LINE_PATTERN =
  /\b(?:whatsapp|cont[aá]ctanos|llam[aá]nos)\b|\b(?:tel[eé]fono|cel(?:ular)?)\s*:/iu;
const EAN_PITCH_LINE_PATTERN = /^(?:c[oó]digo\s+de\s+barras|ean|gtin|upc)\s*:/iu;
const MULTI_BLANK_LINES = /\n{3,}/gu;
const SINGLE_SPACE = ' ';

function deduplicateAdjacentBrand(title: string, vendor?: string | null): string {
  const brand = vendor?.trim();
  if (!brand) return title;
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const repeated = new RegExp(`\\b(${escaped})(?:\\s+\\1)+\\b`, 'giu');
  return title.replace(repeated, '$1');
}

/**
 * Adapts a product title to Mercado Libre's rules: strips HTML, collapses whitespace, removes
 * redundant adjacent brand repetition, and respects the category's `max_title_length` (default 60).
 */
export function adaptMercadoLibreTitle(
  draft: ListingDraft,
  maxLength = MERCADOLIBRE_TITLE_MAX_LENGTH,
): string {
  const cleaned = draft.product.title
    .replace(HTML_TAGS, SINGLE_SPACE)
    .replace(WHITESPACE_RUN, SINGLE_SPACE)
    .trim();
  const deduped = deduplicateAdjacentBrand(cleaned, draft.product.vendor);
  return truncate(deduped, maxLength).trim();
}

function sanitizeDescriptionLine(line: string): string | null {
  const stripped = line
    .replace(EXTERNAL_URL_PATTERN, '')
    .replace(EMAIL_PATTERN, '')
    .replace(WHITESPACE_RUN, SINGLE_SPACE)
    .trim();
  if (!stripped) return '';
  if (CONTACT_LINE_PATTERN.test(stripped) || EAN_PITCH_LINE_PATTERN.test(stripped)) return null;
  return stripped;
}

/**
 * Adapts product HTML description into clean Mercado Libre plain text: preserves readable
 * section breaks and bullet lists, strips incompatible HTML, external links, email addresses,
 * contact lines, and barcode-only pitch lines.
 */
export function adaptMercadoLibreDescription(draft: ListingDraft): string {
  const rawPlain = descriptionToPlainText(draft.product.descriptionHtml);
  const lines = rawPlain
    .split(/\r?\n/u)
    .map(sanitizeDescriptionLine)
    .filter((line): line is string => line !== null);
  const normalized = lines.join('\n').replace(MULTI_BLANK_LINES, '\n\n').trim();
  const text = normalized || adaptMercadoLibreTitle(draft);
  return truncate(text, MERCADOLIBRE_DESCRIPTION_MAX_LENGTH).trim();
}
