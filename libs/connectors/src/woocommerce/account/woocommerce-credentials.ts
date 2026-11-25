import { z } from 'zod';
import type { ChannelSession } from '../../sdk/auth/channel-session.js';
import type {
  SellerCredentialField,
  SellerCredentialValues,
} from '../../sdk/auth/seller-credentials.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import {
  WOOCOMMERCE_KEY_MAX_LENGTH,
  WOOCOMMERCE_STATUS_MAX_LENGTH,
  WOOCOMMERCE_URL_MAX_LENGTH,
  WOOCOMMERCE_USERNAME_MAX_LENGTH,
} from '../woocommerce.constants.js';
import { WooCommerceCredentialField, WooCommercePublishStatus } from '../woocommerce.enums.js';
import { wooCommerceError } from '../woocommerce-errors.js';
import { isWooCommerceSettings, type WooCommerceSettings } from '../woocommerce-settings.js';

const NOT_SET_UP = 'Esta conexión de WooCommerce no tiene datos de cuenta. Conéctala nuevamente.';
const HTTPS_REQUIRED = 'La URL de la tienda WooCommerce debe usar HTTPS válido (https://...).';
const WP_PAIR_REQUIRED =
  'Para habilitar la subida de fotografías vía WordPress, ingresa tanto el usuario como la contraseña de aplicación.';

const sealedSecretsSchema = z.object({
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
  wpUsername: z.string().min(1).optional(),
  wpAppPassword: z.string().min(1).optional(),
});

export type WooCommerceSealedSecrets = z.infer<typeof sealedSecretsSchema>;

export interface WooCommerceAccount {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  wpUsername: string | null;
  wpAppPassword: string | null;
  defaultStatus: WooCommercePublishStatus;
  weightUnit: string;
  dimensionUnit: string;
  currencyCode: string;
}

export const WOOCOMMERCE_CREDENTIAL_FIELDS: readonly SellerCredentialField[] = [
  {
    key: WooCommerceCredentialField.StoreUrl,
    secret: false,
    maxLength: WOOCOMMERCE_URL_MAX_LENGTH,
  },
  {
    key: WooCommerceCredentialField.ConsumerKey,
    secret: true,
    maxLength: WOOCOMMERCE_KEY_MAX_LENGTH,
  },
  {
    key: WooCommerceCredentialField.ConsumerSecret,
    secret: true,
    maxLength: WOOCOMMERCE_KEY_MAX_LENGTH,
  },
  {
    key: WooCommerceCredentialField.WpUsername,
    secret: false,
    optional: true,
    maxLength: WOOCOMMERCE_USERNAME_MAX_LENGTH,
  },
  {
    key: WooCommerceCredentialField.WpAppPassword,
    secret: true,
    optional: true,
    maxLength: WOOCOMMERCE_KEY_MAX_LENGTH,
  },
  {
    key: WooCommerceCredentialField.DefaultStatus,
    secret: false,
    optional: true,
    maxLength: WOOCOMMERCE_STATUS_MAX_LENGTH,
    options: Object.values(WooCommercePublishStatus),
  },
];

export function normalizeWooCommerceStoreUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw wooCommerceError(ChannelErrorCode.RequestRejected, HTTPS_REQUIRED);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw wooCommerceError(ChannelErrorCode.RequestRejected, HTTPS_REQUIRED);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${normalizedPath}`;
}

export function wooCommerceExternalAccountId(storeUrl: string): string {
  const parsed = new URL(storeUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.host.toLowerCase()}${path}`;
}

export function wooCommerceInputFromValues(values: SellerCredentialValues): {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  wpUsername: string | null;
  wpAppPassword: string | null;
  defaultStatus: WooCommercePublishStatus;
} {
  const storeUrl = normalizeWooCommerceStoreUrl(values[WooCommerceCredentialField.StoreUrl] ?? '');
  const consumerKey = (values[WooCommerceCredentialField.ConsumerKey] ?? '').trim();
  const consumerSecret = (values[WooCommerceCredentialField.ConsumerSecret] ?? '').trim();
  const wpUsername = (values[WooCommerceCredentialField.WpUsername] ?? '').trim() || null;
  const wpAppPassword = (values[WooCommerceCredentialField.WpAppPassword] ?? '').trim() || null;

  if ((wpUsername && !wpAppPassword) || (!wpUsername && wpAppPassword)) {
    throw wooCommerceError(ChannelErrorCode.RequestRejected, WP_PAIR_REQUIRED);
  }

  const rawStatus = (values[WooCommerceCredentialField.DefaultStatus] ?? '').trim();
  const defaultStatus =
    rawStatus === WooCommercePublishStatus.Publish
      ? WooCommercePublishStatus.Publish
      : WooCommercePublishStatus.Draft;

  return { storeUrl, consumerKey, consumerSecret, wpUsername, wpAppPassword, defaultStatus };
}

export function serializeWooCommerceSecrets(secrets: WooCommerceSealedSecrets): string {
  return JSON.stringify(secrets);
}

export function parseWooCommerceSecrets(rawToken: string): WooCommerceSealedSecrets {
  try {
    return sealedSecretsSchema.parse(JSON.parse(rawToken));
  } catch {
    throw wooCommerceError(ChannelErrorCode.CredentialsRejected, NOT_SET_UP);
  }
}

export async function wooCommerceAccount(
  session: ChannelSession,
): Promise<{ account: WooCommerceAccount; settings: WooCommerceSettings }> {
  const settings = session.settings;
  if (!settings || !isWooCommerceSettings(settings)) {
    throw wooCommerceError(ChannelErrorCode.CredentialsRejected, NOT_SET_UP);
  }
  const secrets = parseWooCommerceSecrets(await session.accessToken());
  return {
    settings,
    account: {
      storeUrl: settings.storeUrl,
      consumerKey: secrets.consumerKey,
      consumerSecret: secrets.consumerSecret,
      wpUsername: secrets.wpUsername ?? settings.wpUsername ?? null,
      wpAppPassword: secrets.wpAppPassword ?? null,
      defaultStatus: settings.defaultStatus,
      weightUnit: settings.weightUnit,
      dimensionUnit: settings.dimensionUnit,
      currencyCode: settings.currencyCode,
    },
  };
}
