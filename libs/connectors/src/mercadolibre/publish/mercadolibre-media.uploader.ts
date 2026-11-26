import { Injectable, Optional } from '@nestjs/common';
import { FileStorage, isPublicAddress } from '@crossmart/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ExternalImage } from '../../sdk/capabilities/catalog.types.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { HttpTransport } from '../../sdk/http/http-transport.js';
import { parseJsonBody } from '../../sdk/http/parse-json.js';
import { ImageFetcher, ImageFetchError } from '../../sdk/images/image-fetcher.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import { mercadoLibreErrorCode, mercadoLibreErrorMessage } from '../api/mercadolibre-api-error.js';
import {
  MERCADOLIBRE_API_BASE_URL,
  MERCADOLIBRE_PICTURE_MAX_COUNT,
  MERCADOLIBRE_PICTURES_UPLOAD_PATH,
} from '../mercadolibre.constants.js';
import type { MercadoLibrePictureInput } from './mercadolibre-item.types.js';

const HTTPS_PROTOCOL = 'https:';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

const uploadedPictureSchema = z.object({
  id: z.string().min(1),
});

function isReachablePublicHttps(rawUrl: string): boolean {
  if (!URL.canParse(rawUrl)) return false;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== HTTPS_PROTOCOL) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (LOCAL_HOSTNAMES.has(host) || host.endsWith('.local')) return false;
  if (isIP(host) && !isPublicAddress(host)) return false;
  return true;
}

function normalizeMimeType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function buildMultipartBody(
  boundary: string,
  fileName: string,
  contentType: string,
  fileBytes: Buffer,
): Uint8Array<ArrayBuffer> {
  const safeName = fileName.replace(/["\r\n]/gu, '_');
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const combined = Buffer.concat([header, fileBytes, footer]);
  const arrayBuffer = new ArrayBuffer(combined.byteLength);
  const view = new Uint8Array(arrayBuffer);
  view.set(combined);
  return view;
}

function imageError(message: string): ChannelError {
  return new ChannelError(
    ChannelType.MercadoLibre,
    ChannelErrorCode.RequestRejected,
    message,
    PublishRequirement.Images,
  );
}

/**
 * Resolves product images for Mercado Libre:
 * 1. Local/private Crossmart files (e.g. Odoo-synced photos) are read from `FileStorage` and
 *    uploaded via authenticated `POST /pictures/items/upload` without exposing localhost publicly.
 * 2. Public HTTPS URLs are passed by `source` (or reused by persisted remote picture `id`).
 * 3. Rejects non-image MIME types so internal documents are never uploaded.
 */
@Injectable()
export class MercadoLibreMediaUploader {
  constructor(
    private readonly http: HttpTransport,
    private readonly fetcher: ImageFetcher,
    @Optional() private readonly storage?: FileStorage,
  ) {}

  async resolvePictures(
    accessToken: string,
    images: readonly ExternalImage[],
    maxPictures = MERCADOLIBRE_PICTURE_MAX_COUNT,
  ): Promise<MercadoLibrePictureInput[]> {
    const bounded = images.slice(0, maxPictures);
    const resolved: MercadoLibrePictureInput[] = [];
    for (const [index, image] of bounded.entries()) {
      resolved.push(await this.resolveOne(accessToken, image, index + 1));
    }
    return resolved;
  }

  private async resolveOne(
    accessToken: string,
    image: ExternalImage,
    position: number,
  ): Promise<MercadoLibrePictureInput> {
    if (isReachablePublicHttps(image.url)) {
      return { source: image.url };
    }
    const file = await this.loadLocalBytes(image.url, position);
    const mime = normalizeMimeType(file.contentType);
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
      throw imageError(
        `Photo #${position} has unsupported type (${mime || 'unknown'}). Use JPG, PNG, or WebP.`,
      );
    }
    const pictureId = await this.uploadPicture(accessToken, file, mime, position);
    return { id: pictureId };
  }

  private async loadLocalBytes(
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
      throw imageError(`Could not read product photo #${position} for Mercado Libre (${reason}).`);
    }
  }

  private async uploadPicture(
    accessToken: string,
    file: { bytes: Buffer; fileName: string },
    mime: string,
    position: number,
  ): Promise<string> {
    const boundary = `----CrossmartML${randomUUID().replace(/-/gu, '')}`;
    const bytes = buildMultipartBody(boundary, file.fileName, mime, file.bytes);
    const response = await this.http.send({
      method: HttpMethod.Post,
      url: new URL(MERCADOLIBRE_PICTURES_UPLOAD_PATH, MERCADOLIBRE_API_BASE_URL).toString(),
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        accept: 'application/json',
      },
      bytes,
    });
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      const code = mercadoLibreErrorCode(response.status);
      const detail = mercadoLibreErrorMessage(response) ?? `HTTP ${response.status}`;
      throw new ChannelError(
        ChannelType.MercadoLibre,
        code,
        `Mercado Libre rejected photo #${position}: ${detail}`,
        code === ChannelErrorCode.RequestRejected ? PublishRequirement.Images : undefined,
      );
    }
    const parsed = uploadedPictureSchema.safeParse(parseJsonBody(response.body));
    if (!parsed.success) {
      throw imageError(`Mercado Libre returned no picture id for photo #${position}.`);
    }
    return parsed.data.id;
  }
}
