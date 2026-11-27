import { BadRequestException } from '@nestjs/common';

export interface ConfidentialLeakMatch {
  category: 'internal_margin' | 'internal_cost' | 'supplier_info' | 'credential';
  excerpt: string;
}

const LEAK_RULES: Array<{
  category: ConfidentialLeakMatch['category'];
  pattern: RegExp;
}> = [
  {
    category: 'internal_margin',
    pattern:
      /\b(?:margen(?:\s+comercial|\s+interno|\s+bruto|\s+neto)?|profit\s+margin|gross\s+margin|net\s+margin|markup|rentabilidad|utilidad\s+neta)\b[^.!?\n]{0,40}(?:\d+(?:[.,]\d+)?\s*%|\$\s*\d+|para\s+nosotros|for\s+us)/gi,
  },
  {
    category: 'internal_margin',
    pattern:
      /(?:\d+(?:[.,]\d+)?\s*%)\s*(?:de\s+)?(?:margen|ganancia\s+interna|utilidad|rentabilidad|profit\s+margin)/gi,
  },
  {
    category: 'internal_cost',
    pattern:
      /\b(?:costo\s+de\s+adquisici[oó]n|precio\s+de\s+costo|nuestro\s+costo|costo\s+interno|costo\s+unitario|acquisition\s+cost|cost\s+price|our\s+cost|wholesale\s+cost|landed\s+cost)\b/gi,
  },
  {
    category: 'supplier_info',
    pattern:
      /\b(?:proveedor\s+interno|precio\s+de\s+proveedor|factura\s+de\s+compra|internal\s+supplier|supplier\s+price)\b/gi,
  },
  {
    category: 'credential',
    pattern: /\b(?:Bearer\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9]{16,}|tp_[A-Za-z0-9_-]{12,})\b/g,
  },
];

/**
 * Deterministically inspects text destined for public channels (social drafts, ideas, captions,
 * buyer replies, marketplace listings) to prevent confidential internal data (margins, costs,
 * supplier info, credentials) from leaking — even if an LLM includes it accidentally.
 */
export function findConfidentialLeaks(text: string): ConfidentialLeakMatch[] {
  if (!text || !text.trim()) return [];
  const matches: ConfidentialLeakMatch[] = [];
  for (const rule of LEAK_RULES) {
    rule.pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = rule.pattern.exec(text)) !== null) {
      matches.push({
        category: rule.category,
        excerpt: hit[0].slice(0, 80),
      });
    }
  }
  return matches;
}

/**
 * Throws `BadRequestException` if public-facing text contains confidential internal data.
 */
export function assertPublicContentSafe(text: string, contextLabel = 'public content'): void {
  const leaks = findConfidentialLeaks(text);
  if (leaks.length > 0) {
    const categories = [...new Set(leaks.map((l) => l.category))].join(', ');
    throw new BadRequestException(
      `Confidential internal information (${categories}) cannot be included in ${contextLabel}. Remove internal margins, acquisition costs, supplier data, or credentials.`,
    );
  }
}

/**
 * Redacts confidential internal leak fragments from buyer-facing replies as a last-line defense
 * when throwing is not appropriate (e.g. live buyer chat).
 */
export function redactConfidentialLeaks(text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const rule of LEAK_RULES) {
    rule.pattern.lastIndex = 0;
    cleaned = cleaned.replace(rule.pattern, '[información interna reservada]');
  }
  return cleaned;
}
