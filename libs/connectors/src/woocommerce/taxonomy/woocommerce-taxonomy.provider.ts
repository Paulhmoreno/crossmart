import { Injectable } from '@nestjs/common';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import {
  type CategoryAspect,
  CategoryAspectMode,
  CategoryAspectUsage,
  type ChannelCategory,
  type TaxonomyProvider,
} from '../../sdk/capabilities/taxonomy-provider.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { type WooCommerceAccount, wooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient, WooCommerceApiError } from '../api/woocommerce-api.client.js';
import type {
  WooAttribute,
  WooAttributeTerm,
  WooCategory,
  WooTerm,
} from '../api/woocommerce-api.types.js';
import {
  WOOCOMMERCE_MAX_TAXONOMY_PAGES,
  WOOCOMMERCE_TAXONOMY_PAGE_SIZE,
} from '../woocommerce.constants.js';
import { wooCommerceError } from '../woocommerce-errors.js';

const MAX_SUGGESTIONS = 25;
const MAX_TERMS_PER_ATTRIBUTE = 50;
const FIRST_PAGE = 1;
const SCORE_EXACT = 100;
const SCORE_NAME_MATCH = 75;
const SCORE_PATH_MATCH = 50;
const SCORE_TOKEN_MAX = 40;
const HTTP_NOT_FOUND = 404;

const TERM_EXISTS_CODES = new Set([
  'term_exists',
  'woocommerce_rest_term_exists',
  'rest_term_exists',
]);

export type WooTermResource = 'categories' | 'brands' | 'tags';

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

