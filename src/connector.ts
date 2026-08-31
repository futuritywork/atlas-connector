// the server dual of Atlas's SourceClient: ten protocol methods over parsed wire requests.
// serve() owns auth, body parse, timeouts, ndjson framing, and the error envelope; methods
// receive the parsed request (timeoutMs included, for forwarding upstream) and return plain data.

import type { AtlasJson } from "./wire/atlas-json";
import type {
  AggregateRequest,
  CountExactRequest,
  CountRequest,
  DiscoveryAnswer,
  DiscoveryRequest,
  GrainProbe,
  LinkProbe,
  NativeQueryRequest,
  NativeQueryStreamRequest,
  ProbeColumnsRequest,
  ProbeGrainRequest,
  ProbeLinkRequest,
  SampleKeyValuesRequest,
  TableColumnsProbe,
} from "./wire/schemas";
import type { SourceRow } from "./wire/vocabulary";

export abstract class AtlasConnector {
  abstract readonly slug: string; // ^[a-z][a-z0-9-]{2,39}$
  abstract capability(): AtlasJson; // the served /.well-known doc

  // mandatory five — no base impl
  abstract discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer>;
  abstract query(req: NativeQueryRequest): Promise<SourceRow[]>;
  abstract queryStream(req: NativeQueryStreamRequest): AsyncIterable<SourceRow[]>;
  abstract count(req: CountRequest): Promise<number>;
  abstract sampleKeyValues(req: SampleKeyValuesRequest): Promise<string[]>;

  // optional five — base impls answer wire-legal null / decline; override only what you implement

  // null = the source only approximates row counts
  async countExact(_req: CountExactRequest): Promise<number | null> {
    return null;
  }

  async probeColumns(_req: ProbeColumnsRequest): Promise<TableColumnsProbe | null> {
    return null;
  }

  async probeLink(_req: ProbeLinkRequest): Promise<LinkProbe | null> {
    return null;
  }

  async probeGrain(_req: ProbeGrainRequest): Promise<GrainProbe | null> {
    return null;
  }

  // undefined → 204: decline this aggregate to the caller; a wrong number is never legal
  async aggregate(_req: AggregateRequest): Promise<SourceRow[] | undefined> {
    return undefined;
  }
}
