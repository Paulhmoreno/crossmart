import type {
  ListingDraft,
  ListingDraftVariant,
} from '../../sdk/capabilities/listing-publisher.js';
import { MercadoLibreAttributeId } from '../mercadolibre.constants.js';
import { isMerchantAttribute } from '../taxonomy/mercadolibre-category-aspects.js';
import type { MercadoLibreAttribute } from '../taxonomy/mercadolibre-taxonomy.types.js';
import type { MercadoLibreAttributeInput } from './mercadolibre-item.types.js';

const DIACRITICS = /\p{Diacritic}/gu;
const DECOMPOSED = 'NFD';
/** Several values of a multivalued attribute go in one `value_name`, comma-separated. */
const VALUE_SEPARATOR = ',';

/** Names compare without case or accents, so "Color" finds "Color" and "Género" "genero". */
function nameKey(name: string): string {
  return name.trim().normalize(DECOMPOSED).replace(DIACRITICS, '').toLowerCase();
}

/**
 * A category's attributes by name and id, so item specifics and option names are sent using
 * official attribute ids and official `value_id` when a value matches the category's allowed list.
 */
export class MercadoLibreAttributeIndex {
  private readonly byName: ReadonlyMap<string, MercadoLibreAttribute>;
  private readonly byId: ReadonlyMap<string, MercadoLibreAttribute>;

  constructor(
    readonly attributes: readonly MercadoLibreAttribute[],
    private readonly allowsCustom: boolean,
  ) {
    this.byName = new Map(attributes.map((attribute) => [nameKey(attribute.name), attribute]));
    this.byId = new Map(attributes.map((attribute) => [attribute.id, attribute]));
  }

  /** The attribute named so, sent by id (with official `value_id` when matched), or custom. */
  toInput(name: string, values: readonly string[]): MercadoLibreAttributeInput | null {
    const valueName = values.join(VALUE_SEPARATOR);
    const attribute = this.byName.get(nameKey(name)) ?? this.byId.get(name.trim().toUpperCase());
    if (attribute) {
      const matchedValue =
        values.length === 1
          ? attribute.values.find(
              (candidate) =>
                nameKey(candidate.name) === nameKey(valueName) || candidate.id === valueName,
            )
          : undefined;
      return matchedValue
        ? { id: attribute.id, value_id: matchedValue.id, value_name: matchedValue.name }
        : { id: attribute.id, value_name: valueName };
    }
    return this.allowsCustom ? { name: name.trim(), value_name: valueName } : null;
  }

  has(name: string): boolean {
    return this.byName.has(nameKey(name)) || this.byId.has(name.trim().toUpperCase());
  }

  byAttributeId(id: string): MercadoLibreAttribute | undefined {
    return this.byId.get(id);
  }
}

function optionKeys(draft: ListingDraft): Set<string> {
  return new Set(draft.product.optionNames.map(nameKey));
}

function brandOf(draft: ListingDraft): string | null {
  const vendor = draft.product.vendor?.trim();
  return vendor ? vendor : null;
}

/** The merchant's item specifics, but not those named like an option, which vary by variant. */
function specificAttributes(
  draft: ListingDraft,
  index: MercadoLibreAttributeIndex,
): MercadoLibreAttributeInput[] {
  const options = optionKeys(draft);
  return (draft.itemSpecifics ?? []).flatMap(({ name, values }) => {
    if (values.length === 0 || options.has(nameKey(name))) return [];
    const input = index.toInput(name, values);
    return input ? [input] : [];
  });
}

/** Attributes of the whole product: its item specifics, and the vendor as brand without one. */
export function productAttributes(
  draft: ListingDraft,
  index: MercadoLibreAttributeIndex,
): MercadoLibreAttributeInput[] {
  const attributes = specificAttributes(draft, index);
  const brand = brandOf(draft);
  const hasBrand = attributes.some((input) => input.id === MercadoLibreAttributeId.Brand);
  return brand && !hasBrand
    ? [{ id: MercadoLibreAttributeId.Brand, value_name: brand }, ...attributes]
    : attributes;
}

/** A variant's option values, such as `COLOR: Negro`, by the category's attribute ids. */
export function optionAttributes(
  draft: ListingDraft,
  variant: ListingDraftVariant,
  index: MercadoLibreAttributeIndex,
): MercadoLibreAttributeInput[] {
  return draft.product.optionNames.flatMap((name, position) => {
    const value = variant.optionValues[position]?.trim();
    const input = value ? index.toInput(name, [value]) : null;
    return input ? [input] : [];
  });
}

const GRAMS_PER_KILOGRAM = 1000;
const WEIGHT_KG_DECIMALS = 2;

/** What identifies a variant: SKU, GTIN, and real package weight when present and accepted. */
export function identifierAttributes(
  variant: ListingDraftVariant,
  index?: MercadoLibreAttributeIndex,
): MercadoLibreAttributeInput[] {
  const attributes: MercadoLibreAttributeInput[] = [
    ...(variant.sku ? [{ id: MercadoLibreAttributeId.SellerSku, value_name: variant.sku }] : []),
    ...(variant.barcode ? [{ id: MercadoLibreAttributeId.Gtin, value_name: variant.barcode }] : []),
  ];
  if (
    variant.weightGrams &&
    variant.weightGrams > 0 &&
    index?.byAttributeId(MercadoLibreAttributeId.PackageWeight)
  ) {
    const value =
      variant.weightGrams >= GRAMS_PER_KILOGRAM
        ? `${Number((variant.weightGrams / GRAMS_PER_KILOGRAM).toFixed(WEIGHT_KG_DECIMALS))} kg`
        : `${Math.round(variant.weightGrams)} g`;
    attributes.push({ id: MercadoLibreAttributeId.PackageWeight, value_name: value });
  }
  return attributes;
}

/** Names of the category's required attributes the listing would be sent without. */
export function missingRequiredAttributes(
  draft: ListingDraft,
  index: MercadoLibreAttributeIndex,
): string[] {
  const given = new Set([
    ...productAttributes(draft, index).flatMap((input) => (input.id ? [input.id] : [])),
    ...draft.product.optionNames.flatMap((name) => (index.has(name) ? [nameKey(name)] : [])),
  ]);
  return index.attributes
    .filter((attribute) => attribute.tags.required && isMerchantAttribute(attribute))
    .filter((attribute) => !given.has(attribute.id) && !given.has(nameKey(attribute.name)))
    .map((attribute) => attribute.name);
}
