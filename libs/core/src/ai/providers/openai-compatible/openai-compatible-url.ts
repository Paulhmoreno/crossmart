import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

const HTTPS_PROTOCOL = 'https:';
const HTTP_PROTOCOL = 'http:';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', '169.254.169.254']);
const COMPLETIONS_SUFFIX = /\/chat\/completions\/?$/i;
const IPV4_KIND = 4;
const IPV6_KIND = 6;
const IPV4_OCTET_COUNT = 4;
const IPV4_MAX_OCTET = 255;
const RFC1918_10 = 10;
const LOOPBACK_127 = 127;
const RFC1918_192 = 192;
const RFC1918_168 = 168;
const RFC1918_172 = 172;
const RFC1918_172_MIN = 16;
const RFC1918_172_MAX = 31;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== IPV4_OCTET_COUNT ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > IPV4_MAX_OCTET)
  ) {
    return false;
  }
  const [first, second] = parts;
  if (first === RFC1918_10 || first === LOOPBACK_127) return true;
  if (first === RFC1918_192 && second === RFC1918_168) return true;
  if (first === RFC1918_172 && second >= RFC1918_172_MIN && second <= RFC1918_172_MAX) return true;
  return false;
}

function isLinkLocalMetadata(host: string): boolean {
  if (METADATA_HOSTS.has(host)) return true;
  if (host.startsWith('169.254.')) return true;
  if (host.startsWith('fe80:') || host.startsWith('fd00:ec2::254')) return true;
  return false;
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTS.has(normalized) || normalized.endsWith('.local')) return true;
  if (isIP(normalized) === IPV4_KIND && isPrivateIpv4(normalized)) return true;
  if (
    isIP(normalized) === IPV6_KIND &&
    (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd'))
  ) {
    return !normalized.startsWith('fd00:ec2::254');
  }
  return false;
}

/**
 * Validates and normalizes an OpenAI-compatible API base URL.
 * - Requires HTTPS for public endpoints so API keys never cross public networks in plaintext.
 * - Allows HTTP for explicitly configured local or private endpoints (e.g. Ollama / LAN server).
 * - Blocks embedded credentials, non-HTTP schemes, and cloud metadata addresses.
 */
export function normalizeOpenAiBaseUrl(raw: string): { baseUrl: string; isPrivate: boolean } {
  const trimmed = raw.trim();
  if (!trimmed || !URL.canParse(trimmed)) {
    throw new BadRequestException(
      'Ingresa una URL base válida para el proveedor OpenAI Compatible (ej. https://api.openai.com/v1).',
    );
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== HTTPS_PROTOCOL && parsed.protocol !== HTTP_PROTOCOL) {
    throw new BadRequestException('La URL base del proveedor debe usar HTTP o HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException(
      'No incluyas credenciales dentro de la URL base; usa el campo API Key.',
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLinkLocalMetadata(host)) {
    throw new BadRequestException('La URL base apunta a una dirección de metadatos no permitida.');
  }
  const isPrivate = isLocalOrPrivateHost(host);
  if (parsed.protocol === HTTP_PROTOCOL && !isPrivate) {
    throw new BadRequestException(
      'Los proveedores externos deben usar HTTPS (https://...). HTTP solo está permitido para endpoints locales o privados.',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  const cleanedPath = parsed.pathname.replace(COMPLETIONS_SUFFIX, '').replace(/\/+$/, '');
  const baseUrl = `${parsed.origin}${cleanedPath}`;
  return { baseUrl, isPrivate };
}
