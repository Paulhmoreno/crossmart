import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MercadoLibreApiClient } from '../api/mercadolibre-api.client.js';
import {
  MERCADOLIBRE_CATALOG_SEARCH_PATH,
  MercadoLibreAttributeId,
  MercadoLibreQueryParam,
} from '../mercadolibre.constants.js';
import type { MercadoLibreSiteId } from '../mercadolibre-site.js';

const CATALOG_STATUS_ACTIVE = 'active';
const CATALOG_SEARCH_LIMIT = '5';
const GTIN_PATTERN = /^\d{8,14}$/u;

const catalogProductSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  attributes: z
    .array(
      z.object({
        id: z.string(),
        value_name: z.string().nullish(),
      }),
    )
    .default([]),
});

const catalogSearchSchema = z.object({
  results: z.array(catalogProductSchema).default([]),
});

type CatalogProduct = z.infer<typeof catalogProductSchema>;

function normalizeDigits(value: string): string {
  return value.replace(/\D/gu, '');
}

function hasExactGtin(product: CatalogProduct, expectedGtin: string): boolean {
  return product.attributes.some(
    (attribute) =>
      attribute.id === MercadoLibreAttributeId.Gtin &&
      typeof attribute.value_name === 'string' &&
      normalizeDigits(attribute.value_name) === expectedGtin,
  );
}

/**
 * Looks up an official Mercado Libre catalog product ONLY when an unambiguous exact GTIN match
 * exists. Never links approximate, partial, or wrong-variant catalog entries.
 */
@Injectable()
export class MercadoLibreCatalogMatcher {
  constructor(private readonly api: MercadoLibreApiClient) {}

  async findExactByGtin(
    accessToken: string,
    siteId: MercadoLibreSiteId,
    rawBarcode: string | null | undefined,
  ): Promise<string | null> {
    const gtin = rawBarcode ? normalizeDigits(rawBarcode) : '';
    if (!GTIN_PATTERN.test(gtin)) return null;
    try {
      const response = await this.api.get(
        {
          accessToken,
          path: MERCADOLIBRE_CATALOG_SEARCH_PATH,
          query: {
            [MercadoLibreQueryParam.SiteId]: siteId,
            [MercadoLibreQueryParam.Status]: CATALOG_STATUS_ACTIVE,
            [MercadoLibreQueryParam.ProductIdentifier]: gtin,
            [MercadoLibreQueryParam.Limit]: CATALOG_SEARCH_LIMIT,
          },
        },
        catalogSearchSchema,
      );
      const exactMatches = response.results.filter((product) => hasExactGtin(product, gtin));
      return exactMatches.length === 1 ? (exactMatches[0]?.id ?? null) : null;
    } catch {
      return null;
    }
  }
}
