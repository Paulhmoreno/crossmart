import { Injectable } from '@nestjs/common';
import type {
  SellerCredentialValues,
  VerifiedSellerAccount,
} from '../../sdk/auth/seller-credentials.js';
import type { ChannelAccountProfile } from '../../sdk/channel-settings.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import {
  WOOCOMMERCE_DEFAULT_CURRENCY,
  WOOCOMMERCE_DEFAULT_DIMENSION_UNIT,
  WOOCOMMERCE_DEFAULT_WEIGHT_UNIT,
} from '../woocommerce.constants.js';
import type { WooCommerceSettings } from '../woocommerce-settings.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooProduct, WooSettingRow } from '../api/woocommerce-api.types.js';
import {
  serializeWooCommerceSecrets,
  type WooCommerceAccount,
  wooCommerceExternalAccountId,
  wooCommerceInputFromValues,
} from './woocommerce-credentials.js';

function settingString(rows: readonly WooSettingRow[], id: string, fallback: string): string {
  const row = rows.find((item) => item.id === id);
  return typeof row?.value === 'string' && row.value.trim().length > 0
    ? row.value.trim()
    : fallback;
}

function settingBoolean(rows: readonly WooSettingRow[], id: string): boolean {
  const row = rows.find((item) => item.id === id);
  return row?.value === 'yes' || row?.value === true;
}

function parseTotalHeader(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['x-wp-total'];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Verifies WooCommerce REST API v3 credentials (and optional WordPress Application Password
 * for binary media uploads) using strictly read-only endpoints.
 */
@Injectable()
export class WooCommerceAccountVerifier {
  constructor(private readonly api: WooCommerceApiClient) {}

  async verify(values: SellerCredentialValues): Promise<VerifiedSellerAccount> {
    const input = wooCommerceInputFromValues(values);
    const account: WooCommerceAccount = {
      ...input,
      currencyCode: WOOCOMMERCE_DEFAULT_CURRENCY,
      weightUnit: WOOCOMMERCE_DEFAULT_WEIGHT_UNIT,
      dimensionUnit: WOOCOMMERCE_DEFAULT_DIMENSION_UNIT,
    };

    const profile = await this.describe(account);
    const sealed = serializeWooCommerceSecrets({
      consumerKey: input.consumerKey,
      consumerSecret: input.consumerSecret,
      ...(input.wpUsername ? { wpUsername: input.wpUsername } : {}),
      ...(input.wpAppPassword ? { wpAppPassword: input.wpAppPassword } : {}),
    });

    return {
      externalAccountId: wooCommerceExternalAccountId(input.storeUrl),
      credentials: { accessToken: sealed },
      grantedScopes: [],
      profile,
    };
  }

  async describe(account: WooCommerceAccount): Promise<ChannelAccountProfile<WooCommerceSettings>> {
    const auth = {
      storeUrl: account.storeUrl,
      consumerKey: account.consumerKey,
      consumerSecret: account.consumerSecret,
    };

    // 1. Verify read access to products (mandatory) and read store general settings
    const [productsRes, generalRows, siteName] = await Promise.all([
      this.api.request<WooProduct[]>(auth, HttpMethod.Get, '/products?per_page=1&status=any'),
      this.readSettingsOptional(auth, '/settings/general'),
      this.api.readSiteName(account.storeUrl),
    ]);

    const productSettingsRows = await this.readSettingsOptional(auth, '/settings/products');

    // 2. If WordPress Media credentials are supplied, verify they have `upload_files` permission
    const hasWordPressMediaAuth = Boolean(account.wpUsername && account.wpAppPassword);
    if (account.wpUsername && account.wpAppPassword) {
      await this.api.verifyWordPressMediaAuth({
        storeUrl: account.storeUrl,
        username: account.wpUsername,
        appPassword: account.wpAppPassword,
      });
    }

    const currencyCode = settingString(
      generalRows,
      'woocommerce_currency',
      WOOCOMMERCE_DEFAULT_CURRENCY,
    ).toUpperCase();
    const pricesIncludeTax = settingBoolean(generalRows, 'woocommerce_prices_include_tax');
    const weightUnit = settingString(
      productSettingsRows,
      'woocommerce_weight_unit',
      WOOCOMMERCE_DEFAULT_WEIGHT_UNIT,
    );
    const dimensionUnit = settingString(
      productSettingsRows,
      'woocommerce_dimension_unit',
      WOOCOMMERCE_DEFAULT_DIMENSION_UNIT,
    );
    const hostFallback = new URL(account.storeUrl).host;
    const storeName = siteName ?? hostFallback;
    const remoteProductCount = parseTotalHeader(productsRes.headers);

    return {
      displayName: storeName,
      settings: {
        channel: ChannelType.WooCommerce,
        storeUrl: account.storeUrl,
        storeName,
        currencyCode,
        pricesIncludeTax,
        weightUnit,
        dimensionUnit,
        defaultStatus: account.defaultStatus,
        hasWordPressMediaAuth,
        wpUsername: account.wpUsername,
        remoteProductCount,
      },
    };
  }

  private async readSettingsOptional(
    auth: { storeUrl: string; consumerKey: string; consumerSecret: string },
    path: string,
  ): Promise<WooSettingRow[]> {
    try {
      const response = await this.api.request<WooSettingRow[]>(auth, HttpMethod.Get, path);
      return Array.isArray(response.data) ? response.data : [];
    } catch {
      return [];
    }
  }
}
