import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  defineCatalog,
  discoverFields,
  field,
  fieldTypes,
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
const catalog = defineCatalog([
  {
    name: "companies",
    description: "Companies exposed by your API",
    primaryKey: ["id"],
    columns: [
      field("id", "string", { unique: true }),
      field("name", "string"),
      field("created_at", "datetime"),
    ],
  },
]);

function tableOf(name: string) {
  const table = catalog.getTable(name);
  if (!table) throw unknownEntity(`unknown table "${name}"`);
  return table;
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
    const types = fieldTypes(tableOf(req.table).columns);
    assertKnownFields(req, Object.keys(types));
    // Apply residual filters with applyFilters(batch, req, types), using catalog-owned types.
    throw new Error("implement query");
  }

  // YOUR CODE HERE: how many rows match req.and/req.or (your count endpoint, or tally query()).
  async count(req: CountRequest): Promise<number> {
    assertKnownFields(req, Object.keys(fieldTypes(tableOf(req.table).columns)));
    throw new Error("implement count");
  }

  // For a dynamic API, fetch metadata for req.credentials before constructing this catalog.
  async discover(_req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    return {
      tables: catalog.tables.map((table) => ({
        name: table.name,
        sourceDescription: table.description,
        storesRows: true,
        primaryKey: table.primaryKey,
        foreignKeys: [],
        fields: discoverFields(table.columns),
      })),
    };
  }

  // profileColumns, profileLink, profileGrain, exactCount, and sampleColumnValues already answer
  // by scanning through query(); override one only where your api can do that math cheaper.
}
