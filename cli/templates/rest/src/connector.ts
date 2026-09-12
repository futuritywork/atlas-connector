import {
  applyFilters,
  assertKnownFields,
  AtlasConnector,
  defineCatalog,
  discoverFields,
  field,
  fieldTypes,
  pushedOps,
  unknownEntity,
  type CheckRequest,
  type DiscoveryAnswer,
  type DiscoveryRequest,
  type EntitySize,
  type NativeQueryRequest,
  type QueryChunk,
  type SizeRequest,
} from "@futurity/atlas-connector";
import { ATLAS_JSON, PUSHDOWN } from "./capability";

// YOUR CODE HERE: the fields your api exposes per table; discovery answers from this same catalog
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

  capabilities() {
    return ATLAS_JSON;
  }

  // YOUR CODE HERE: the cheapest call that proves req.credentials, a token mint or a whoami
  // the tenant reads your thrown message verbatim
  async check(req: CheckRequest): Promise<void> {
    throw new Error("implement check");
  }

  // YOUR CODE HERE: fetch rows for req.credentials, project req.fields, honor sort/limit/offset
  // push what PUSHDOWN promises and applyFilters the rest; yield batches of at most 5000 rows
  async *query(req: NativeQueryRequest): AsyncIterable<QueryChunk> {
    const types = fieldTypes(tableOf(req.table).columns);
    // 422 before the first fetch: a row that skipped a filter reads as one that matched
    assertKnownFields(req, Object.keys(types));
    // what the upstream applied, before the first batch; anything false is the host's to redo
    yield { served: { filters: false, sort: false, window: false } };
    // pushedOps(PUSHDOWN, req.table, filter.field) decides upstream param vs residual applyFilters
    throw new Error("implement query");
  }

  // YOUR CODE HERE: the table's total from your api's own metadata (totalResults, result.count)
  // exact: false for an estimate, null when there is none; Atlas then scans to its cap to size it
  override async size(req: SizeRequest): Promise<EntitySize | null> {
    tableOf(req.table); // 404 on a table you do not have, before answering null
    return null;
  }

  // YOUR CODE HERE: answer { tables, warnings? }; a dynamic api fetches its metadata per tenant first
  async discovery(req: DiscoveryRequest): Promise<DiscoveryAnswer> {
    return {
      tables: catalog.tables.map((table) => ({
        name: table.name,
        sourceDescription: table.description,
        storesRows: true, // false only for an endpoint that computes instead of storing rows
        primaryKey: table.primaryKey,
        foreignKeys: [], // [] says this table has no join edges, not that you have not looked
        fields: discoverFields(table.columns),
      })),
    };
  }

  // count, aggregate, cardinality and linkHitRate have no default: write one where your api does the math
  // the one you write becomes a served route and a listed endpoint; left out, Atlas measures it itself
}
