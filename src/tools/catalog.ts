import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, type ToolRuntime } from './runtime.js';

// ============== INFRASTRUCTURE / CATALOG TOOLS ==============
// GPU types, data centers, CPU types. v1 reads these over GraphQL; v2 has a REST
// catalog (GET /v2/catalog/*). The adapter picks the backend; v2-only entries
// return a 501 notice on v1.

export function registerCatalogTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, graphql, callRestUrl, backendFor } = rt;

  // List GPU Types
  server.tool(
    'list-gpu-types',
    'List available GPU types with stock/pricing and capability filters (minimum VRAM, secure/community cloud, name search). Use this to discover valid gpuTypeIds before creating a pod or endpoint. By default the full catalog is returned: each result includes an `availability` summary (HIGH/MEDIUM/LOW/NONE) and results are sorted with the most-available GPUs first, but nothing is hidden. Set includeUnavailable:false to drop out-of-stock GPUs and list only deployable ones (set includeAvailability:false to skip the stock lookup entirely). For per-datacenter availability (to pick a dataCenterIds), use get-gpu-type.',
    {
      ...listPaginationParams,
      minMemoryGb: z
        .number()
        .optional()
        .describe('Filter to GPUs with at least this much VRAM in GB'),
      secureCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in secure cloud'),
      communityCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in community cloud'),
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Search term to filter GPUs by name (e.g., 'A100', 'RTX 4090')"
        ),
      includeUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Out-of-stock GPUs are included by default (annotated availability:NONE and sorted last). Set false to hide them and list only currently-deployable GPUs.'
        ),
      includeAvailability: z
        .boolean()
        .optional()
        .describe(
          'Request realtime stock and annotate each GPU with an availability summary (HIGH/MEDIUM/LOW/NONE). Default true. Set false to skip the availability lookup — then out-of-stock GPUs cannot be filtered.'
        ),
    },
    { title: 'List GPU types', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('gpus');
      if (backend.version === 'v2') {
        // v2 REST: GET /v2/catalog/gpus?include=AVAILABILITY → { gpus: [...] },
        // each with a top-level `availability` summary (HIGH/MEDIUM/LOW/NONE)
        // plus a per-datacenter `dataCenters` breakdown. Filters re-applied
        // against v2 field names (memory/secure/community/name). Availability is
        // on by default; opt out with includeAvailability:false (then the
        // out-of-stock filter/sort below simply no-op, since there's no data).
        const wantAvailability = params.includeAvailability !== false;
        const raw = await callRestUrl(
          `${backend.base}${backend.list}${
            wantAvailability ? '?include=AVAILABILITY' : ''
          }`
        );
        let gpus = backend.unwrap(raw) as Array<Record<string, unknown>>;
        if (params.minMemoryGb !== undefined)
          gpus = gpus.filter(
            (g) => Number(g.memory ?? 0) >= params.minMemoryGb!
          );
        if (params.secureCloudOnly) gpus = gpus.filter((g) => g.secure);
        if (params.communityCloudOnly) gpus = gpus.filter((g) => g.community);
        if (params.searchTerm) {
          const t = params.searchTerm.toLowerCase();
          gpus = gpus.filter(
            (g) =>
              String(g.id ?? '')
                .toLowerCase()
                .includes(t) ||
              String(g.name ?? '')
                .toLowerCase()
                .includes(t)
          );
        }
        // Full catalog by default — nothing hidden. Out-of-stock GPUs stay in
        // the list (annotated availability:NONE and sorted last below) so this
        // stays a complete discovery tool. Only opt-in (includeUnavailable:false)
        // filters down to deployable GPUs. A GPU whose `availability` the backend
        // didn't populate is treated as available, so the opt-in never over-filters.
        if (params.includeUnavailable === false)
          gpus = gpus.filter((g) => g.availability !== 'NONE');
        // Highest stock first so the best pick is at the top.
        const rank: Record<string, number> = {
          HIGH: 3,
          MEDIUM: 2,
          LOW: 1,
          NONE: 0,
        };
        gpus.sort(
          (a, b) =>
            (rank[String(b.availability)] ?? 0) -
            (rank[String(a.availability)] ?? 0)
        );
        // Drop the verbose per-datacenter breakdown from the list (30+ entries ×
        // every GPU); keep the `availability` summary. get-gpu-type returns the
        // full per-datacenter detail for choosing a dataCenterIds.
        gpus = gpus.map(({ dataCenters: _dataCenters, ...rest }) => rest);
        return capListResult(gpus, {
          limit: params.limit,
          cursor: params.cursor,
        });
      }

      interface GpuTypesResponse {
        gpuTypes: Array<{
          id: string;
          displayName: string;
          memoryInGb: number;
          secureCloud: boolean;
          communityCloud: boolean;
          lowestPrice?: { stockStatus: string | null } | null;
        }>;
      }

      const data = await graphql<GpuTypesResponse>(`
        query {
          gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            lowestPrice(input: { gpuCount: 1 }) {
              stockStatus
            }
          }
        }
      `);

      const stockPriority: Record<string, number> = {
        High: 3,
        Medium: 2,
        Low: 1,
      };

      const isAvailable = (gpu: GpuTypesResponse['gpuTypes'][number]) => {
        const status = gpu.lowestPrice?.stockStatus;
        return !!status && status !== 'Out';
      };

      let gpuTypes = data.gpuTypes.filter((gpu) => gpu.id !== 'unknown');

      // Full catalog by default; opt in (includeUnavailable:false) to hide out-of-stock.
      if (params.includeUnavailable === false) {
        gpuTypes = gpuTypes.filter(isAvailable);
      }
      if (params.minMemoryGb) {
        gpuTypes = gpuTypes.filter(
          (gpu) => gpu.memoryInGb >= params.minMemoryGb!
        );
      }
      if (params.secureCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.secureCloud);
      }
      if (params.communityCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.communityCloud);
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLowerCase();
        gpuTypes = gpuTypes.filter(
          (gpu) =>
            gpu.id.toLowerCase().includes(term) ||
            gpu.displayName.toLowerCase().includes(term)
        );
      }

      gpuTypes.sort((a, b) => {
        const aP = stockPriority[a.lowestPrice?.stockStatus || ''] || 0;
        const bP = stockPriority[b.lowestPrice?.stockStatus || ''] || 0;
        if (bP !== aP) return bP - aP;
        return b.memoryInGb - a.memoryInGb;
      });

      const result = gpuTypes.map((gpu) => ({
        id: gpu.id,
        displayName: gpu.displayName,
        memoryGb: gpu.memoryInGb,
        secureCloud: gpu.secureCloud,
        communityCloud: gpu.communityCloud,
        stockStatus: gpu.lowestPrice?.stockStatus || 'unavailable',
        available: isAvailable(gpu),
      }));

      return capListResult(result, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // List Data Centers
  server.tool(
    'list-data-centers',
    'List Runpod data centers (id, name, region/location). Use this to discover valid dataCenterIds for placing pods, endpoints, or network volumes.',
    {
      ...listPaginationParams,
      region: z
        .string()
        .optional()
        .describe(
          "Filter by region/location (e.g., 'United States', 'Europe', 'Canada')"
        ),
    },
    { title: 'List data centers', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('dataCenters');
      if (backend.version === 'v2') {
        // v2 REST: GET /v2/catalog/datacenters → { dataCenters: [...] }. v2 uses
        // a `region` enum (vs v1 free-text `location`); region filter matches it.
        const raw = await callRestUrl(`${backend.base}${backend.list}`);
        let dcs = backend.unwrap(raw) as Array<Record<string, unknown>>;
        if (params.region) {
          const t = params.region.toLowerCase();
          dcs = dcs.filter((dc) =>
            String(dc.region ?? '')
              .toLowerCase()
              .includes(t)
          );
        }
        return capListResult(dcs, {
          limit: params.limit,
          cursor: params.cursor,
        });
      }

      interface DataCentersResponse {
        dataCenters: Array<{
          id: string;
          name: string;
          location: string;
        }>;
      }

      const data = await graphql<DataCentersResponse>(`
        query {
          dataCenters {
            id
            name
            location
          }
        }
      `);

      let dataCenters = data.dataCenters;

      if (params.region) {
        const term = params.region.toLowerCase();
        dataCenters = dataCenters.filter((dc) =>
          dc.location.toLowerCase().includes(term)
        );
      }

      return capListResult(dataCenters, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // List CPU Types (v2-only — v2 catalog REST has no v1/GraphQL equivalent)
  server.tool(
    'list-cpu-types',
    'List available CPU flavor types for CPU pods/endpoints. v2-only — returns a 501 notice on the v1 API.',
    { ...listPaginationParams },
    { title: 'List CPU types', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('cpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'list-cpu-types is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const raw = await callRestUrl(`${backend.base}${backend.list}`);
      return capListResult(backend.unwrap(raw), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get GPU Type by id (v2-only — GET /v2/catalog/gpus/{id})
  server.tool(
    'get-gpu-type',
    'Get details for a single GPU type by id, including per-datacenter availability. v2-only — returns a 501 notice on the v1 API (use list-gpu-types there). Use the returned dataCenters[].availability to pick a dataCenterIds with stock before creating a pod.',
    {
      gpuTypeId: z.string().describe('ID of the GPU type to retrieve'),
      includeAvailability: z
        .boolean()
        .optional()
        .describe(
          'Include realtime per-datacenter availability (HIGH/MEDIUM/LOW/NONE). Default true.'
        ),
    },
    { title: 'Get GPU type', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('gpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-gpu-type is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2 (or use list-gpu-types on v1).',
          status: 501,
        });
      }
      // GPU ids contain spaces (e.g. "NVIDIA GeForce RTX 4090"), so encode the
      // path segment. Availability is on by default — it's the reason to fetch a
      // single GPU (choosing a datacenter with stock).
      const path = backend.get!(encodeURIComponent(params.gpuTypeId));
      const query =
        params.includeAvailability === false ? '' : '?include=AVAILABILITY';
      const result = await callRestUrl(`${backend.base}${path}${query}`);
      return jsonReply(result);
    }
  );

  // Get CPU Type by id (v2-only — GET /v2/catalog/cpus/{id})
  server.tool(
    'get-cpu-type',
    'Get details for a single CPU flavor type by id. v2-only — returns a 501 notice on the v1 API (use list-cpu-types there).',
    {
      cpuTypeId: z.string().describe('ID of the CPU type to retrieve'),
    },
    { title: 'Get CPU type', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('cpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-cpu-type is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.cpuTypeId)}`
      );
      return jsonReply(result);
    }
  );

  // Get Data Center by id (v2-only — GET /v2/catalog/datacenters/{id})
  server.tool(
    'get-data-center',
    'Get details for a single data center by id. v2-only — returns a 501 notice on the v1 API (use list-data-centers there).',
    {
      dataCenterId: z.string().describe('ID of the data center to retrieve'),
    },
    { title: 'Get data center', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('dataCenters');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-data-center is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.dataCenterId)}`
      );
      return jsonReply(result);
    }
  );
}
