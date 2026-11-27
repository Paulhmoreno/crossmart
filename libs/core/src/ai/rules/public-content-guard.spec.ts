import { describe, expect, it } from 'vitest';
import {
  assertPublicContentSafe,
  findConfidentialLeaks,
  redactConfidentialLeaks,
} from './public-content-guard.js';

describe('public-content-guard (P0 adversarial confidentiality tests)', () => {
  it('blocks internal profit margin leaks in Spanish and English', () => {
    const leakyFacebookPost =
      '¡Aprovecha este parlante increíble! Tiene margen 32.9 % para nosotros y gran sonido.';
    expect(findConfidentialLeaks(leakyFacebookPost).length).toBeGreaterThan(0);
    expect(() => assertPublicContentSafe(leakyFacebookPost, 'Facebook draft')).toThrow(
      /internal_margin/,
    );

    expect(() =>
      assertPublicContentSafe('Promote this SKU (35% profit margin) on Instagram.'),
    ).toThrow(/internal_margin/);
  });

  it('blocks acquisition costs, supplier prices, and credentials', () => {
    expect(() =>
      assertPublicContentSafe('Nuestro costo es $45 y lo vendemos en $99.'),
    ).toThrow(/internal_cost/);
    expect(() =>
      assertPublicContentSafe('Precio de proveedor exclusivo para este lote.'),
    ).toThrow(/supplier_info/);
    expect(() =>
      assertPublicContentSafe('Usa Bearer tp_live_secret_token_1234567890 para conectar.'),
    ).toThrow(/credential/);
  });

  it('allows legitimate public commercial copy (prices, discounts, warranties, stock)', () => {
    const safeCopy =
      'Descubre el tocadiscos Audio-Technica AT-LP60X por $199.00. 15% de descuento por tiempo limitado, garantía de 1 año y entrega en Quito y todo Ecuador.';
    expect(findConfidentialLeaks(safeCopy)).toEqual([]);
    expect(() => assertPublicContentSafe(safeCopy, 'Facebook draft')).not.toThrow();
  });

  it('redacts accidental leaks in buyer-facing replies', () => {
    const raw = 'El precio es $120 (margen 32.9 % para nosotros).';
    const redacted = redactConfidentialLeaks(raw);
    expect(redacted).not.toContain('32.9');
    expect(redacted).toContain('$120');
  });
});
