import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Actor } from '../activity/entities/actor.js';
import { normalizeTryPostBaseUrl } from './trypost.client.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';

describe('Agente Social — Universalidad, Aislamiento, Aprobaciones y Presupuesto', () => {
  it('genera oportunidades distintas para dos negocios de sectores completamente diferentes sin hardcoding', async () => {
    const prismaCoffee = {
      product: {
        count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(1),
        groupBy: vi.fn().mockResolvedValue([{ productType: 'Café de Especialidad', _count: { _all: 1 } }]),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p-coffee-1',
            title: 'Café de Especialidad Bourbon Lavado 500g',
            productType: 'Café de Especialidad',
            media: [{ url: 'https://cdn.example.com/coffee.jpg' }],
            variants: [{ sku: 'CAF-01', price: '18.00', cost: '9.00', inventoryItem: { available: 12 } }],
          },
          {
            id: 'p-coffee-out',
            title: 'Geisha Edición Agotada',
            productType: 'Café de Especialidad',
            media: [],
            variants: [{ sku: 'CAF-OUT', price: '45.00', cost: '20.00', inventoryItem: { available: 0 } }],
          },
        ]),
      },
    } as never;

    const prismaVet = {
      product: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1),
        groupBy: vi.fn().mockResolvedValue([{ productType: 'Nutrición Veterinaria', _count: { _all: 1 } }]),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p-vet-1',
            title: 'Alimento Hipoalergénico Perros Adultos 10kg',
            productType: 'Nutrición Veterinaria',
            media: [],
            variants: [{ sku: 'VET-01', price: '62.00', cost: '36.00', inventoryItem: { available: 8 } }],
          },
        ]),
      },
    } as never;

    const coffeeSvc = new SocialIntelligenceService(prismaCoffee, {} as never, {} as never);
    const vetSvc = new SocialIntelligenceService(prismaVet, {} as never, {} as never);

    const coffeeOps = await coffeeSvc.analyzeBusinessOpportunities('ws-coffee');
    const vetOps = await vetSvc.analyzeBusinessOpportunities('ws-vet');

    // Out-of-stock product excluded automatically
    expect(coffeeOps.inStockProducts).toBe(1);
    expect(coffeeOps.opportunities.some((o) => o.title.includes('Geisha'))).toBe(false);
    expect(coffeeOps.opportunities.some((o) => o.title.includes('Bourbon'))).toBe(true);
    expect(coffeeOps.opportunities.some((o) => o.suggestedPillar === 'educational')).toBe(true);

    // Second business gets completely different sector-specific opportunities
    expect(vetOps.topCategories).toEqual(['Nutrición Veterinaria']);
    expect(vetOps.opportunities.some((o) => o.title.includes('Hipoalergénico'))).toBe(true);
    expect(vetOps.opportunities.some((o) => o.title.includes('Bourbon'))).toBe(false);

    // Architectural data separation: public opportunities NEVER contain internal cost or margin fields
    for (const op of [...coffeeOps.opportunities, ...vetOps.opportunities]) {
      expect('cost' in op).toBe(false);
      expect('verifiableMarginPct' in op).toBe(false);
    }
  });

  it('considers single-unit products with lightweight creative effort and gates periodic worker by autonomy', async () => {
    const prismaSingle = {
      product: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        groupBy: vi.fn().mockResolvedValue([{ productType: 'Coleccionables', _count: { _all: 1 } }]),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'p-unique',
            title: 'Edición Limitada Vinilo',
            productType: 'Coleccionables',
            media: [{ url: 'https://cdn.example.com/vinyl.jpg' }],
            variants: [{ sku: 'VIN-1', price: '120.00', inventoryItem: { available: 1 } }],
          },
        ]),
      },
      socialBudgetPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'ws-u',
          autonomyMode: 'SUPERVISED',
          paused: false,
        }),
      },
    } as never;

    const svc = new SocialIntelligenceService(prismaSingle, {} as never, {} as never);
    const analysis = await svc.analyzeBusinessOpportunities('ws-u');
    const featured = analysis.opportunities.find((o) => o.productId === 'p-unique');
    expect(featured).toBeDefined();
    expect(featured?.availabilityTier).toBe('single_unit');
    expect(featured?.creativeEffort).toBe('lightweight_quick');

    // Periodic worker skips SUPERVISED workspaces until owner explicitly authorizes AUTOMATIC
    const cycle = await svc.runEditorialPlanningCycle('ws-u', { trigger: 'worker', dryRun: true });
    expect(cycle.skippedReason).toBe('autonomy_mode_supervised');
  });

  it('invalida aprobaciones al editar contenido y bloquea programación en TryPost sin aprobación vigente', async () => {
    const state = {
      id: 'item-1',
      workspaceId: 'ws-1',
      title: 'Guía de temporada',
      caption: 'Texto original',
      status: 'APPROVED',
      contentVersion: 1,
      approvedVersion: 1,
      targetChannelIds: ['ch-1'],
    };

    const prisma = {
      socialContentItem: {
        findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string; workspaceId: string } }) =>
          where.workspaceId === state.workspaceId && where.id === state.id ? { ...state } : null,
        ),
        update: vi.fn().mockImplementation(async ({ data }: { data: Partial<typeof state> }) => {
          Object.assign(state, data);
          return { ...state };
        }),
      },
      socialBudgetPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'ws-1',
          paused: false,
          autonomyMode: 'SUPERVISED',
        }),
      },
      socialAgentEvent: { create: vi.fn().mockResolvedValue({}) },
    } as never;

    const svc = new SocialIntelligenceService(prisma, { openAuth: vi.fn() } as never, {} as never);

    // Cross-workspace isolation check
    await expect(svc.approveContentItem('ws-OTHER', 'item-1', Actor.system())).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // Editing approved content increments version and invalidates approval
    const edited = await svc.updateContentItem('ws-1', 'item-1', { caption: 'Texto modificado sin aprobar' });
    expect(edited.contentVersion).toBe(2);
    expect(edited.status).toBe('PENDING_APPROVAL');

    // Scheduling in TryPost is strictly blocked until v2 is approved!
    await expect(
      svc.pushToTryPost('ws-1', 'item-1', {
        mode: 'scheduled',
        channelIds: ['ch-1'],
        scheduledAt: '2026-12-01T15:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('aplica límites deterministas de presupuesto creativo y pausa', async () => {
    const prisma = {
      socialBudgetPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          workspaceId: 'ws-1',
          paused: false,
          monthlyLimitUsd: 10,
          perTaskLimitUsd: 2,
          spentThisMonthUsd: 9,
        }),
      },
    } as never;

    const svc = new SocialIntelligenceService(prisma, {} as never, {} as never);
    // Exceeds per-task limit ($2)
    await expect(svc.assertBudgetAvailable('ws-1', 2.5)).rejects.toBeInstanceOf(ForbiddenException);
    // Exceeds remaining monthly budget ($1 left)
    await expect(svc.assertBudgetAvailable('ws-1', 1.5)).rejects.toBeInstanceOf(ForbiddenException);
    // Within limits ($0.50) passes
    await expect(svc.assertBudgetAvailable('ws-1', 0.5)).resolves.toBeUndefined();
  });

  it('genera composición SVG válida y valida URLs de TryPost con protección SSRF', () => {
    const svc = new SocialIntelligenceService({} as never, {} as never, {} as never);
    const comp = svc.generateSvgComposition({
      headline: 'Calidad & Diseño <2026>',
      subheadline: 'Envío disponible',
      priceLabel: '$49.90',
      ctaLabel: 'Ver catálogo',
      aspectRatio: '4:5',
    });
    expect(comp.width).toBe(1080);
    expect(comp.height).toBe(1350);
    expect(comp.svg).toContain('Calidad &amp; Diseño &lt;2026&gt;');

    expect(normalizeTryPostBaseUrl()).toEqual({
      baseUrl: 'https://app.trypost.it/api',
      isSelfHosted: false,
    });
    expect(normalizeTryPostBaseUrl('https://social.mycompany.com')).toEqual({
      baseUrl: 'https://social.mycompany.com/api',
      isSelfHosted: true,
    });
    expect(() => normalizeTryPostBaseUrl('http://169.254.169.254/latest')).toThrow();
  });
});