export function normalizeWooText(value: string): string {
  return decodeHtmlEntities(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function normalizeExactTermName(value: string): string {
  return decodeHtmlEntities(value).normalize('NFKC').toLowerCase().trim();
}

export function toWooSlug(value: string): string {
  return (
    decodeHtmlEntities(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'term'
  );
}

export function parseCategorySegments(categoryText: string): string[] {
  return categoryText
    .split(/\s*(?:>|\/)\s*/)
    .map((segment) => decodeHtmlEntities(segment).trim())
    .filter((segment) => segment.length > 0);
}

function buildCategoryPath(category: WooCategory, byId: Map<number, WooCategory>): string {
  const parts: string[] = [];
  const visited = new Set<number>();
  let current: WooCategory | undefined = category;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    parts.unshift(decodeHtmlEntities(current.name).trim());
    current = current.parent > 0 ? byId.get(current.parent) : undefined;
  }
  return parts.join(' > ');
}

function scoreCategoryMatch(path: string, name: string, query: string): number {
  const normalizedQuery = normalizeWooText(query);
  if (!normalizedQuery) return 1;
  const normalizedName = normalizeWooText(name);
  const normalizedPath = normalizeWooText(path);
  if (normalizedName === normalizedQuery || normalizedPath === normalizedQuery) return SCORE_EXACT;
  if (normalizedName.includes(normalizedQuery)) return SCORE_NAME_MATCH;
  if (normalizedPath.includes(normalizedQuery)) return SCORE_PATH_MATCH;
  const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => normalizedPath.includes(token)).length;
  return matched > 0 ? Math.round((matched / tokens.length) * SCORE_TOKEN_MAX) : 0;
}

/**
 * Reads and resolves WooCommerce store categories, brands, tags, and global attributes
 * for Crossmart's native taxonomy picker and listing publisher.
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
    const attributes = await this.listGlobalAttributes(account);

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
        name: decodeHtmlEntities(attr.name).trim(),
        required: false,
        usage: CategoryAspectUsage.Optional,
        mode: CategoryAspectMode.FreeText,
        multiple: true,
        values: terms
          .slice(0, MAX_TERMS_PER_ATTRIBUTE)
          .map((term) => decodeHtmlEntities(term.name).trim()),
      });
    }

    return aspects;
  }

  async listGlobalAttributes(account: WooCommerceAccount): Promise<WooAttribute[]> {
    const attributesRes = await this.api.request<WooAttribute[]>(
      account,
      HttpMethod.Get,
      '/products/attributes',
    );
    return Array.isArray(attributesRes.data) ? attributesRes.data : [];
  }

  async ensureAttributeTerms(
    account: WooCommerceAccount,
    attributeId: number,
    optionValues: readonly string[],
  ): Promise<void> {
    const existing = await this.listAttributeTerms(account, attributeId);
    const existingNames = new Set(existing.map((term) => normalizeExactTermName(term.name)));
    const existingSlugs = new Set(existing.map((term) => term.slug.toLowerCase()));

    for (const raw of optionValues) {
      const name = raw.trim();
      if (!name) continue;
      const slug = toWooSlug(name);
      if (existingNames.has(normalizeExactTermName(name)) || existingSlugs.has(slug)) continue;
      try {
        await this.api.request<WooAttributeTerm>(
          account,
          HttpMethod.Post,
          `/products/attributes/${attributeId}/terms`,
          { name, slug },
        );
        existingNames.add(normalizeExactTermName(name));
        existingSlugs.add(slug);
      } catch (error) {
        if (error instanceof WooCommerceApiError && TERM_EXISTS_CODES.has(error.wooCode)) {
          continue;
        }
        throw error;
      }
    }
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

  /**
   * Resolves a hierarchical category path (e.g. "Computación / Teclados y Mouse / Mouse") level by
   * level under its exact parent, reusing existing terms and creating only missing levels.
   * Uses path-scoped deterministic slugs so homonymous categories under different parents never
   * collide.
   */
  async resolveCategoryHierarchy(
    account: WooCommerceAccount,
    categoryText: string | null | undefined,
  ): Promise<ChannelCategory | null> {
    if (!categoryText?.trim()) return null;
    const segments = parseCategorySegments(categoryText);
    if (segments.length === 0) return null;

    let parentId = 0;
    const walked: string[] = [];
    for (const segment of segments) {
      walked.push(segment);
      const slug = toWooSlug(walked.join('-'));
      const term = await this.resolveTerm(account, 'categories', segment, slug, parentId);
      parentId = term.id;
    }

    return { id: String(parentId), name: walked.join(' > ') };
  }

  /**
   * Resolves a brand in WooCommerce's native `/products/brands` taxonomy, creating it only when
   * absent. Reports honestly when the store does not support the native brands REST API.
   */
  async resolveBrand(account: WooCommerceAccount, brandName: string): Promise<WooTerm> {
    const trimmed = brandName.trim();
    try {
      return await this.resolveTerm(account, 'brands', trimmed, toWooSlug(trimmed));
    } catch (error) {
      if (
        error instanceof WooCommerceApiError &&
        (error.httpStatus === HTTP_NOT_FOUND || error.wooCode === 'rest_no_route')
      ) {
        throw wooCommerceError(
          ChannelErrorCode.RequestRejected,
          'La instalación de WooCommerce no soporta la API nativa de marcas (/products/brands). Habilita la taxonomía nativa de marcas en WooCommerce para asignar marcas.',
        );
      }
      throw error;
    }
  }

  /**
   * Resolves an existing WooCommerce taxonomy term (`categories`, `brands`, or `tags`) by
   * deterministic slug or paginated exact case-insensitive name (scoped to `parent` for
   * hierarchical categories), creating it only if absent and recovering safely from `term_exists`
   * races. Non-duplicate API errors are always propagated.
   */
  async resolveTerm(
    account: WooCommerceAccount,
    resource: WooTermResource,
    rawName: string,
    slug: string,
    parent?: number,
  ): Promise<WooTerm> {
    const name = rawName.trim();
    const endpoint = `/products/${resource}`;
    const expectedParent = resource === 'categories' ? (parent ?? 0) : undefined;
    const matchesParent = (term: WooTerm): boolean =>
      resource !== 'categories' || (term.parent ?? 0) === expectedParent;
    const targetName = normalizeExactTermName(name);

    const lookup = async (): Promise<WooTerm | null> => {
      const bySlugRes = await this.api.request<WooTerm[]>(
        account,
        HttpMethod.Get,
        `${endpoint}?slug=${encodeURIComponent(slug)}`,
      );
      const bySlugRows = Array.isArray(bySlugRes.data) ? bySlugRes.data : [];
      const slugMatch = bySlugRows.find(matchesParent);
      if (slugMatch) return slugMatch;

      const parentQuery = resource === 'categories' ? `&parent=${expectedParent}` : '';
      for (let page = FIRST_PAGE; page <= WOOCOMMERCE_MAX_TAXONOMY_PAGES; page += 1) {
        const searchRes = await this.api.request<WooTerm[]>(
          account,
          HttpMethod.Get,
          `${endpoint}?search=${encodeURIComponent(name)}&per_page=${WOOCOMMERCE_TAXONOMY_PAGE_SIZE}&page=${page}${parentQuery}`,
        );
        const rows = Array.isArray(searchRes.data) ? searchRes.data : [];
        const exact = rows.find(
          (term) => matchesParent(term) && normalizeExactTermName(term.name) === targetName,
        );
        if (exact) return exact;
        if (rows.length < WOOCOMMERCE_TAXONOMY_PAGE_SIZE) return null;
      }
      return null;
    };

    const existing = await lookup();
    if (existing) return existing;

    try {
      const created = (
        await this.api.request<WooTerm>(account, HttpMethod.Post, endpoint, {
          name,
          slug,
          ...(resource === 'categories' ? { parent: expectedParent } : {}),
        })
      ).data;
      if (!created || !Number.isInteger(created.id) || created.id <= 0) {
        throw wooCommerceError(
          ChannelErrorCode.RequestRejected,
          `WooCommerce devolvió un ID inválido al crear "${name}" en ${resource}.`,
        );
      }
      return created;
    } catch (error) {
      if (error instanceof WooCommerceApiError && TERM_EXISTS_CODES.has(error.wooCode)) {
        const winner = await lookup();
        if (winner) return winner;
      }
      throw error;
    }
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
