import { BadRequestException, ConflictException } from '@nestjs/common';
import { CatalogSourceKind } from '@crossmart/database';
import type { ProductDraft } from '../entities/product-draft.js';
import { toAmount } from '../mappers/decimal-amount.mapper.js';
import type { ProductDetailRecord } from '../repositories/product.queries.js';

export const ODOO_MANAGED_PRICE_MESSAGE =
  'Base price is managed by Odoo and cannot be edited manually. Use channel-specific price overrides instead.';
export const ODOO_MANAGED_STOCK_MESSAGE =
  'Stock is managed by Odoo and cannot be adjusted manually.';
export const ODOO_MANAGED_DELETE_MESSAGE = 'Products synced from Odoo cannot be deleted manually.';
export const ODOO_MANAGED_BULK_PRICE_MESSAGE =
  'Base prices of products synced from Odoo cannot be bulk-adjusted.';

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Enforces source-owned field protection when editing a product synced from Odoo.
 * Commercial fields (title, description, tags, productType, vendor, status, condition,
 * compareAtPrice, shipping/tax flags, extra manual images) stay editable.
 * ERP-owned fields (variant identity, option structure, SKU, barcode, base price, stock,
 * and original Odoo-managed photos) cannot be modified or removed through manual edits.
 */
export function assertSourceManagedUpdateAllowed(
  existing: ProductDetailRecord,
  draft: ProductDraft,
): void {
  if (existing.sourceKind !== CatalogSourceKind.ODOO) return;

  const violations: string[] = [];

  if (!arraysEqual(existing.optionNames, draft.optionNames)) {
    violations.push('options');
  }

  const existingById = new Map(existing.variants.map((variant) => [variant.id, variant]));
  const hasAddedVariant = draft.variants.some(
    (variant) => !variant.id || !existingById.has(variant.id),
  );
  const draftIds = new Set(draft.variants.flatMap((variant) => (variant.id ? [variant.id] : [])));
  const hasRemovedVariant = existing.variants.some((variant) => !draftIds.has(variant.id));

  if (hasAddedVariant || hasRemovedVariant) {
    violations.push('variants');
  }

  for (const variant of draft.variants) {
    if (!variant.id) continue;
    const current = existingById.get(variant.id);
    if (!current) continue;

    if (normalizedText(variant.sku) !== normalizedText(current.sku)) {
      violations.push('SKU');
    }
    if (normalizedText(variant.barcode) !== normalizedText(current.barcode)) {
      violations.push('barcode/EAN');
    }
    if (!arraysEqual(variant.optionValues, current.optionValues)) {
      violations.push('variant attributes');
    }
    if (variant.price !== toAmount(current.price)) {
      violations.push('base price');
    }
    const currentTracked = current.inventoryItem?.tracked ?? false;
    const currentAvailable = current.inventoryItem?.available ?? 0;
    if (variant.inventory.tracked !== currentTracked) {
      violations.push('stock tracking');
    }
    if (
      variant.inventory.quantity !== undefined &&
      variant.inventory.quantity !== currentAvailable
    ) {
      violations.push('stock');
    }
  }

  const draftMediaUrls = new Set(draft.media.map((item) => item.url));
  const removedManagedPhoto = existing.media.some(
    (item) => item.sourceManaged && !draftMediaUrls.has(item.url),
  );
  if (removedManagedPhoto) {
    violations.push('original Odoo photos');
  }

  if (violations.length > 0) {
    const unique = [...new Set(violations)].join(', ');
    throw new BadRequestException(
      `This field is managed by Odoo and cannot be edited manually (${unique}).`,
    );
  }
}

export function assertSourceManagedDeleteAllowed(sourceKind: CatalogSourceKind): void {
  if (sourceKind === CatalogSourceKind.ODOO) {
    throw new ConflictException(ODOO_MANAGED_DELETE_MESSAGE);
  }
}
