import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import {
  type CategoryAspect,
  CategoryAspectMode,
  CategoryAspectUsage,
  type ChannelCategory,
  type TaxonomyProvider,
} from '../../sdk/capabilities/taxonomy-provider.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { type WooCommerceAccount, wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooAttribute, WooAttributeTerm, WooCategory } from '../api/woocommerce-api.types.js';
import {
  WOOCOMMERCE_MAX_TAXONOMY_PAGES,
  WOOCOMMERCE_TAXONOMY_PAGE_SIZE,
} from '../woocommerce.constants.js';

const MAX_SUGGESTIONS = 25;
const MAX_TERMS_PER_ATTRIBUTE = 50;
const FIRST_PAGE = 1;
const SCORE_EXACT = 100;
const SCORE_NAME_MATCH = 75;
const SCORE_PATH_MATCH = 50;
const SCORE_TOKEN_MAX = 40;

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function buildCategoryPath(category: WooCategory, byId: Map<number, WooCategory>): string {
  const parts: string[] = [];
  const visited = new Set<number>();
  let current: WooCategory | undefined = category;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(current.name.trim());
    current = current.parent > 0 ? byId.get(current.parent) : undefined;
  }
  return parts.join(' > ');
}

function scoreCategoryMatch(path: string, name: string, query: string): number {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 1;
  const normalizedName = normalizeText(name);
  const normalizedPath = normalizeText(path);
  if (normalizedName === normalizedQuery || normalizedPath === normalizedQuery) return SCORE_EXACT;
  if (normalizedName.includes(normalizedQuery)) return SCORE_NAME_MATCH;
  if (normalizedPath.includes(normalizedQuery)) return SCORE_PATH_MATCH;
  const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => normalizedPath.includes(token)).length;
  return matched > 0 ? Math.round((matched / tokens.length) * SCORE_TOKEN_MAX) : 0;
}

/**
 * Reads WooCommerce store categories and global attributes for Crossmart's native listing
 * category picker and item specifics editor.
 */
@Injectable()
export class WooCommerceTaxonomyProvider implements TaxonomyProvider {
  constructor(private readonly api: WooCommerceApiClient) {}

  async suggestCategories(session: ChannelSession, query: string): Promise<ChannelCategory[]> {
    const { account } = await wooCommerceAccount(session);
    const categories = await this.listCategories(account);
    const byId = new Map(categories.map((cat) => [cat.id, cat]));

    const ranked = categories
      .map((cat) => {
        const path = buildCategoryPath(cat, byId);
        return {
          category: { id: String(cat.id), name: path },
          score: scoreCategoryMatch(path, cat.name, query),
        };
      })
      .filter((entry) => !query.trim() || entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.category.name.localeCompare(right.category.name),
      );

    return ranked.slice(0, MAX_SUGGESTIONS).map((entry) => entry.category);
  }

  async categoryAspects(session: ChannelSession, _categoryId: string): Promise<CategoryAspect[]> {
    const { account } = await wooCommerceAccount(session);
    const attributesRes = await this.api.request<WooAttribute[]>(
      account,
      HttpMethod.Get,
      '/products/attributes',
    );
    const attributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];

    const aspects: CategoryAspect[] = [
      {
        name: 'Descripción corta',
        required: false,
        usage: CategoryAspectUsage.Recommended,
        mode: CategoryAspectMode.FreeText,
        multiple: false,
        values: [],
      },
    ];

    for (const attr of attributes) {
      const terms = await this.listAttributeTerms(account, attr.id);
      aspects.push({
        name: attr.name.trim(),
        required: false,
        usage: CategoryAspectUsage.Optional,
        mode: CategoryAspectMode.FreeText,
        multiple: true,
        values: terms.slice(0, MAX_TERMS_PER_ATTRIBUTE).map((term) => term.name.trim()),
      });
    }

    return aspects;
  }

  async listCategories(account: WooCommerceAccount): Promise<WooCategory[]> {
    const all: WooCategory[] = [];
    for (let page = FIRST_PAGE; page <= WOOCOMMERCE_MAX_TAXONOMY_PAGES; page += 1) {
      const response = await this.api.request<WooCategory[]>(
        account,
        HttpMethod.Get,
        `/products/categories?per_page=${WOOCOMMERCE_TAXONOMY_PAGE_SIZE}&page=${page}`,
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      all.push(...rows);
      if (rows.length < WOOCOMMERCE_TAXONOMY_PAGE_SIZE) break;
    }
    return all;
  }

  /** Finds an existing WooCommerce category matching an Odoo/Crossmart category path reliably. */
  async findReliableCategoryMatch(
    account: WooCommerceAccount,
    categoryText: string | null | undefined,
  ): Promise<ChannelCategory | null> {
    if (!categoryText?.trim()) return null;
    const categories = await this.listCategories(account);
    const byId = new Map(categories.map((cat) => [cat.id, cat]));
    const normalizedSegments = categoryText
      .split(/[>/]/)
      .map((part) => normalizeText(part))
      .filter(Boolean);
    const leaf = normalizedSegments[normalizedSegments.length - 1];
    if (!leaf) return null;

    const exact = categories.find((cat) => {
      const normalizedPath = normalizeText(buildCategoryPath(cat, byId));
      const normalizedFull = normalizedSegments.join(' > ');
      return normalizedPath === normalizedFull || normalizeText(cat.name) === leaf;
    });
    if (!exact) return null;
    return { id: String(exact.id), name: buildCategoryPath(exact, byId) };
  }

  private async listAttributeTerms(
    account: WooCommerceAccount,
    attributeId: number,
  ): Promise<WooAttributeTerm[]> {
    try {
      const response = await this.api.request<WooAttributeTerm[]>(
        account,
        HttpMethod.Get,
        `/products/attributes/${attributeId}/terms?per_page=${MAX_TERMS_PER_ATTRIBUTE}`,
      );
      return Array.isArray(response.data) ? response.data : [];
    } catch {
      return [];
    }
  }
}
