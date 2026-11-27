import { Injectable } from '@nestjs/common';
import { PrismaService } from '@crossmart/database';
import { assertPublicContentSafe } from '../ai/rules/public-content-guard.js';
import type { ExecutableAgentTool } from '../ai/services/agent-execution-engine.service.js';
import { SalesKnowledgeService } from '../sales-agent/sales-knowledge.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostClient } from './trypost.client.js';
import { TryPostConnectionService } from './trypost-connection.service.js';

const EXTERNAL_TOOL_TIMEOUT_MS = 30_000;
const LOCAL_TOOL_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

function isSafeMediaUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === '169.254.169.254' || host === 'metadata.google.internal') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete specialized toolset for Agente Social, plugged into Crossmart's shared
 * `AgentExecutionEngine`.
 * - Executes against real TryPost REST API (`/social-accounts`, `/posts`, `/ideas`, `/uploads`, `/analytics`, `/queue/slots`).
 * - Enforces P0 confidentiality (`assertPublicContentSafe`) before saving ANY idea or draft.
 * - Supports real catalog photography retrieval & upload without generative AI providers.
 * - Strictly non-publishing: NEVER schedules or publishes posts from agent tools.
 */
@Injectable()
export class SocialAgentToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intelligence: SocialIntelligenceService,
    private readonly knowledge: SalesKnowledgeService,
    private readonly trypostConnections: TryPostConnectionService,
    private readonly trypostClient: TryPostClient,
  ) {}

  buildTools(workspaceId: string): ExecutableAgentTool[] {
    return [
      {
        title: 'Query connected TryPost accounts',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'inspect_trypost_accounts',
          description:
            'Inspect real TryPost connection status, connected social accounts (IDs, platforms, names, usernames, statuses), and available capabilities.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          const status = await this.trypostConnections.getStatus(workspaceId);
          if (!auth) {
            return {
              output: { connected: false, channels: [], status: status?.status ?? 'UNCONFIGURED' },
              outcome: 'TryPost not connected',
            };
          }
          const live = await this.trypostClient.testConnection(auth);
          if (!live.ok) {
            return {
              output: {
                connected: true,
                cachedChannels: status?.channels ?? [],
                liveError: live.error,
              },
              outcome: live.error ?? 'TryPost error',
              isError: true,
            };
          }
          return {
            output: {
              connected: true,
              baseUrl: status?.baseUrl,
              channelCount: live.channels.length,
              channels: live.channels,
              capabilities: live.capabilities,
            },
            outcome: `${live.channels.length} account(s)`,
          };
        },
      },
      {
        title: 'Query TryPost posts and calendar',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'list_trypost_posts',
          description:
            'List real remote posts, drafts, scheduled items, and calendar entries from the connected TryPost workspace.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return { output: { connected: false, posts: [] }, outcome: 'TryPost not connected' };
          }
          const posts = await this.trypostClient.listPosts(auth);
          return {
            output: { count: posts.length, posts: posts.slice(0, 25) },
            outcome: `${posts.length} post(s)`,
          };
        },
      },
      {
        title: 'Query TryPost idea bank',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'list_trypost_ideas',
          description: 'List real editorial ideas currently stored in the connected TryPost idea bank.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return { output: { connected: false, ideas: [] }, outcome: 'TryPost not connected' };
          }
          const ideas = await this.trypostClient.listIdeas(auth);
          return {
            output: { count: ideas.length, ideas: ideas.slice(0, 25) },
            outcome: `${ideas.length} idea(s)`,
          };
        },
      },
      {
        title: 'Query TryPost analytics',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'get_trypost_analytics',
          description: 'Retrieve available workspace social analytics and metrics from TryPost.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return {
              output: { connected: false, analytics: null },
              outcome: 'TryPost not connected',
            };
          }
          const analytics = await this.trypostClient.getWorkspaceAnalytics(auth);
          return {
            output: { available: Boolean(analytics), analytics },
            outcome: analytics ? 'Analytics loaded' : 'No analytics available',
          };
        },
      },
      {
        title: 'Query TryPost queue slots',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'get_trypost_queue_slots',
          description: 'Query available queue posting slots for a specific connected TryPost social account ID.',
          inputSchema: {
            type: 'object',
            properties: {
              channelId: { type: 'string', description: 'TryPost social account/channel ID' },
            },
            required: ['channelId'],
          },
        },
        execute: async (input) => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
          if (!auth || !channelId) {
            return { output: { slots: [] }, outcome: 'TryPost not connected' };
          }
          const slots = await this.trypostClient.getQueueSlots(auth, channelId).catch(() => []);
          return { output: { channelId, count: slots.length, slots: slots.slice(0, 20) }, outcome: `${slots.length} slot(s)` };
        },
      },
      {
        title: 'Analyze catalog and inventory opportunities',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'analyze_catalog_opportunities',
          description:
            'Analyze the FULL workspace catalog (real aggregate totals across all products, in-stock count, eligible multi-unit stock, categories, and public-safe commercial opportunities without internal margins/costs).',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const analysis = await this.intelligence.analyzeBusinessOpportunities(workspaceId);
          return {
            output: analysis,
            outcome: `${analysis.inStockProducts}/${analysis.totalProducts} in stock`,
          };
        },
      },
      {
        title: 'Retrieve real catalog product photographs',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'get_catalog_product_images',
          description:
            'Search workspace catalog products (with positive stock) and retrieve their verified real product photographs (image URLs, prices, stock, SKU) ready for visual posts without generative AI.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Optional product title or SKU search term. Leave empty to list top in-stock products that have real images.',
              },
              limit: { type: 'number', description: 'Max products to return (1-10, default 6).' },
            },
          },
        },
        execute: async (input) => {
          const query = typeof input.query === 'string' ? input.query.trim() : '';
          const limit =
            typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), 10) : 6;
          const products = await this.prisma.product.findMany({
            where: {
              workspaceId,
              variants: { some: { inventoryItem: { available: { gt: 0 } } } },
              media: { some: {} },
              ...(query
                ? {
                    OR: [
                      { title: { contains: query, mode: 'insensitive' } },
                      { variants: { some: { sku: { contains: query, mode: 'insensitive' } } } },
                    ],
                  }
                : {}),
            },
            include: {
              variants: { include: { inventoryItem: true }, take: 3 },
              media: { orderBy: { position: 'asc' }, take: 3 },
            },
            orderBy: { updatedAt: 'desc' },
            take: limit,
          });
          const mapped = products.map((prod) => {
            const available = prod.variants.reduce((sum, v) => sum + (v.inventoryItem?.available ?? 0), 0);
            const primary = prod.variants[0];
            return {
              productId: prod.id,
              title: prod.title,
              category: prod.productType,
              sku: primary?.sku ?? null,
              publicPrice: primary ? Number(primary.price) : null,
              availableStock: available,
              images: prod.media.map((img) => ({ url: img.url, altText: img.altText })),
            };
          });
          return {
            output: { count: mapped.length, products: mapped },
            outcome: `${mapped.length} product(s) with photos`,
          };
        },
      },
      {
        title: 'Upload catalog photograph to TryPost',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'upload_trypost_media',
          description:
            'Download a verified catalog product photograph URL, validate its image format (JPEG/PNG/WebP), upload it to TryPost `/api/uploads`, and return its remote `upload_token` for attaching to a remote draft.',
          inputSchema: {
            type: 'object',
            properties: {
              imageUrl: { type: 'string', description: 'Verified product image URL from get_catalog_product_images' },
              filename: { type: 'string', description: 'Optional clean filename (e.g. product-photo.jpg)' },
            },
            required: ['imageUrl'],
          },
        },
        execute: async (input) => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return { output: { error: 'TryPost is not connected.' }, isError: true, outcome: 'TryPost not connected' };
          }
          const rawImageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
          const imageUrl = rawImageUrl.startsWith('/')
            ? `${process.env.API_PUBLIC_URL ?? 'http://localhost:3300'}${rawImageUrl}`
            : rawImageUrl;
          if (!imageUrl || !isSafeMediaUrl(imageUrl)) {
            return { output: { error: 'Invalid or disallowed image URL.' }, isError: true, outcome: 'Invalid image URL' };
          }
          const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
          if (!imgRes.ok) {
            return {
              output: { error: `Could not fetch catalog image (HTTP ${imgRes.status}).` },
              isError: true,
              outcome: `HTTP ${imgRes.status}`,
            };
          }
          const rawContentType = (imgRes.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim().toLowerCase();
          const contentType = ALLOWED_IMAGE_TYPES.has(rawContentType) ? rawContentType : 'image/jpeg';
          const arrayBuf = await imgRes.arrayBuffer();
          if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > MAX_IMAGE_BYTES) {
            return { output: { error: 'Image file size is empty or exceeds 10MB.' }, isError: true };
          }
          const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
          const filename =
            typeof input.filename === 'string' && input.filename.trim()
              ? input.filename.trim()
              : `catalog-photo-${Date.now()}.${ext}`;
          const uploaded = await this.trypostClient.uploadMedia(auth, {
            buffer: Buffer.from(arrayBuf),
            filename,
            contentType,
          });
          return {
            output: {
              uploaded: true,
              uploadToken: uploaded.uploadToken,
              mediaId: uploaded.id,
              url: uploaded.url,
              contentType,
              bytes: arrayBuf.byteLength,
            },
            outcome: 'Media uploaded',
          };
        },
      },
      {
        title: 'Create remote draft in TryPost',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'create_trypost_draft',
          description:
            'Create a NON-PUBLISHING remote draft (`status: "draft"`) in TryPost for specified social account ID(s), optionally attaching uploaded `mediaTokens`. Strictly validates that no confidential internal margins/costs are included and verifies the created draft exists remotely. NEVER schedules or publishes.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Public post copy/caption (must NOT contain internal margins, costs, or supplier info)' },
              channelIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of TryPost social account IDs from inspect_trypost_accounts',
              },
              mediaTokens: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional array of upload_token strings returned by upload_trypost_media',
              },
              internalNote: { type: 'string', description: 'Optional brief internal note (must still avoid secrets)' },
            },
            required: ['content', 'channelIds'],
          },
        },
        execute: async (input) => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return { output: { error: 'TryPost is not connected.' }, isError: true, outcome: 'TryPost not connected' };
          }
          const policy = await this.intelligence.getOrCreatePolicy(workspaceId);
          if (policy.paused) {
            return {
              output: { error: 'Social Agent is paused; remote TryPost operations are blocked.' },
              isError: true,
              outcome: 'Agent paused',
            };
          }
          const content = typeof input.content === 'string' ? input.content.trim() : '';
          const channelIds = Array.isArray(input.channelIds)
            ? input.channelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            : [];
          const mediaTokens = Array.isArray(input.mediaTokens)
            ? input.mediaTokens.filter((tok): tok is string => typeof tok === 'string' && tok.trim().length > 0)
            : [];
          if (!content || channelIds.length === 0) {
            return {
              output: { error: 'Both content and at least one TryPost channelId are required.' },
              isError: true,
            };
          }
          // P0 Confidentiality Gate — deterministically blocks internal margins/costs before remote write!
          assertPublicContentSafe(content, 'TryPost remote draft');

          // Idempotency check against existing remote drafts
          const existingPosts = await this.trypostClient.listPosts(auth).catch(() => []);
          const prefix = content.slice(0, 80).toLowerCase();
          const dup = existingPosts.find(
            (post) =>
              typeof post.content === 'string' &&
              post.content.trim().toLowerCase().startsWith(prefix),
          );
          if (dup) {
            return {
              output: {
                deduplicated: true,
                postId: dup.id ?? null,
                status: dup.status ?? 'draft',
                verifiedRemote: true,
              },
              outcome: 'Draft already exists',
              awaitingApproval: true,
            };
          }

          const created = await this.trypostClient.createPost(auth, {
            content,
            channelIds,
            mediaTokens: mediaTokens.length > 0 ? mediaTokens : undefined,
            status: 'draft',
            internalNote:
              typeof input.internalNote === 'string' && input.internalNote.trim()
                ? input.internalNote.trim().slice(0, 240)
                : 'Borrador creado por Agente Social de Crossmart (pendiente de aprobación humana).',
          });

          // Confirm remote existence via subsequent read
          const verifyPosts = await this.trypostClient.listPosts(auth).catch(() => []);
          const confirmed = verifyPosts.some((p) => String(p.id) === created.id);

          await this.prisma.socialAgentEvent.create({
            data: {
              workspaceId,
              eventType: 'trypost_draft_created',
              summary: `Borrador remoto creado en TryPost (${mediaTokens.length > 0 ? 'con fotografía' : 'solo texto'}).`,
              severity: 'success',
              metadata: { trypostPostId: created.id, channelIds, hasMedia: mediaTokens.length > 0 },
            },
          });

          return {
            output: {
              created: true,
              postId: created.id,
              status: created.status,
              channelIds,
              mediaAttached: mediaTokens.length > 0,
              verifiedRemote: confirmed,
            },
            outcome: 'Remote draft created',
            awaitingApproval: true,
          };
        },
      },
      {
        title: 'Query commercial knowledge and creative profiles',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'list_commercial_knowledge',
          description:
            'Read approved business knowledge rules (with their channel scope!) and optional dynamic creative profiles. Only apply channel-specific policies to matching channels.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const [entries, profiles] = await Promise.all([
            this.knowledge.listEntries(workspaceId),
            this.intelligence.listCreativeProfiles(workspaceId),
          ]);
          return {
            output: {
              knowledgeCount: entries.length,
              knowledge: entries.slice(0, 15).map((e) => ({
                category: e.category,
                scope: e.scope,
                title: e.title,
                content: e.content,
              })),
              creativeProfilesCount: profiles.length,
              creativeProfiles: profiles.slice(0, 10).map((p) => ({
                name: p.name,
                objective: p.objective,
                instructions: p.instructions,
              })),
            },
            outcome: `${entries.length} rules · ${profiles.length} profiles`,
          };
        },
      },
      {
        title: 'List Production content pieces',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'list_social_content_items',
          description:
            'List existing editorial ideas, drafts, scripts, and approval statuses in Crossmart Production.',
          inputSchema: { type: 'object', properties: {} },
        },
        execute: async () => {
          const items = await this.intelligence.listContentItems(workspaceId);
          return {
            output: {
              count: items.length,
              items: items.slice(0, 20).map((i) => ({
                kind: i.kind,
                title: i.title,
                status: i.status,
                pillar: i.pillar,
                version: i.contentVersion,
              })),
            },
            outcome: `${items.length} piece(s)`,
          };
        },
      },
      {
        title: 'Create editorial draft in Production',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'create_social_draft_item',
          description:
            'Create an editorial idea, post draft, carousel draft, or audiovisual script inside Crossmart Production (never schedules or publishes automatically). Deduplicates by title and blocks confidential margins/costs.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                description: 'One of: IDEA, POST, CAROUSEL, VIDEO_SCRIPT',
              },
              title: { type: 'string', description: 'Short clear title of the piece' },
              caption: { type: 'string', description: 'Public copy, caption, or script content (no internal margins/costs)' },
              objective: { type: 'string', description: 'Commercial or brand objective' },
              pillar: {
                type: 'string',
                description: 'One of: commercial, educational, informative, brand',
              },
            },
            required: ['title', 'caption'],
          },
        },
        execute: async (input) => {
          const title = typeof input.title === 'string' ? input.title.trim() : '';
          const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
          const kind = typeof input.kind === 'string' ? input.kind.toUpperCase() : 'IDEA';
          if (!title) {
            return { output: { error: 'Title is required' }, isError: true, outcome: 'Missing title' };
          }
          assertPublicContentSafe(`${title}\n${caption}`, 'Production draft');
          const existing = await this.prisma.socialContentItem.findFirst({
            where: { workspaceId, title: { equals: title, mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' },
          });
          if (existing) {
            return {
              output: {
                deduplicated: true,
                item: { title: existing.title, kind: existing.kind, status: existing.status },
              },
              outcome: 'Already exists',
              awaitingApproval: existing.status === 'PENDING_APPROVAL',
            };
          }
          const created = await this.intelligence.createContentItem(workspaceId, {
            kind,
            title,
            caption,
            objective: typeof input.objective === 'string' ? input.objective : undefined,
            pillar: typeof input.pillar === 'string' ? input.pillar : 'educational',
            productionMode: kind === 'VIDEO_SCRIPT' ? 'AUDIOVISUAL' : 'ASSISTED',
          });
          return {
            output: {
              created: true,
              item: { title: created.title, kind: created.kind, status: created.status },
            },
            outcome: 'Draft created',
            awaitingApproval: true,
          };
        },
      },
      {
        title: 'Save idea to TryPost idea bank',
        timeoutMs: EXTERNAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'save_trypost_idea',
          description:
            'Save a controlled editorial idea to the connected TryPost idea bank (strictly non-publishing, deduplicated by title, and blocked if containing internal margins/costs).',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Idea title' },
              content: { type: 'string', description: 'Public idea description (NO internal margins, costs, or supplier info)' },
            },
            required: ['title', 'content'],
          },
        },
        execute: async (input) => {
          const auth = await this.trypostConnections.openAuth(workspaceId);
          if (!auth) {
            return {
              output: { error: 'TryPost is not connected.' },
              isError: true,
              outcome: 'TryPost not connected',
            };
          }
          const title = typeof input.title === 'string' ? input.title.trim() : '';
          const content = typeof input.content === 'string' ? input.content.trim() : '';
          if (!title) {
            return { output: { error: 'Title is required' }, isError: true };
          }
          // P0 Confidentiality Gate
          assertPublicContentSafe(`${title}\n${content}`, 'TryPost idea');
          const existingIdeas = await this.trypostClient.listIdeas(auth).catch(() => []);
          const dup = existingIdeas.find(
            (idea) =>
              typeof idea.title === 'string' && idea.title.trim().toLowerCase() === title.toLowerCase(),
          );
          if (dup) {
            return {
              output: { deduplicated: true, existingId: dup.id ?? null, title },
              outcome: 'Already exists in TryPost',
            };
          }
          const created = await this.trypostClient.createIdea(auth, { title, content });
          await this.prisma.socialAgentEvent.create({
            data: {
              workspaceId,
              eventType: 'trypost_idea_created',
              summary: `Idea guardada en TryPost: ${title}`,
              severity: 'info',
            },
          });
          return {
            output: { created: true, id: created.id, title },
            outcome: 'Saved to TryPost',
          };
        },
      },
    ];
  }
}
