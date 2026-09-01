import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  unknownEntity,
  type CheckRequest,
  type CountRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type NativeQueryRequest,
  type SourceRow,
} from "@futurity/atlas-connector";
import { ATLAS_JSON } from "./capability";

// YOUR CODE HERE: the fields your api exposes per table. discovery answers from the same
// place, so "a field Atlas may filter on" and "a field you declared" stay the same set.
const FIELDS: Record<string, string[]> = {
  companies: ["id", "name", "created_at"],
};

function fieldsOf(table: string): string[] {
  const fields = FIELDS[table];
  if (!fields) throw unknownEntity(`unknown table "${table}"`);
  return fields;
}

export class MyConnector extends AtlasConnector {
  readonly slug = "my-atlas-connector";

  capability() {
    return ATLAS_JSON;
  }

  // YOUR CODE HERE: the cheapest upstream call that proves req.credentials: a token mint,
  // a whoami, a 1-row read. throw with a message written for the tenant: they see it verbatim.
  async check(req: CheckRequest): Promise<void> {
    throw new Error("implement check");
  }

  // YOUR CODE HERE: fetch rows for req.credentials; push what your api can filter, applyFilters()
  // the rest; project req.fields; honor sort/limit/offset; yield batches of ≤5000 rows.
  async *query(req: NativeQueryRequest): AsyncIterable<SourceRow[]> {
    // a filter you cannot answer must 422 HERE: a row that skipped a filter reads as a row that matched it
    assertKnownFields(req, fieldsOf(req.table));
    throw new Error("implement query");
  }

  // YOUR CODE HERE: how many rows match req.and/req.or (your count endpoint, or tally query()).
  async count(req: CountRequest): Promise<number> {
    assertKnownFields(req, fieldsOf(req.table));
    throw new Error("implement count");
  }

  // YOUR CODE HERE: map your api's metadata to tables/fields. return { tables, warnings? }.
  async discover(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    throw new Error("implement discover");
  }

  // profileColumns, profileLink, profileGrain, exactCount, and sampleColumnValues already answer
  // by scanning through query(); override one only where your api can do that math cheaper.
}
