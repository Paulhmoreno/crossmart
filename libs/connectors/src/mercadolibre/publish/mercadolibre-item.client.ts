import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { parseJsonBody } from '../../sdk/http/parse-json.js';
import { MercadoLibreApiClient } from '../api/mercadolibre-api.client.js';
import {
  MERCADOLIBRE_CAUSE_SEPARATOR,
  MERCADOLIBRE_DESCRIPTION_API_VERSION,
  MERCADOLIBRE_ITEM_DESCRIPTION_PATH,
  MERCADOLIBRE_ITEM_PATH,
  MERCADOLIBRE_ITEMS_PATH,
  MERCADOLIBRE_ITEMS_VALIDATE_PATH,
  MERCADOLIBRE_MESSAGE_MAX_LENGTH,
  MERCADOLIBRE_USER_ITEMS_SEARCH_PATH,
  MercadoLibrePathParam,
  MercadoLibreQueryParam,
} from '../mercadolibre.constants.js';
import type { MercadoLibreItemStatus } from '../mercadolibre.enums.js';
import {
  type MercadoLibreDescription,
  type MercadoLibreItem,
  type MercadoLibreItemInput,
  type MercadoLibreValidateCause,
  type MercadoLibreVariationUpdate,
  mercadoLibreDescriptionSchema,
  mercadoLibreItemSchema,
  mercadoLibreUserItemsSearchSchema,
  mercadoLibreValidateCauseSchema,
} from './mercadolibre-item.types.js';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_BAD_REQUEST = 400;
const WARNING_CAUSE_TYPE = 'warning';

const validateBodySchema = z.object({
  message: z.string().optional(),
  cause: z.array(mercadoLibreValidateCauseSchema).default([]),
});

export interface MercadoLibreValidationOutcome {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

function itemParams(itemId: string): Partial<Record<MercadoLibrePathParam, string>> {
  return { [MercadoLibrePathParam.ItemId]: itemId };
}

function splitValidationCauses(causes: readonly MercadoLibreValidateCause[]): {
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const cause of causes) {
    const text = cause.message?.trim() || cause.code?.trim();
    if (!text) continue;
    if (cause.type === WARNING_CAUSE_TYPE) warnings.push(text);
    else errors.push(text);
  }
  return { warnings, errors };
}

/** Items, official `POST /items/validate`, SKU lookup, and descriptions. */
@Injectable()
export class MercadoLibreItemClient {
  constructor(private readonly api: MercadoLibreApiClient) {}

  /** Official pre-validation (`POST /items/validate`); distinguishes warnings from blocking errors. */
  async validate(
    accessToken: string,
    body: MercadoLibreItemInput,
  ): Promise<MercadoLibreValidationOutcome> {
    const response = await this.api.request({
      method: HttpMethod.Post,
      accessToken,
      path: MERCADOLIBRE_ITEMS_VALIDATE_PATH,
      body,
    });
    if (response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX) {
      return { valid: true, warnings: [], errors: [] };
    }
    if (response.status === HTTP_BAD_REQUEST) {
      const parsed = validateBodySchema.safeParse(parseJsonBody(response.body));
      if (parsed.success) {
        const { warnings, errors } = splitValidationCauses(parsed.data.cause);
        if (errors.length === 0 && warnings.length === 0 && parsed.data.message?.trim()) {
          errors.push(parsed.data.message.trim());
        }
        return { valid: errors.length === 0, warnings, errors };
      }
    }
    throw new ChannelError(
      ChannelType.MercadoLibre,
      ChannelErrorCode.RequestRejected,
      `Mercado Libre pre-validation failed (HTTP ${response.status})`.slice(
        0,
        MERCADOLIBRE_MESSAGE_MAX_LENGTH,
      ),
    );
  }

  /** Throws a clean ChannelError if `POST /items/validate` reports blocking errors. */
  async assertValid(accessToken: string, body: MercadoLibreItemInput): Promise<string[]> {
    const outcome = await this.validate(accessToken, body);
    if (!outcome.valid) {
      const detail = outcome.errors
        .join(MERCADOLIBRE_CAUSE_SEPARATOR)
        .slice(0, MERCADOLIBRE_MESSAGE_MAX_LENGTH);
      throw new ChannelError(ChannelType.MercadoLibre, ChannelErrorCode.RequestRejected, detail);
    }
    return outcome.warnings;
  }

  create(accessToken: string, body: MercadoLibreItemInput): Promise<MercadoLibreItem> {
    return this.api.call(
      { method: HttpMethod.Post, accessToken, path: MERCADOLIBRE_ITEMS_PATH, body },
      mercadoLibreItemSchema,
    );
  }

  /** The item, or null when Mercado Libre no longer has it. */
  find(accessToken: string, itemId: string): Promise<MercadoLibreItem | null> {
    return this.api.find(
      { accessToken, path: MERCADOLIBRE_ITEM_PATH, params: itemParams(itemId) },
      mercadoLibreItemSchema,
    );
  }

  /** Searches the seller's own items by SKU (`GET /users/{user_id}/items/search?seller_sku=...`). */
  async searchOwnItemsBySku(accessToken: string, userId: string, sku: string): Promise<string[]> {
    const response = await this.api.get(
      {
        accessToken,
        path: MERCADOLIBRE_USER_ITEMS_SEARCH_PATH,
        params: { [MercadoLibrePathParam.UserId]: userId },
        query: { [MercadoLibreQueryParam.SellerSku]: sku },
      },
      mercadoLibreUserItemsSearchSchema,
    );
    return response.results;
  }

  update(
    accessToken: string,
    itemId: string,
    body: MercadoLibreItemInput | { variations: MercadoLibreVariationUpdate[] },
  ): Promise<MercadoLibreItem> {
    return this.api.call(
      {
        method: HttpMethod.Put,
        accessToken,
        path: MERCADOLIBRE_ITEM_PATH,
        params: itemParams(itemId),
        body,
      },
      mercadoLibreItemSchema,
    );
  }

  setStatus(
    accessToken: string,
    itemId: string,
    status: MercadoLibreItemStatus,
  ): Promise<MercadoLibreItem> {
    return this.update(accessToken, itemId, { status });
  }

  /** Reads back the item's plain-text description (`GET /items/{id}/description`). */
  findDescription(accessToken: string, itemId: string): Promise<MercadoLibreDescription | null> {
    return this.api.find(
      { accessToken, path: MERCADOLIBRE_ITEM_DESCRIPTION_PATH, params: itemParams(itemId) },
      mercadoLibreDescriptionSchema,
    );
  }

  /** A new item's description; descriptions are sent after the item is created. */
  async addDescription(accessToken: string, itemId: string, plainText: string): Promise<void> {
    await this.api.call(
      {
        method: HttpMethod.Post,
        accessToken,
        path: MERCADOLIBRE_ITEM_DESCRIPTION_PATH,
        params: itemParams(itemId),
        body: { plain_text: plainText },
      },
      mercadoLibreDescriptionSchema,
    );
  }

  /** Replaces the description of an item that has one. */
  async replaceDescription(accessToken: string, itemId: string, plainText: string): Promise<void> {
    await this.api.call(
      {
        method: HttpMethod.Put,
        accessToken,
        path: MERCADOLIBRE_ITEM_DESCRIPTION_PATH,
        params: itemParams(itemId),
        query: { [MercadoLibreQueryParam.ApiVersion]: MERCADOLIBRE_DESCRIPTION_API_VERSION },
        body: { plain_text: plainText },
      },
      mercadoLibreDescriptionSchema,
    );
  }
}
