import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, type ToolRuntime } from './runtime.js';

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

// Typed view of the parts of the release config a deploy consumes. Everything
// is optional — the config is repo-authored and defensively read.
interface HubReleaseConfig {
  runsOn?: string;
  containerDiskInGb?: number;
  gpuIds?: string;
  gpuCount?: number;
  allowedCudaVersions?: string[];
  env?: Array<{
    key: string;
    input?: {
      name?: string;
      type?: string;
      default?: unknown;
      required?: boolean;
      trueValue?: string;
      falseValue?: string;
    };
  }>;
}

// The one listings query both hub tools share. `withConfig` pulls in the
// (large) release config only when the caller needs it.
function listingsQuery(withConfig: boolean): string {
  return `
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
          createdAt${withConfig ? '\n          config' : ''}
          build {
            id
            imageName
          }
        }
      }
    }
  `;
}

// Builds the template env array a Hub deploy submits: every key from the
// release's env schema with its default (booleans serialized through
// trueValue/falseValue), overridden by caller-provided values. Caller keys not
// in the schema are appended verbatim. Returns the missing required keys so
// the tool can fail with an actionable message instead of a broken endpoint.
export function buildHubEnv(
  config: HubReleaseConfig,
  overrides: Record<string, string>
): {
  env: Array<{ key: string; value: string }>;
  missingRequired: string[];
} {
  const env: Array<{ key: string; value: string }> = [];
  const missingRequired: string[] = [];
  const remaining = { ...overrides };

  for (const entry of config.env ?? []) {
    const input = entry.input ?? {};
    let value: string;
    if (entry.key in remaining) {
      value = remaining[entry.key];
      delete remaining[entry.key];
    } else if (input.default !== undefined && input.default !== null) {
      value =
        typeof input.default === 'boolean'
          ? input.default
            ? (input.trueValue ?? 'true')
            : (input.falseValue ?? 'false')
          : String(input.default);
    } else {
      if (input.required) missingRequired.push(entry.key);
      value = '';
    }
    env.push({ key: entry.key, value });
  }

  for (const [key, value] of Object.entries(remaining)) {
    env.push({ key, value });
  }

  return { env, missingRequired };
}

