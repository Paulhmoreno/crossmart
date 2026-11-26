import { Injectable } from '@nestjs/common';
import type { ListingDraft } from '../../sdk/capabilities/listing-publisher.js';
import type { ChannelCategory } from '../../sdk/capabilities/taxonomy-provider.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import { MercadoLibreApiClient } from '../api/mercadolibre-api.client.js';
import {
  MERCADOLIBRE_CATEGORY_PATH,
  MERCADOLIBRE_CATEGORY_PATH_SEPARATOR,
  MERCADOLIBRE_CATEGORY_SUGGESTIONS_MAX,
  MERCADOLIBRE_DOMAIN_DISCOVERY_PATH,
  MercadoLibrePathParam,
  MercadoLibreQueryParam,
} from '../mercadolibre.constants.js';
import type { MercadoLibreSiteId } from '../mercadolibre-site.js';
import {
  domainDiscoverySchema,
  type MercadoLibreCategory,
  mercadoLibreCategorySchema,
} from './mercadolibre-taxonomy.types.js';

const NO_VALID_CATEGORY =
  'Mercado Libre suggested no publishable leaf category for this product. Choose one for it.';

/** A resolved category with both its Crossmart display label and Mercado Libre's live settings. */
export interface ResolvedMercadoLibreCategory {
  category: ChannelCategory;
  details: MercadoLibreCategory;
}

/** A category named with its ancestors: "Celulares y Teléfonos > Celulares y Smartphones". */
export function categoryPathName(category: MercadoLibreCategory): string {
  const path = category.path_from_root.length > 0 ? category.path_from_root : [category];
  return path.map((node) => node.name).join(MERCADOLIBRE_CATEGORY_PATH_SEPARATOR);
}

/** Whether a category belongs to `siteId`, is a leaf node, and allows listing. */
export function isPublishableLeafCategory(
  category: MercadoLibreCategory,
  siteId: MercadoLibreSiteId,
): boolean {
  if (!category.id.toUpperCase().startsWith(siteId)) return false;
  if (category.children_categories.length > 0) return false;
  if (category.settings?.listing_allowed === false) return false;
  return true;
}

/** Builds a clean domain_discovery query from title, brand, and model (never Odoo category paths). */
export function buildCategoryDiscoveryQuery(draft: ListingDraft): string {
  const title = draft.product.title.trim();
  const brand = draft.product.vendor?.trim() ?? '';
  const model = findModelSpecific(draft);
  const parts = [title];
  if (brand && !title.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
  if (model && !title.toLowerCase().includes(model.toLowerCase())) parts.push(model);
  return parts.join(' ').trim();
}

function findModelSpecific(draft: ListingDraft): string {
  const entry = (draft.itemSpecifics ?? []).find((item) => {
    const key = item.name.trim().toLowerCase();
    return key === 'model' || key === 'modelo';
  });
  return entry?.values[0]?.trim() ?? '';
}

function categoryError(reason: string): ChannelError {
  return ChannelError.unmet(ChannelType.MercadoLibre, {
    requirement: PublishRequirement.Category,
    reason,
  });
}

/**
 * Mercado Libre's categories: official `domain_discovery` predictor, verified against
 * `GET /categories/{id}` for site ownership, leaf status, and publishability.
 */
@Injectable()
export class MercadoLibreCategoryReader {
  constructor(private readonly api: MercadoLibreApiClient) {}

  async suggest(
    accessToken: string,
    siteId: MercadoLibreSiteId,
    query: string,
  ): Promise<ChannelCategory[]> {
    const resolved = await this.discoverCandidates(accessToken, siteId, query);
    return resolved.map((entry) => entry.category);
  }

  async readDetails(accessToken: string, categoryId: string): Promise<MercadoLibreCategory> {
    return this.api.get(
      {
        accessToken,
        path: MERCADOLIBRE_CATEGORY_PATH,
        params: { [MercadoLibrePathParam.CategoryId]: categoryId },
      },
      mercadoLibreCategorySchema,
    );
  }

  async category(accessToken: string, categoryId: string): Promise<ChannelCategory> {
    const details = await this.readDetails(accessToken, categoryId);
    return { id: details.id, name: categoryPathName(details) };
  }

  /**
   * Resolves the publish category: validates an explicit manual selection, or predicts via
   * `domain_discovery` and validates site, leaf status, and publishability.
   */
  async resolveForPublish(
    accessToken: string,
    siteId: MercadoLibreSiteId,
    draft: ListingDraft,
  ): Promise<ResolvedMercadoLibreCategory> {
    if (draft.category) {
      return this.validateExplicitCategory(accessToken, siteId, draft.category);
    }
    const query = buildCategoryDiscoveryQuery(draft);
    const candidates = await this.discoverCandidates(accessToken, siteId, query);
    const [best] = candidates;
    if (!best) throw categoryError(NO_VALID_CATEGORY);
    return best;
  }

  private async validateExplicitCategory(
    accessToken: string,
    siteId: MercadoLibreSiteId,
    chosen: ChannelCategory,
  ): Promise<ResolvedMercadoLibreCategory> {
    const details = await this.readDetails(accessToken, chosen.id);
    if (!isPublishableLeafCategory(details, siteId)) {
      throw categoryError(
        `Category ${details.id} (${categoryPathName(details)}) cannot be listed on ${siteId}. Choose a publishable leaf category.`,
      );
    }
    return { category: { id: details.id, name: categoryPathName(details) }, details };
  }

  private async discoverCandidates(
    accessToken: string,
    siteId: MercadoLibreSiteId,
    query: string,
  ): Promise<ResolvedMercadoLibreCategory[]> {
    const predictions = await this.api.get(
      {
        accessToken,
        path: MERCADOLIBRE_DOMAIN_DISCOVERY_PATH,
        params: { [MercadoLibrePathParam.SiteId]: siteId },
        query: {
          [MercadoLibreQueryParam.Query]: query,
          [MercadoLibreQueryParam.Limit]: String(MERCADOLIBRE_CATEGORY_SUGGESTIONS_MAX),
        },
      },
      domainDiscoverySchema,
    );
    const categoryIds = [...new Set(predictions.map((prediction) => prediction.category_id))];
    const detailsList = await Promise.all(
      categoryIds.map((categoryId) => this.readDetails(accessToken, categoryId)),
    );
    return detailsList
      .filter((details) => isPublishableLeafCategory(details, siteId))
      .map((details) => ({
        category: { id: details.id, name: categoryPathName(details) },
        details,
      }));
  }
}
