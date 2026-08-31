import { type Catalog, col, defineCatalog, type Table } from "@futurity/atlas-connector/sql";

const CRM_TABLES: Table[] = [
  {
    name: "owners",
    description: "Sales representatives who own deals and log activities.",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number"),
      col("email", "text", "string", { unique: true }),
      col("full_name", "text", "string"),
      col("team", "text", "string", { description: "AMER / EMEA / APAC" }),
      col("hired_on", "date", "date"),
      col("active", "boolean", "boolean"),
    ],
  },
  {
    name: "companies",
    description: "Accounts. erp_account_code is the cross-source join key.",
    primaryKey: ["id"],
    foreignKeys: [],
    columns: [
      col("id", "int", "number"),
      col("name", "text", "string"),
      col("domain", "text", "string", { nullable: true }),
      col("industry", "text", "string"),
      col("employee_count", "int", "number", { nullable: true }),
      col("annual_revenue", "decimal", "decimal", { nullable: true }),
      col("billing_country", "text", "string"),
      col("erp_account_code", "text", "string", {
        nullable: true,
        description: "External ERP account id; the cross-source join key.",
      }),
      col("created_at", "datetime", "datetime"),
    ],
  },
  {
    name: "contacts",
    description: "People at companies. company_id is a soft edge with orphans.",
    primaryKey: ["id"],
    foreignKeys: [
      { field: "company_id", targetTable: "companies", targetField: "id" },
    ],
    columns: [
      col("id", "int", "number"),
      col("company_id", "int", "number", {
        nullable: true,
        description: "No pg FK; ~1.5% orphan deliberately.",
      }),
      col("email", "text", "string", { nullable: true }),
      col("first_name", "text", "string"),
      col("last_name", "text", "string"),
      col("title", "text", "string", { nullable: true }),
      col("phone", "text", "string", { nullable: true }),
      col("lifecycle_stage", "text", "string", {
        description: "lead / mql / sql / customer / churned",
      }),
      col("created_at", "datetime", "datetime"),
    ],
  },
  {
    name: "deals",
    description: "Opportunities. company_id/owner_id are enforced pg FKs.",
    primaryKey: ["id"],
    foreignKeys: [
      { field: "company_id", targetTable: "companies", targetField: "id" },
      {
        field: "primary_contact_id",
        targetTable: "contacts",
        targetField: "id",
      },
      { field: "owner_id", targetTable: "owners", targetField: "id" },
    ],
    columns: [
      col("id", "int", "number"),
      col("company_id", "int", "number"),
      col("primary_contact_id", "int", "number", { nullable: true }),
      col("owner_id", "int", "number"),
      col("name", "text", "string"),
      col("stage", "text", "string"),
      col("amount", "decimal", "decimal", { nullable: true }),
      col("currency", "text", "string"),
      col("expected_close", "date", "date", { nullable: true }),
      col("closed_at", "datetime", "datetime", { nullable: true }),
      col("created_at", "datetime", "datetime"),
    ],
  },
  {
    name: "activities",
    description: "Touchpoints. deal_id fans out; tags is a real array column.",
    primaryKey: ["id"],
    foreignKeys: [
      { field: "deal_id", targetTable: "deals", targetField: "id" },
      { field: "contact_id", targetTable: "contacts", targetField: "id" },
      { field: "owner_id", targetTable: "owners", targetField: "id" },
    ],
    columns: [
      col("id", "int", "number"),
      col("deal_id", "int", "number", { nullable: true }),
      col("contact_id", "int", "number", { nullable: true }),
      col("owner_id", "int", "number"),
      col("kind", "text", "string", {
        description: "call / email / meeting / note / task",
      }),
      col("subject", "text", "string"),
      col("tags", "text_array", "array"),
      col("occurred_at", "datetime", "datetime"),
      col("duration_minutes", "int", "number", { nullable: true }),
    ],
  },
];

export const catalog: Catalog = defineCatalog(CRM_TABLES);