// Lowest entry of the config's allowedCudaVersions (numeric-aware compare, so
// '12.10' > '12.9'). The console submits this as minCudaVersion.
export function minCudaVersion(versions: string[] | undefined): string | null {
  if (!versions || versions.length === 0) return null;
  const compare = (a: string, b: string) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return [...versions].sort(compare)[0];
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function registerHubTools(server: McpServer, rt: ToolRuntime): void {
  const { graphql, graphqlAuthed, jsonReply } = rt;

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
      const data = await graphql<ListingsResponse>(
        listingsQuery(params.includeConfig === true)
      );

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

  server.tool(
    'deploy-hub-repo',
    "Deploy a Runpod Hub repo's listed release as a new Serverless endpoint (the same as clicking Deploy on the Hub). Identify the repo by `repo` (\"owner/name\" from list-hub-repos) or by `hubReleaseId`. The release supplies the prebuilt image, container disk, CUDA constraints, and env-var defaults; pass `env` to override or fill in values (required keys without a default must be provided — check list-hub-repos with includeConfig:true for the schema). GPU selection comes from the release config when it specifies one; otherwise pass gpuIds (GPU pool names, e.g. 'ADA_24' or 'ADA_80_PRO,AMPERE_80'). Uses the authenticated GraphQL API (no REST home for Hub deploys yet), so it works the same on v1 and v2.",
    {
      repo: z
        .string()
        .optional()
        .describe(
          'The Hub repo to deploy as "owner/name" (e.g. \'runpod-workers/worker-comfyui\'). Deploys its currently listed release. Provide this or hubReleaseId.'
        ),
      hubReleaseId: z
        .string()
        .optional()
        .describe(
          'The Hub release ID to deploy (from list-hub-repos listedRelease.hubReleaseId). Provide this or repo.'
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Name for the new endpoint. Defaults to '<listing title> <release tag>'."
        ),
      env: z
        .record(z.string())
        .optional()
        .describe(
          'Environment variable overrides, merged over the release config defaults. Keys not in the release schema are passed through as-is.'
        ),
      gpuIds: z
        .string()
        .optional()
        .describe(
          "Comma-separated GPU pool names for workers (e.g. 'ADA_24' or 'ADA_80_PRO,AMPERE_80'). Defaults to the release config's gpuIds; required when the config does not specify one."
        ),
      gpuCount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('GPUs per worker. Defaults to the release config (or 1).'),
      containerDiskInGb: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Container disk size in GB. Defaults to the release config.'),
      workersMin: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Minimum workers (default 0 — scale to zero).'),
      workersMax: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum workers (default: account default).'),
      idleTimeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Seconds a worker idles before scaling down (default 5).'),
      scalerType: z
        .enum(['QUEUE_DELAY', 'REQUEST_COUNT'])
        .optional()
        .describe('Autoscaler type (default QUEUE_DELAY).'),
      scalerValue: z
        .number()
        .optional()
        .describe('Autoscaler target value (default 4).'),
      executionTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Per-job execution timeout in ms (default 600000).'),
      flashboot: z
        .enum(['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'])
        .optional()
        .describe('FlashBoot mode (default FLASHBOOT).'),
    },
    { title: 'Deploy Hub repo', ...WRITE },
    async (params) => {
      if (!params.repo && !params.hubReleaseId) {
        return jsonReply({
          error:
            'Provide either repo ("owner/name") or hubReleaseId. Use list-hub-repos to discover both.',
        });
      }

      // Resolve the listing + release from the public catalog. The catalog only
      // exposes each repo's currently LISTED release, so a hubReleaseId must
      // match one of those (which is also the only state the console deploys).
      const catalog = await graphql<ListingsResponse>(listingsQuery(true));
      let listing: HubListing | undefined;
      if (params.hubReleaseId) {
        listing = catalog.listings.find(
          (l) => l.listedRelease?.id === params.hubReleaseId
        );
      } else {
        const repoKey = params.repo!.toLowerCase();
        listing = catalog.listings.find(
          (l) => `${l.repoOwner}/${l.repoName}`.toLowerCase() === repoKey
        );
      }
      if (!listing) {
        return jsonReply({
          error: `No Hub listing found for ${
            params.hubReleaseId
              ? `hubReleaseId "${params.hubReleaseId}" (only each repo's currently listed release is deployable)`
              : `repo "${params.repo}"`
          }. Use list-hub-repos to see the catalog.`,
        });
      }
      const release = listing.listedRelease;
      if (!release?.build?.imageName) {
        return jsonReply({
          error: `Hub repo ${listing.repoOwner}/${listing.repoName} has no listed release with a built image, so it cannot be deployed.`,
        });
      }
      if ((listing.type ?? '').toUpperCase() !== 'SERVERLESS') {
        return jsonReply({
          error: `Hub repo ${listing.repoOwner}/${listing.repoName} is a ${listing.type} listing — only SERVERLESS listings deploy as endpoints.`,
        });
      }

      const config = (parseReleaseConfig(release.config) ??
        {}) as HubReleaseConfig;

      const gpuIds = params.gpuIds ?? config.gpuIds;
      if (!gpuIds) {
        return jsonReply({
          error:
            'This release does not specify a GPU pool — pass gpuIds (comma-separated pool names, e.g. "ADA_80_PRO,AMPERE_80"; see the pool field on list-gpu-types).',
        });
      }

      const { env, missingRequired } = buildHubEnv(config, params.env ?? {});
      if (missingRequired.length > 0) {
        return jsonReply({
          error: `Missing required environment variables for this release: ${missingRequired.join(
            ', '
          )}. Pass them via the env parameter.`,
        });
      }

      const endpointName = params.name ?? `${listing.title} ${release.tagName}`;
      const minCuda = minCudaVersion(config.allowedCudaVersions);

      const input: Record<string, unknown> = {
        name: endpointName,
        hubReleaseId: release.id,
        type: 'QB',
        gpuIds,
        gpuCount: params.gpuCount ?? config.gpuCount ?? 1,
        workersMin: params.workersMin ?? 0,
        workersMax: params.workersMax ?? null,
        idleTimeout: params.idleTimeout ?? 5,
        scalerType: params.scalerType ?? 'QUEUE_DELAY',
        scalerValue: params.scalerValue ?? 4,
        executionTimeoutMs: params.executionTimeoutMs ?? 600000,
        flashBootType: params.flashboot ?? 'FLASHBOOT',
        locations: null,
        networkVolumeIds: null,
        compliance: [],
        modelReferences: [],
        ...(minCuda
          ? {
              minCudaVersion: minCuda,
              allowedCudaVersions: config.allowedCudaVersions!.join(','),
            }
          : {}),
        template: {
          name: `${endpointName}__template__${randomSuffix()}`,
          imageName: release.build.imageName,
          containerDiskInGb:
            params.containerDiskInGb ?? config.containerDiskInGb ?? 20,
          containerRegistryAuthId: '',
          dockerArgs: '',
          startScript: '',
          ports: '',
          env,
        },
      };

      interface SaveEndpointResponse {
        saveEndpoint: {
          id: string;
          name: string;
          gpuIds: string;
          gpuCount: number;
          workersMin: number;
          workersMax: number | null;
          idleTimeout: number;
          scalerType: string;
          scalerValue: number;
          flashBootType: string;
          templateId: string;
        };
      }

      const data = await graphqlAuthed<SaveEndpointResponse>(
        `
          mutation saveEndpoint($input: EndpointInput!) {
            saveEndpoint(input: $input) {
              id
              name
              gpuIds
              gpuCount
              workersMin
              workersMax
              idleTimeout
              scalerType
              scalerValue
              flashBootType
              templateId
            }
          }
        `,
        { input }
      );

      return jsonReply({
        endpoint: data.saveEndpoint,
        deployed: {
          repo: `${listing.repoOwner}/${listing.repoName}`,
          release: release.tagName,
          hubReleaseId: release.id,
          imageName: release.build.imageName,
        },
        note: `Endpoint created. Submit jobs with run-endpoint/runsync-endpoint using endpointId "${data.saveEndpoint.id}".`,
      });
    }
  );
}
