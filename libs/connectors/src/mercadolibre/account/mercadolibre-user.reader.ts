import { Injectable } from '@nestjs/common';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { MercadoLibreApiClient } from '../api/mercadolibre-api.client.js';
import {
  MERCADOLIBRE_GRANT_PATH,
  MERCADOLIBRE_ME_PATH,
  MERCADOLIBRE_SITE_LISTING_TYPES_PATH,
  MercadoLibrePathParam,
} from '../mercadolibre.constants.js';
import type { MercadoLibreSiteId } from '../mercadolibre-site.js';
import {
  type MercadoLibreSiteListingType,
  type MercadoLibreUser,
  mercadoLibreRevokedGrantSchema,
  mercadoLibreSiteListingTypesSchema,
  mercadoLibreUserSchema,
} from './mercadolibre-user.types.js';

/** The seller a token belongs to, site listing types, and the app's grant on their account. */
@Injectable()
export class MercadoLibreUserReader {
  constructor(private readonly api: MercadoLibreApiClient) {}

  readMe(accessToken: string): Promise<MercadoLibreUser> {
    return this.api.get({ accessToken, path: MERCADOLIBRE_ME_PATH }, mercadoLibreUserSchema);
  }

  /** Real listing types offered by the site (`GET /sites/{site_id}/listing_types`). */
  readListingTypes(
    accessToken: string,
    siteId: MercadoLibreSiteId,
  ): Promise<MercadoLibreSiteListingType[]> {
    return this.api.get(
      {
        accessToken,
        path: MERCADOLIBRE_SITE_LISTING_TYPES_PATH,
        params: { [MercadoLibrePathParam.SiteId]: siteId },
      },
      mercadoLibreSiteListingTypesSchema,
    );
  }

  /** Removes the app's authorization from the seller's account. */
  async revokeGrant(accessToken: string, userId: string, appId: string): Promise<void> {
    await this.api.call(
      {
        method: HttpMethod.Delete,
        accessToken,
        path: MERCADOLIBRE_GRANT_PATH,
        params: { [MercadoLibrePathParam.UserId]: userId, [MercadoLibrePathParam.AppId]: appId },
      },
      mercadoLibreRevokedGrantSchema,
    );
  }
}
