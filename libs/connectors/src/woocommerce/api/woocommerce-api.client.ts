import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ChannelErrorCode } from '../../sdk/errors/channel-error-code.enum.js';
import { HttpMethod } from '../../sdk/http/http-method.enum.js';
import { type HttpResponse, HttpTransport } from '../../sdk/http/http-transport.js';
import { PublishRequirement } from '../../sdk/publishing/publish-requirement.enum.js';
import { ChannelError } from '../../sdk/errors/channel-error.js';
import { ChannelType } from '../../sdk/channel-type.enum.js';
import {
  WOOCOMMERCE_REST_BASE,
  WORDPRESS_API_INDEX,
  WORDPRESS_REST_BASE,
} from '../woocommerce.constants.js';
import { wooCommerceError } from '../woocommerce-errors.js';
import type { WordPressCurrentUser, WordPressMediaResponse } from './woocommerce-api.types.js';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_RATE_LIMITED = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const MAX_ERROR_DETAIL_LENGTH = 500;

export interface WooAuthConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WordPressAuthConfig {
  storeUrl: string;
  username: string;
  appPassword: string;
}

export interface WooApiResult<Data> {
  data: Data;
  headers: Readonly<Record<string, string>>;
}

function basicAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractWooErrorDetail(response: HttpResponse): { code: string; message: string } {
  const parsed = parseJsonBody(response.body);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as { code?: unknown; message?: unknown };
    const code = typeof obj.code === 'string' ? obj.code : '';
    const message = typeof obj.message === 'string' ? obj.message : '';
    if (message || code) {
      const combined = [code, message].filter(Boolean).join(': ');
      return { code, message: combined.slice(0, MAX_ERROR_DETAIL_LENGTH) };
    }
  }
  return { code: '', message: `WooCommerce HTTP ${response.status}` };
}

export class WooCommerceApiError extends ChannelError {
  constructor(
    code: ChannelErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly wooCode: string,
    requirement?: PublishRequirement,
  ) {
    super(ChannelType.WooCommerce, code, message, requirement);
  }
}

function toChannelError(response: HttpResponse): ChannelError {
  const detail = extractWooErrorDetail(response);
  if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) {
    return new WooCommerceApiError(
      ChannelErrorCode.CredentialsRejected,
      `WooCommerce rechazó las credenciales o permisos (${detail.message})`,
      response.status,
      detail.code,
    );
  }
  if (response.status === HTTP_RATE_LIMITED) {
    return new WooCommerceApiError(
      ChannelErrorCode.RateLimited,
      `WooCommerce limitó temporalmente las solicitudes (${detail.message})`,
      response.status,
      detail.code,
    );
  }
  if (response.status >= HTTP_SERVER_ERROR_MIN) {
    return new WooCommerceApiError(
      ChannelErrorCode.ChannelUnavailable,
      `La tienda WooCommerce no está disponible temporalmente (${detail.message})`,
      response.status,
      detail.code,
    );
  }
  const requirement =
    detail.code === 'woocommerce_product_image_upload_error'
      ? PublishRequirement.Images
      : undefined;
  return new WooCommerceApiError(
    ChannelErrorCode.RequestRejected,
    detail.message,
    response.status,
    detail.code,
    requirement,
  );
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'product-image.jpg';
}

/**
 * HTTP client for WooCommerce REST API v3 and WordPress REST Media API.
 * Always sends credentials via HTTP Basic Auth over HTTPS (never in URL query strings)
 * and busts storefront caches on authenticated GET requests.
 */
@Injectable()
export class WooCommerceApiClient {
  constructor(private readonly http: HttpTransport) {}

