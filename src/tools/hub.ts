import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, type ToolRuntime } from './runtime.js';

// ============== HUB TOOLS ==============
// Read-only discovery of Runpod Hub listings (prebuilt serverless workers and
// pod templates published from GitHub repos, e.g. worker-vllm, worker-comfyui).
// Served by the public GraphQL endpoint — no auth required — like the v1
// catalog tools. There is no REST home for the Hub yet, so this is
// version-agnostic: the same GraphQL path is used on v1 and v2.
//
// The `listings(input: {})` query returns the full public catalog; the
// endpoint does not accept GraphQL variables on the public path, so filters
// (search, category, type, owner) are applied client-side, matching the
// list-gpu-types v1 pattern. Each listing carries its currently listed
// release, whose id (`hubReleaseId`) and built image are what a Hub deploy is
// pinned to.

interface HubBuild {
  id: string;
  imageName: string;
}

interface HubRelease {
  id: string;
  name: string;
  tagName: string;
  createdAt: string;
  config?: string | null;
  build?: HubBuild | null;
}

interface HubListing {
  id: string;
  repoId: string;
  title: string;
  description: string | null;
  repoName: string;
  repoOwner: string;
  createdAt: string;
  updatedAt: string;
  views: number;
  stars: number;
  deploys: number;
  language: string | null;
  category: string | null;
  tags: string[] | null;
  type: string;
  listedRelease?: HubRelease | null;
}

interface ListingsResponse {
  listings: HubListing[];
}

// The release `config` is the repo's .runpod/hub.json config serialized as a
// JSON string (hardware requirements + the env-var input schema). It can be
// tens of KB per listing, so it is only requested when includeConfig is set.
function parseReleaseConfig(config: string | null | undefined): unknown {
  if (!config) return undefined;
  try {
    return JSON.parse(config);
  } catch {
    return config;
  }
}

export function registerHubTools(server: McpServer, rt: ToolRuntime): void {
  const { graphql } = rt;

  server.tool(
    'list-hub-repos',
    'List repos published to the Runpod Hub (prebuilt Serverless workers and Pod templates, e.g. vLLM, ComfyUI). Public catalog — no auth required. Each result includes the currently listed release with its hubReleaseId and prebuilt image name. Results are sorted by deploy count (most popular first). Set includeConfig:true to also return the release config (hardware requirements and environment-variable schema) — it is large, so prefer requesting it for a single repo via the repoOwner/searchTerm filters.',
    {
      ...listPaginationParams,
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Case-insensitive search across title, description, repo name, owner, and tags (e.g. 'vllm', 'comfyui', 'fine-tuning')"
        ),
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category (e.g. 'language', 'image', 'audio', 'video', 'embedding')"
        ),
      type: z
        .enum(['SERVERLESS', 'POD'])
        .optional()
        .describe(
          'Filter by listing type: SERVERLESS (endpoint workers) or POD (pod templates)'
        ),
      repoOwner: z
        .string()
        .optional()
        .describe(
          "Filter to listings from this GitHub owner/org (e.g. 'runpod-workers', 'axolotl-ai-cloud')"
        ),
      includeConfig: z
        .boolean()
        .optional()
        .describe(
          'Include the listed release config (hardware requirements + env-var input schema, parsed from .runpod/hub.json). Large — off by default.'
        ),
    },
    { title: 'List Hub repos', ...READ_ONLY },
    async (params) => {
      const configField = params.includeConfig ? '\n            config' : '';
      const data = await graphql<ListingsResponse>(`
        query {
          listings(input: {}) {
            id
            repoId
            title
            description
            repoName
            repoOwner
            createdAt
            updatedAt
            views
            stars
            deploys
            language
            category
            tags
            type
            listedRelease {
              id
              name
              tagName
              createdAt${configField}
              build {
                id
                imageName
              }
            }
          }
        }
      `);

      let listings = data.listings;

      if (params.type) {
        listings = listings.filter(
          (l) => (l.type ?? '').toUpperCase() === params.type
        );
      }
      if (params.category) {
        const term = params.category.toLowerCase();
        listings = listings.filter(
          (l) => (l.category ?? '').toLowerCase() === term
        );
      }
      if (params.repoOwner) {
        const term = params.repoOwner.toLowerCase();
        listings = listings.filter(
          (l) => (l.repoOwner ?? '').toLowerCase() === term
        );
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLowerCase();
        listings = listings.filter((l) =>
          [
            l.title,
            l.description,
            l.repoName,
            l.repoOwner,
            ...(l.tags ?? []),
          ].some((field) => (field ?? '').toLowerCase().includes(term))
        );
      }

      // Most-deployed first so the well-known workers surface at the top.
      listings = [...listings].sort(
        (a, b) => (b.deploys ?? 0) - (a.deploys ?? 0)
      );

      const result = listings.map((l) => ({
        id: l.id,
        repo: `${l.repoOwner}/${l.repoName}`,
        title: l.title,
        description: l.description,
        type: l.type,
        category: l.category,
        tags: l.tags,
        language: l.language,
        stars: l.stars,
        deploys: l.deploys,
        views: l.views,
        githubUrl: `https://github.com/${l.repoOwner}/${l.repoName}`,
        hubUrl: `https://console.runpod.io/hub/${l.repoOwner}/${l.repoName}`,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        listedRelease: l.listedRelease
          ? {
              hubReleaseId: l.listedRelease.id,
              name: l.listedRelease.name,
              tagName: l.listedRelease.tagName,
              createdAt: l.listedRelease.createdAt,
              imageName: l.listedRelease.build?.imageName,
              ...(params.includeConfig
                ? { config: parseReleaseConfig(l.listedRelease.config) }
                : {}),
            }
          : null,
      }));

      return capListResult(result, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );
}
