import { ProductDocumentKind } from '@crossmart/database';
import type { ProductDetail } from '../../catalog/entities/product-views.js';
import type { ContentGeneratorProduct } from '../../ai/prompts/content-generator.v1.prompt.js';
import {
  PROMPT_DESCRIPTION_MAX_LENGTH,
  PROMPT_OPTION_VALUES_MAX,
} from '../content-generation.constants.js';
import { ContentQualityTier } from '../enums/content-quality-tier.enum.js';

const MAX_IDENTIFIERS = 10;
const MAX_TECHNICAL_DOCS = 10;
const GRAMS_PER_KG = 1000;
const MODEL_TOKEN_PATTERN = /\b[A-Z]{1,5}[- ]?\d{2,}[A-Z0-9-]*\b/i;

export interface ProductQualityClassification {
  tier: ContentQualityTier;
  note: string;
}

/**
 * Deterministically assigns the truthful commercial verification tier based on available
 * verified sources/metadata so a model can never over-claim external verification.
 */
export function classifyProductQualityTier(
  product: ContentGeneratorProduct,
): ProductQualityClassification {
  if ((product.technicalDocuments?.length ?? 0) > 0) {
    return {
      tier: ContentQualityTier.VerifiedWithSources,
      note: 'Respaldado por documentación técnica pública autorizada en el catálogo.',
    };
  }
  const hasBrand = Boolean(product.vendor?.trim());
  const hasBarcode = (product.barcodes?.length ?? 0) > 0;
  const hasModelToken = MODEL_TOKEN_PATTERN.test(product.sourceOriginalName ?? product.title);
  if (hasBrand && (hasBarcode || hasModelToken)) {
    return {
      tier: ContentQualityTier.CommercialAssisted,
      note: 'Generado con marca y código/modelo del ERP sin fuentes externas adicionales.',
    };
  }
  return {
    tier: ContentQualityTier.GenericProvisional,
    note: 'Contenido provisional prudente a partir de ficha genérica o con datos limitados en ERP.',
  };
}

function readStringField(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readWeightGrams(product: ProductDetail): number | null {
  for (const variant of product.variants) {
    if (typeof variant.weightGrams === 'number' && variant.weightGrams > 0) {
      return variant.weightGrams;
    }
  }
  const weightKg = product.sourceMetadata?.weightKg;
  if (typeof weightKg === 'number' && Number.isFinite(weightKg) && weightKg > 0) {
    return Math.round(weightKg * GRAMS_PER_KG);
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const trimmed = raw?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * What the model is told about a product, bounded so a pathological one stays cheap and
 * strictly scrubbed of private ERP fields (unit cost, ERP URLs, taxes, confidential docs).
 */
export function promptProduct(product: ProductDetail): ContentGeneratorProduct {
  const optionValues = new Set(product.variants.flatMap((variant) => variant.optionValues));
  const sourceOriginalName = readStringField(product.sourceMetadata, 'originalName');
  const sourceOriginalCategory = readStringField(product.sourceMetadata, 'originalCategory');
  const skus = uniqueStrings(
    product.variants.map((variant) => variant.sku),
    MAX_IDENTIFIERS,
  );
  const barcodes = uniqueStrings(
    product.variants.map((variant) => variant.barcode),
    MAX_IDENTIFIERS,
  );
  const technicalDocuments = uniqueStrings(
    (product.documents ?? [])
      .filter(
        (doc) =>
          doc.isPublic &&
          (doc.kind === ProductDocumentKind.DATASHEET || doc.kind === ProductDocumentKind.MANUAL),
      )
      .map((doc) => doc.name),
    MAX_TECHNICAL_DOCS,
  );
  const weightGrams = readWeightGrams(product);

  return {
    title: product.title,
    descriptionHtml: product.descriptionHtml.slice(0, PROMPT_DESCRIPTION_MAX_LENGTH),
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    optionNames: product.optionNames,
    optionValues: [...optionValues].slice(0, PROMPT_OPTION_VALUES_MAX),
    ...(sourceOriginalName ? { sourceOriginalName } : {}),
    ...(sourceOriginalCategory ? { sourceOriginalCategory } : {}),
    ...(skus.length > 0 ? { skus } : {}),
    ...(barcodes.length > 0 ? { barcodes } : {}),
    ...(weightGrams !== null ? { weightGrams } : {}),
    ...(product.media ? { photoCount: product.media.length } : {}),
    ...(technicalDocuments.length > 0 ? { technicalDocuments } : {}),
  };
}
