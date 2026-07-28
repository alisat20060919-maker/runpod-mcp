import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, type ToolRuntime } from './runtime.js';

// ============== PUBLIC ENDPOINT TOOLS ==============
// Read-only discovery of Runpod Public Endpoints — the managed, pay-per-use
// model APIs (e.g. Kimi, Hailuo, Veo) that need no deployment. Served by the
// public GraphQL endpoint (allAiApiPublicConfigs) — no auth required — like
// the Hub catalog, and version-agnostic (no REST home yet).
//
// A public endpoint is invoked like any Serverless endpoint using its
// `endpointId` (the aiApiId), so results here feed directly into
// run-endpoint / runsync-endpoint.

interface PublicEndpointConfig {
  id: string;
  aiApiId: string;
  modelName: string;
  displayName: string;
  description: string | null;
  metadata: string | null;
  isLive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PublicEndpointsResponse {
  allAiApiPublicConfigs: PublicEndpointConfig[];
}

// `metadata` is a JSON string carrying pricing and classification (cost,
// owner, source/modality, tag, priceString). Parsed defensively — a malformed
// value falls back to undefined fields rather than a crash.
interface PublicEndpointMetadata {
  cost?: number;
  owner?: string;
  source?: string;
  tag?: string;
  priceString?: string;
}

function parseMetadata(
  metadata: string | null | undefined
): PublicEndpointMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as PublicEndpointMetadata)
      : {};
  } catch {
    return {};
  }
}

export function registerPublicEndpointTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { graphql } = rt;

  server.tool(
    'list-public-endpoints',
    'List Runpod Public Endpoints — managed, pay-per-use model APIs (text, image, video, audio) that require no deployment. Public catalog, no auth required. Each result includes the endpointId to call with run-endpoint/runsync-endpoint (or via https://api.runpod.ai/v2/{endpointId}), the model name, modality, owner, and pricing. Only live endpoints are returned by default; set includeOffline:true to also list ones that are not currently live.',
    {
      ...listPaginationParams,
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Case-insensitive search across display name, model name, endpoint id, description, owner, and tag (e.g. 'kimi', 'video', 'flux')"
        ),
      modality: z
        .string()
        .optional()
        .describe(
          "Filter by modality/category (the metadata source field, e.g. 'language', 'image', 'video', 'audio')"
        ),
      owner: z
        .string()
        .optional()
        .describe(
          "Filter by model owner (e.g. 'moonshot', 'minimax', 'google')"
        ),
      includeOffline: z
        .boolean()
        .optional()
        .describe(
          'Include endpoints that are not currently live (isLive:false). Default false — only live endpoints are listed.'
        ),
    },
    { title: 'List public endpoints', ...READ_ONLY },
    async (params) => {
      const data = await graphql<PublicEndpointsResponse>(`
        query {
          allAiApiPublicConfigs {
            id
            aiApiId
            modelName
            displayName
            description
            metadata
            isLive
            createdAt
            updatedAt
          }
        }
      `);

      let configs = data.allAiApiPublicConfigs.map((c) => ({
        config: c,
        meta: parseMetadata(c.metadata),
      }));

      if (!params.includeOffline) {
        configs = configs.filter(({ config }) => config.isLive);
      }
      if (params.modality) {
        const term = params.modality.toLowerCase();
        configs = configs.filter(
          ({ meta }) => (meta.source ?? '').toLowerCase() === term
        );
      }
      if (params.owner) {
        const term = params.owner.toLowerCase();
        configs = configs.filter(
          ({ meta }) => (meta.owner ?? '').toLowerCase() === term
        );
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLowerCase();
        configs = configs.filter(({ config, meta }) =>
          [
            config.displayName,
            config.modelName,
            config.aiApiId,
            config.description,
            meta.owner,
            meta.tag,
            meta.source,
          ].some((field) => (field ?? '').toLowerCase().includes(term))
        );
      }

      // Stable, scannable order for the catalog.
      configs = [...configs].sort((a, b) =>
        a.config.displayName.localeCompare(b.config.displayName)
      );

      const result = configs.map(({ config, meta }) => ({
        endpointId: config.aiApiId,
        displayName: config.displayName,
        modelName: config.modelName,
        description: config.description,
        modality: meta.source,
        tag: meta.tag,
        owner: meta.owner,
        pricing: meta.priceString,
        isLive: config.isLive,
        baseUrl: `https://api.runpod.ai/v2/${config.aiApiId}`,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      }));

      return capListResult(result, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );
}
