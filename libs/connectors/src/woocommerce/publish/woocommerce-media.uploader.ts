import { Injectable, Optional } from '@nestjs/common';
import { FileStorage, isPublicAddress } from '@crossmart/common';
import { isIP } from 'node:net';
import type { ExternalImage } from '../../sdk/capabilities/catalog.types.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { ImageFetcher, ImageFetchError } from '../../sdk/images/image-fetcher.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import type { WooCommerceAccount } from '../account/woocommerce-credentials.js';
import { WooCommerceApiClient } from '../api/woocommerce-api.client.js';
import type { WooMetaEntry } from '../api/woocommerce-api.types.js';
import { WOOCOMMERCE_MAX_IMAGES, WOOCOMMERCE_META_MEDIA_MAP } from '../woocommerce.constants.js';

const HTTPS_PROTOCOL = 'https:';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const MISSING_WP_MEDIA_AUTH =
  'Las fotografías alojadas localmente en Crossmart no son accesibles desde una tienda WooCommerce remota. Configura el usuario y contraseña de aplicación de WordPress (con permiso upload_files) en la conexión de WooCommerce para transferirlas.';

export type WooMediaPayloadItem = { id: number; alt?: string } | { src: string; alt?: string };

export interface ResolvedWooMedia {
  images: WooMediaPayloadItem[];
  mediaMap: Record<string, number>;
}

function isReachablePublicHttps(rawUrl: string): boolean {
  if (!URL.canParse(rawUrl)) return false;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== HTTPS_PROTOCOL) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTNAMES.has(host) || host.endsWith('.local')) return false;
  if (isIP(host) && !isPublicAddress(host)) return false;
  return true;
}

export function readRemoteMediaMap(metaData?: readonly WooMetaEntry[]): Record<string, number> {
  const entry = metaData?.find((item) => item.key === WOOCOMMERCE_META_MEDIA_MAP);
  if (!entry || typeof entry.value !== 'string') return {};
  try {
    const parsed = JSON.parse(entry.value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Transfers Crossmart product images to WooCommerce without creating a separate media manager
 * or exposing localhost publicly:
 * 1. Reuses already-uploaded WordPress media IDs persisted in `_crossmart_media_map`.
 * 2. When WordPress Media credentials are configured, reads local Crossmart files directly from
 *    `FileStorage` (or external HTTPS images via `ImageFetcher`) and uploads binary bytes to
 *    `/wp-json/wp/v2/media`.
 * 3. For already-public HTTPS URLs without WordPress credentials, passes `{ src }` for WooCommerce
 *    sideloading.
 * 4. Explicitly fails with `PublishRequirement.Images` if a local/unreachable image cannot be
 *    transferred.
 */
@Injectable()
export class WooCommerceMediaUploader {
  constructor(
    private readonly api: WooCommerceApiClient,
    private readonly fetcher: ImageFetcher,
    @Optional() private readonly storage?: FileStorage,
  ) {}

  async resolveImages(
    account: WooCommerceAccount,
    images: readonly ExternalImage[],
    productTitle: string,
    existingMediaMap: Readonly<Record<string, number>> = {},
  ): Promise<ResolvedWooMedia> {
    const bounded = images.slice(0, WOOCOMMERCE_MAX_IMAGES);
    const nextMap: Record<string, number> = { ...existingMediaMap };
    const payloadImages: WooMediaPayloadItem[] = [];

    for (const [index, image] of bounded.entries()) {
      const alt = image.altText?.trim() || productTitle;
      const cachedId = nextMap[image.url];
      if (cachedId) {
        payloadImages.push({ id: cachedId, alt });
        continue;
      }

      if (account.wpUsername && account.wpAppPassword) {
        const file = await this.loadImageBytes(image.url, index + 1);
        const uploaded = await this.api.uploadWordPressMedia(
          {
            storeUrl: account.storeUrl,
            username: account.wpUsername,
            appPassword: account.wpAppPassword,
          },
          { ...file, altText: alt },
        );
        nextMap[image.url] = uploaded.id;
        payloadImages.push({ id: uploaded.id, alt });
        continue;
      }

      if (isReachablePublicHttps(image.url)) {
        payloadImages.push({ src: image.url, alt });
        continue;
      }

      throw new ChannelError(
        ChannelType.WooCommerce,
        ChannelErrorCode.RequestRejected,
        MISSING_WP_MEDIA_AUTH,
        PublishRequirement.Images,
      );
    }

    return { images: payloadImages, mediaMap: nextMap };
  }

  private async loadImageBytes(
    url: string,
    position: number,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    if (this.storage?.readByUrl) {
      const local = await this.storage.readByUrl(url);
      if (local) return local;
    }
    try {
      return await this.fetcher.fetch(url);
    } catch (error) {
      const reason = error instanceof ImageFetchError ? error.failure : 'unreachable';
      throw new ChannelError(
        ChannelType.WooCommerce,
        ChannelErrorCode.RequestRejected,
        `No se pudo leer la fotografía #${position} del producto para subirla a WooCommerce (${reason}).`,
        PublishRequirement.Images,
      );
    }
  }
}