  async request<Data>(
    auth: WooAuthConfig,
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<WooApiResult<Data>> {
    const base = `${auth.storeUrl.replace(/\/+$/, '')}${WOOCOMMERCE_REST_BASE}`;
    const fullPath =
      method === HttpMethod.Get
        ? `${path}${path.includes('?') ? '&' : '?'}_cm_ts=${randomUUID()}`
        : path;
    const response = await this.sendSafe({
      method,
      url: `${base}${fullPath}`,
      headers: {
        authorization: basicAuthHeader(auth.consumerKey, auth.consumerSecret),
        accept: 'application/json',
        'cache-control': 'no-cache',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      throw toChannelError(response);
    }
    const parsed = parseJsonBody(response.body);
    if (parsed === null && response.body.trim().length > 0) {
      throw wooCommerceError(
        ChannelErrorCode.ChannelUnavailable,
        'La tienda WooCommerce devolvió una respuesta no JSON.',
      );
    }
    return { data: parsed as Data, headers: response.headers };
  }

  /** Reads the public WordPress API index (`/wp-json/`) to discover the site display name. */
  async readSiteName(storeUrl: string): Promise<string | null> {
    try {
      const response = await this.sendSafe({
        method: HttpMethod.Get,
        url: `${storeUrl.replace(/\/+$/, '')}${WORDPRESS_API_INDEX}`,
        headers: { accept: 'application/json' },
      });
      if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) return null;
      const parsed = parseJsonBody(response.body) as { name?: unknown } | null;
      return typeof parsed?.name === 'string' && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : null;
    } catch {
      return null;
    }
  }

  /** Verifies WordPress Application Password credentials and checks `upload_files` capability. */
  async verifyWordPressMediaAuth(auth: WordPressAuthConfig): Promise<WordPressCurrentUser> {
    const url = `${auth.storeUrl.replace(/\/+$/, '')}${WORDPRESS_REST_BASE}/users/me?context=edit`;
    const response = await this.sendSafe({
      method: HttpMethod.Get,
      url,
      headers: {
        authorization: basicAuthHeader(auth.username, auth.appPassword),
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
    });
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      const detail = extractWooErrorDetail(response);
      throw wooCommerceError(
        ChannelErrorCode.CredentialsRejected,
        `WordPress rechazó el usuario o contraseña de aplicación para subir imágenes (${detail.message})`,
      );
    }
    const user = parseJsonBody(response.body) as WordPressCurrentUser | null;
    if (!user || typeof user.id !== 'number') {
      throw wooCommerceError(
        ChannelErrorCode.CredentialsRejected,
        'WordPress no devolvió un usuario válido al verificar los permisos multimedia.',
      );
    }
    if (user.capabilities && user.capabilities.upload_files === false) {
      throw wooCommerceError(
        ChannelErrorCode.CredentialsRejected,
        'El usuario de WordPress no tiene el permiso upload_files necesario para subir fotografías.',
      );
    }
    return user;
  }

  /** Uploads binary image bytes directly to the WordPress REST Media Library (`/wp-json/wp/v2/media`). */
  async uploadWordPressMedia(
    auth: WordPressAuthConfig,
    file: { bytes: Buffer; contentType: string; fileName: string; altText?: string | null },
  ): Promise<WordPressMediaResponse> {
    const safeName = sanitizeFileName(file.fileName);
    const bytes = new Uint8Array(new ArrayBuffer(file.bytes.byteLength));
    bytes.set(file.bytes);

    const url = `${auth.storeUrl.replace(/\/+$/, '')}${WORDPRESS_REST_BASE}/media`;
    const response = await this.sendSafe({
      method: HttpMethod.Post,
      url,
      headers: {
        authorization: basicAuthHeader(auth.username, auth.appPassword),
        accept: 'application/json',
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${safeName}"`,
      },
      bytes,
    });
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      const detail = extractWooErrorDetail(response);
      const code =
        response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN
          ? ChannelErrorCode.CredentialsRejected
          : ChannelErrorCode.RequestRejected;
      throw new ChannelError(
        ChannelType.WooCommerce,
        code,
        `No se pudo subir la imagen "${safeName}" a la biblioteca multimedia de WordPress (${detail.message})`,
        PublishRequirement.Images,
      );
    }
    const uploaded = parseJsonBody(response.body) as WordPressMediaResponse | null;
    if (!uploaded || typeof uploaded.id !== 'number' || uploaded.id <= 0) {
      throw new ChannelError(
        ChannelType.WooCommerce,
        ChannelErrorCode.RequestRejected,
        `WordPress no devolvió un ID multimedia válido al subir "${safeName}".`,
        PublishRequirement.Images,
      );
    }

    if (file.altText?.trim()) {
      await this.updateWordPressMediaAlt(auth, uploaded.id, file.altText.trim());
    }
    return uploaded;
  }

  private async updateWordPressMediaAlt(
    auth: WordPressAuthConfig,
    mediaId: number,
    altText: string,
  ): Promise<void> {
    try {
      await this.sendSafe({
        method: HttpMethod.Post,
        url: `${auth.storeUrl.replace(/\/+$/, '')}${WORDPRESS_REST_BASE}/media/${mediaId}`,
        headers: {
          authorization: basicAuthHeader(auth.username, auth.appPassword),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ alt_text: altText }),
      });
    } catch {
      // Setting alt text is best-effort once the media item is uploaded.
    }
  }

  private async sendSafe(request: Parameters<HttpTransport['send']>[0]): Promise<HttpResponse> {
    try {
      return await this.http.send(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Error de red';
      throw wooCommerceError(
        ChannelErrorCode.ChannelUnavailable,
        `No se pudo conectar con la tienda WooCommerce (${reason})`,
      );
    }
  }
}
