import { z } from 'zod';

/**
 * An attribute as items take it: by the category's attribute `id`, or by `name` for a custom
 * attribute (User Products). `value_id` is sent when matched to an official allowed value.
 */
export interface MercadoLibreAttributeInput {
  id?: string;
  name?: string;
  value_id?: string;
  value_name: string;
}

/** A picture by uploaded Mercado Libre `id` or public HTTPS `source` URL. */
export type MercadoLibrePictureInput = { source: string } | { id: string };

/** A sale term (`WARRANTY_TYPE`, `WARRANTY_TIME`) when explicitly configured by the merchant. */
export interface MercadoLibreSaleTermInput {
  id: string;
  value_name: string;
}

/** Shipping overrides sent only when explicitly configured on the store connection. */
export interface MercadoLibreShippingInput {
  mode?: string;
  local_pick_up?: boolean;
}

/** A variation of a single item (sellers without User Products). */
export interface MercadoLibreVariationInput {
  id?: number;
  price: number;
  available_quantity: number;
  attribute_combinations?: MercadoLibreAttributeInput[];
  attributes?: MercadoLibreAttributeInput[];
  picture_ids?: string[];
  /** Crossmart's variant id, so the created variation can be matched to it. */
  seller_custom_field?: string;
}

/** The body of `POST /items`, `POST /items/validate`, and `PUT /items/{id}`. */
export interface MercadoLibreItemInput {
  title?: string;
  family_name?: string;
  category_id?: string;
  price?: number;
  currency_id?: string;
  available_quantity?: number;
  buying_mode?: string;
  condition?: string;
  listing_type_id?: string;
  catalog_product_id?: string;
  seller_custom_field?: string;
  pictures?: MercadoLibrePictureInput[];
  attributes?: MercadoLibreAttributeInput[];
  sale_terms?: MercadoLibreSaleTermInput[];
  shipping?: MercadoLibreShippingInput;
  variations?: MercadoLibreVariationInput[];
  status?: string;
}

/** A stock or price change of one variation, in a `PUT /items/{id}` that lists them all. */
export interface MercadoLibreVariationUpdate {
  id: number;
  available_quantity?: number;
  price?: number;
}

/** The fields Crossmart reads from an item (`POST /items`, `GET` and `PUT /items/{id}`). */
export const mercadoLibreItemSchema = z.object({
  id: z.string(),
  seller_id: z.number().int().optional(),
  title: z.string().optional(),
  category_id: z.string().optional(),
  listing_type_id: z.string().optional(),
  price: z.number().optional(),
  available_quantity: z.number().int().optional(),
  status: z.string(),
  sub_status: z.array(z.string()).default([]),
  permalink: z.string().nullish(),
  sold_quantity: z.number().int().default(0),
  family_name: z.string().nullish(),
  seller_custom_field: z.string().nullish(),
  pictures: z
    .array(
      z.object({
        id: z.string(),
        secure_url: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  attributes: z
    .array(
      z.object({
        id: z.string(),
        value_id: z.string().nullish(),
        value_name: z.string().nullish(),
      }),
    )
    .default([]),
  variations: z
    .array(
      z.object({
        id: z.number().int(),
        price: z.number().optional(),
        available_quantity: z.number().int().optional(),
        seller_custom_field: z.string().nullish(),
      }),
    )
    .default([]),
});

export type MercadoLibreItem = z.infer<typeof mercadoLibreItemSchema>;

/** `GET`, `POST` and `PUT /items/{id}/description`. */
export const mercadoLibreDescriptionSchema = z
  .object({
    plain_text: z.string().optional(),
  })
  .loose();

export type MercadoLibreDescription = z.infer<typeof mercadoLibreDescriptionSchema>;

/** `GET /users/{user_id}/items/search?seller_sku=...`. */
export const mercadoLibreUserItemsSearchSchema = z.object({
  results: z.array(z.string()).default([]),
});

/** Cause entry in `POST /items/validate` error responses. */
export const mercadoLibreValidateCauseSchema = z.object({
  type: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export type MercadoLibreValidateCause = z.infer<typeof mercadoLibreValidateCauseSchema>;
