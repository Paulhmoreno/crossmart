/**
 * Commercial verification tier for AI-generated product content.
 * Missing external sources never block drafting: products fall back cleanly to assisted
 * or provisional copy without inventing specifications.
 */
export enum ContentQualityTier {
  /** Backed by verified external sources or authorized public technical documentation. */
  VerifiedWithSources = 'verified_with_sources',
  /** Brand plus identifiable model/EAN or clear attributes from ERP, drafted conservatively. */
  CommercialAssisted = 'commercial_assisted',
  /** Generic or sparse ERP record drafted as clean provisional copy without inventing specs. */
  GenericProvisional = 'generic_provisional',
}

export const CONTENT_QUALITY_TIER_LABELS: Record<ContentQualityTier, string> = {
  [ContentQualityTier.VerifiedWithSources]: 'Nivel 1 — Verificado con fuentes',
  [ContentQualityTier.CommercialAssisted]: 'Nivel 2 — Comercial asistido',
  [ContentQualityTier.GenericProvisional]: 'Nivel 3 — Genérico provisional',
};
