import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE, type ToolRuntime } from './runtime.js';

// ============== ENDPOINT GPU PINNING ==============
// Sets which GPUs a Serverless endpoint's workers run on, including pinning
// specific GPU SKUs — a capability the REST API cannot express (its
// gpuPoolIds field has no SKU exclusion concept). The GraphQL `gpuIds` string
// is "POOL[,POOL...][,-<GPU type id>...]": pool names allow every SKU in the
// pool, and '-'-prefixed GPU type ids (from list-gpu-types) exclude SKUs, so
// a pool minus all-but-one SKU pins that SKU exactly.
//
// saveEndpoint is NOT a sparse update. Measured live with an
// id+name+gpuIds-only update: workersMax 7→3, idleTimeout 42→10, scalerValue
// 9→4 all reset to server defaults. Everything else held — including templateId,
// the CUDA fields, compliance and modelReferences. So the reset set is narrower
// than "every omitted field", but it is undocumented server behavior and could
// widen, so this tool reads the endpoint and echoes every field back with only
// gpuIds (and gpuCount) changed.
//
// Read shapes are not write shapes: networkVolumeIds reads as `NetworkVolumeIds`
// (networkVolumeId + dataCenterId) but writes as `NetworkVolumeIdsInput`
// (networkVolumeId ONLY), so echoing it verbatim gives `Field "dataCenterId" is
// not defined by type "NetworkVolumeIdsInput"` and breaks every volume-bearing
// endpoint.

interface EndpointSnapshot {
  id: string;
  name: string;
  gpuIds: string;
  gpuCount: number;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  scalerType: string;
  scalerValue: number;
  executionTimeoutMs: number;
  flashBootType: string;
  type: string;
  locations: string | null;
  templateId: string | null;
  // A comma-separated String on read AND write, not a list.
  allowedCudaVersions: string | null;
  minCudaVersion: string | null;
  // A [Compliance] ENUM on input, not [String] — the server rejects 'gdpr' and
  // suggests 'GDPR'. Read values are already enum names: pass back verbatim.
  compliance: string[] | null;
  modelReferences: string[] | null;
  networkVolumeIds: Array<{
    networkVolumeId: string;
    dataCenterId: string | null;
  }> | null;
}

interface MyEndpointsResponse {
  myself: { endpoints: EndpointSnapshot[] };
}

export function registerEndpointGpuTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { graphqlAuthed, jsonReply } = rt;

  server.tool(
    'set-endpoint-gpus',
    "Set which GPUs a Serverless endpoint's workers run on — including pinning specific GPU SKUs, which create-endpoint/update-endpoint cannot express. Provide either a raw gpuIds string, or pools plus optional excludeGpuTypeIds (GPU type ids from list-gpu-types) and the exclusion string is built for you: a pool allows every SKU in it, and excluding all but one SKU pins that SKU exactly (e.g. pools:['AMPERE_16'], excludeGpuTypeIds:['NVIDIA RTX 2000 Ada Generation','NVIDIA RTX 4000 Ada Generation','NVIDIA RTX A4500'] pins RTX A4000). All other endpoint settings (workers, scaling, timeouts, template) are read first and preserved. Works on any Serverless endpoint via the authenticated GraphQL API.",
    {
      endpointId: z
        .string()
        .describe('ID of the Serverless endpoint to update'),
      gpuIds: z
        .string()
        .optional()
        .describe(
          "Raw gpuIds string, e.g. 'ADA_24' or 'AMPERE_16,-NVIDIA RTX A4500'. Takes precedence over pools/excludeGpuTypeIds."
        ),
      pools: z
        .array(z.string())
        .optional()
        .describe(
          "GPU pool names workers may use (e.g. ['ADA_80_PRO','AMPERE_80']). The pool field from list-gpu-types."
        ),
      excludeGpuTypeIds: z
        .array(z.string())
        .optional()
        .describe(
          "GPU type ids to exclude from the allowed pools (e.g. ['NVIDIA H100 NVL']). Use with pools to pin specific SKUs."
        ),
      gpuCount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('GPUs per worker. Omit to keep the current value.'),
    },
    { title: 'Set endpoint GPUs', ...WRITE, idempotentHint: true },
    async (params) => {
      const gpuIds =
        params.gpuIds ??
        (params.pools && params.pools.length > 0
          ? [
              ...params.pools,
              ...(params.excludeGpuTypeIds ?? []).map((id) => `-${id}`),
            ].join(',')
          : undefined);
      if (!gpuIds) {
        return jsonReply({
          error:
            'Provide gpuIds (raw string) or pools (with optional excludeGpuTypeIds). See list-gpu-types for pool names and GPU type ids.',
        });
      }

      // Read the endpoint's current settings — saveEndpoint resets omitted
      // endpoint-level fields to defaults, so everything must be echoed back.
      const data = await graphqlAuthed<MyEndpointsResponse>(`
        query {
          myself {
            endpoints {
              id
              name
              gpuIds
              gpuCount
              workersMin
              workersMax
              idleTimeout
              scalerType
              scalerValue
              executionTimeoutMs
              flashBootType
              type
              locations
              templateId
              allowedCudaVersions
              minCudaVersion
              compliance
              modelReferences
              networkVolumeIds {
                networkVolumeId
                dataCenterId
              }
            }
          }
        }
      `);
      const current = data.myself.endpoints.find(
        (e) => e.id === params.endpointId
      );
      if (!current) {
        return jsonReply({
          error: `No Serverless endpoint found with id "${params.endpointId}". Use list-endpoints to see your endpoints.`,
        });
      }

      const input: Record<string, unknown> = {
        id: current.id,
        name: current.name,
        gpuIds,
        gpuCount: params.gpuCount ?? current.gpuCount,
        workersMin: current.workersMin,
        workersMax: current.workersMax,
        idleTimeout: current.idleTimeout,
        scalerType: current.scalerType,
        scalerValue: current.scalerValue,
        executionTimeoutMs: current.executionTimeoutMs,
        flashBootType: current.flashBootType,
        type: current.type,
        locations: current.locations,
        networkVolumeIds:
          current.networkVolumeIds && current.networkVolumeIds.length > 0
            ? // Drop dataCenterId: NetworkVolumeIdsInput takes networkVolumeId
              // ONLY, and the read shape is rejected outright.
              current.networkVolumeIds.map((v) => ({
                networkVolumeId: v.networkVolumeId,
              }))
            : null,
      };

      // Echoed only when set. Omitting a field that currently reads null resets
      // it to a default that is already null, while an explicit null risks a
      // server-side type rejection for no gain.
      for (const [key, value] of Object.entries({
        templateId: current.templateId,
        allowedCudaVersions: current.allowedCudaVersions,
        minCudaVersion: current.minCudaVersion,
        compliance: current.compliance,
        modelReferences: current.modelReferences,
      })) {
        if (value !== null && value !== undefined) input[key] = value;
      }

      interface SaveEndpointResponse {
        saveEndpoint: {
          id: string;
          name: string;
          gpuIds: string;
          gpuCount: number;
          workersMin: number;
          workersMax: number;
        };
      }

      const result = await graphqlAuthed<SaveEndpointResponse>(
        `
          mutation saveEndpoint($input: EndpointInput!) {
            saveEndpoint(input: $input) {
              id
              name
              gpuIds
              gpuCount
              workersMin
              workersMax
            }
          }
        `,
        { input }
      );

      return jsonReply({
        endpoint: result.saveEndpoint,
        previousGpuIds: current.gpuIds,
      });
    }
  );
}
