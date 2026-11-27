import { Injectable } from '@nestjs/common';
import { PrismaService } from '@crossmart/database';
import type { ExecutableAgentTool } from '../ai/services/agent-execution-engine.service.js';
import { SalesKnowledgeService } from '../sales-agent/sales-knowledge.service.js';
import { SocialIntelligenceService } from './social-intelligence.service.js';
import { TryPostClient } from './trypost.client.js';
import { TryPostConnectionService } from './trypost-connection.service.js';

const EXTERNAL_TOOL_TIMEOUT_MS = 25_000;
const LOCAL_TOOL_TIMEOUT_MS = 15_000;

/**
 * Specialized toolset for Agente Social, plugged into Crossmart's shared `AgentExecutionEngine`.
 * All TryPost read operations execute against the real connected TryPost REST API.
 * Draft/idea creation enforces idempotency (deduplicating recent identical titles) and NEVER
 * schedules or publishes content automatically without human approval.
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
            'Inspect real TryPost connection status, connected social accounts (platforms, usernames, statuses), and available capabilities.',
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
            output: { count: posts.length, posts: posts.slice(0, 20) },
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
            output: { count: ideas.length, ideas: ideas.slice(0, 20) },
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
        title: 'Analyze catalog and inventory opportunities',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'analyze_catalog_opportunities',
          description:
            'Analyze real workspace catalog products, stock availability, categories, and commercial opportunities (excluding out-of-stock products).',
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
        title: 'Query commercial knowledge and creative profiles',
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        definition: {
          name: 'list_commercial_knowledge',
          description:
            'Read approved business knowledge rules and optional dynamic creative profiles for this workspace.',
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
            'Create an editorial idea, post draft, carousel draft, or audiovisual script inside Crossmart Production (never schedules or publishes automatically). Deduplicates by title.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                description: 'One of: IDEA, POST, CAROUSEL, VIDEO_SCRIPT',
              },
              title: { type: 'string', description: 'Short clear title of the piece' },
              caption: { type: 'string', description: 'Copy, caption, or script content' },
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
          // Idempotency: avoid creating duplicate pieces with the same normalized title
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
              outcome: 'Already exists (deduplicated)',
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
            outcome: `Draft created (${created.kind})`,
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
            'Save a controlled editorial idea to the connected TryPost idea bank (strictly non-publishing, deduplicated by title). Only call when the user explicitly asks to save an idea in TryPost.',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Idea title' },
              content: { type: 'string', description: 'Idea description or draft text' },
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
          // Idempotency check against existing remote TryPost ideas
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
