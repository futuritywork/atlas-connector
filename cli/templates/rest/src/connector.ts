import {
  applyFilters,
  AtlasConnector,
  columnCountsFromValues,
  grainFromValues,
  linkFromValues,
  type CountRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type NativeQueryStreamRequest,
  type SampleKeyValuesRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";

export class MyConnector extends AtlasConnector {
  readonly slug = "my-atlas-connector";

  capability() {
    return ATLAS_JSON;
  }

  // YOUR CODE HERE: map your API's metadata to tables/fields. return { tables, warnings? }.
  async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    throw new Error("implement discovery");
  }

  // YOUR CODE HERE: fetch rows; push the filters your API can evaluate, applyFilters() the rest;
  // project req.fields (+ join aliases); honor sort/limit/offset. capability.ts may only advertise
  // ops one of those two paths actually honors.
  async query(req: NativeQueryRequest): Promise<SourceRow[]> {
    throw new Error("implement query");
  }

  // YOUR CODE HERE: yield batches (≤5000 rows each) as your pagination delivers them;
  // serve() owns heartbeats and the {end:1} terminator.
  async *queryStream(req: NativeQueryStreamRequest): AsyncIterable<SourceRow[]> {
    throw new Error("implement queryStream");
  }

  // YOUR CODE HERE: how many rows match req.and/req.or (your count endpoint, or tally queryStream).
  async count(req: CountRequest): Promise<number> {
    throw new Error("implement count");
  }

  // YOUR CODE HERE: sorted distinct head of a column, as text (numeric by magnitude, text by bytes).
  async sampleKeyValues(req: SampleKeyValuesRequest): Promise<string[]> {
    throw new Error("implement sampleKeyValues");
  }

  // the base class answers wire-legal null for countExact/probeColumns/probeLink/probeGrain and
  // declines aggregate with a 204 — override only what you implement. the kit does the probe math
  // over fetched values: probeColumns → columnCountsFromValues({ column: values, ... }),
  // probeLink → linkFromValues(fromValues, toValues), probeGrain → grainFromValues(values).
  // if you implement aggregate(), add "aggregate" to endpoints in capability.ts too.
}
