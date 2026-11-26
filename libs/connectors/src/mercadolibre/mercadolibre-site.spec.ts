import {
  MERCADOLIBRE_SITES,
  MercadoLibreSiteId,
  normalizeMercadoLibreSiteId,
} from './mercadolibre-site.js';

describe('Mercado Libre sites', () => {
  it('normalizes a site id the merchant picked, in any case', () => {
    expect(normalizeMercadoLibreSiteId(' mec ')).toBe(MercadoLibreSiteId.Ecuador);
    expect(normalizeMercadoLibreSiteId(' mlm ')).toBe(MercadoLibreSiteId.Mexico);
    expect(normalizeMercadoLibreSiteId('MLB')).toBe(MercadoLibreSiteId.Brazil);
    expect(normalizeMercadoLibreSiteId('MLX')).toBeNull();
    expect(normalizeMercadoLibreSiteId('EBAY_US')).toBeNull();
  });

  it('configures Ecuador (MEC) in USD with 2 decimals and auth.mercadolibre.com.ec', () => {
    expect(MERCADOLIBRE_SITES[MercadoLibreSiteId.Ecuador]).toEqual({
      currencyCode: 'USD',
      currencyDecimals: 2,
      siteLabel: 'Mercado Libre Ecuador',
      authOrigin: 'https://auth.mercadolibre.com.ec',
    });
  });

  it('prices Chile and Colombia in whole pesos, as /currencies says', () => {
    expect(MERCADOLIBRE_SITES[MercadoLibreSiteId.Chile]).toMatchObject({
      currencyCode: 'CLP',
      currencyDecimals: 0,
    });
    expect(MERCADOLIBRE_SITES[MercadoLibreSiteId.Colombia].currencyDecimals).toBe(0);
    expect(MERCADOLIBRE_SITES[MercadoLibreSiteId.Mexico].currencyDecimals).toBe(2);
  });

  it('signs sellers in on an https host of their own country', () => {
    for (const site of Object.values(MERCADOLIBRE_SITES)) {
      expect(new URL(site.authOrigin).protocol).toBe('https:');
    }
  });
});
