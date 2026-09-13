import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESB_CORE_CATALOG } from "../src/catalog";
import { buildCatalog, renderCatalog } from "./build-catalog";

const source = await Bun.file(
  new URL("../catalog-data/api_data.json", import.meta.url),
).text();
const data = JSON.parse(source);
const catalogPath = new URL("../src/catalog.ts", import.meta.url);

function changedEndpoint(change: (entry: any) => void): unknown {
  const copy = structuredClone(data);
  const entry = copy.find(
    (item: any) =>
      item.type === "get" &&
      item.url === "{{base_url}}/purchase/advance-payment",
  );
  change(entry);
  return copy;
}

describe("ESB catalog generation", () => {
  test("preserves every existing object and column contract", () => {
    const generated = buildCatalog(data);
    expect(generated).toEqual(ESB_CORE_CATALOG);
    expect(
      new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(generated))
        .digest("hex"),
    ).toBe("4013f9f3e1ed703887b0ba9f846099f4601cdb331c63264ab627ccdbb1fe96f4");
    expect(generated).toHaveLength(39);
    expect(
      generated.reduce((count, object) => count + object.columns.length, 0),
    ).toBe(371);
  });

  test("regeneration is deterministic and the checked-in file is current", async () => {
    const generated = renderCatalog(source);
    expect(renderCatalog(source)).toBe(generated);
    expect(generated).toBe(await Bun.file(catalogPath).text());
  });

  test("fails closed when a selected endpoint or field disappears", () => {
    expect(() =>
      buildCatalog(
        data.filter(
          (entry: any) => entry.url !== "{{base_url}}/purchase/advance-payment",
        ),
      ),
    ).toThrow("advance_payments");
    expect(() =>
      buildCatalog(
        changedEndpoint((entry) => {
          entry.success.fields["Body Response"] = entry.success.fields[
            "Body Response"
          ].filter((field: any) => field.field !== "result.data.branchID");
        }),
      ),
    ).toThrow("branchID");
  });

  test("refuses duplicate endpoint contracts and unknown field types", () => {
    const endpoint = data.find(
      (entry: any) =>
        entry.type === "get" &&
        entry.url === "{{base_url}}/purchase/advance-payment",
    );
    expect(() => buildCatalog([...data, endpoint])).toThrow("advance_payments");
    expect(() =>
      buildCatalog(
        changedEndpoint((entry) => {
          entry.success.fields["Body Response"].find(
            (field: any) => field.field === "result.data.branchID",
          ).type = "MysteryScalar";
        }),
      ),
    ).toThrow("MysteryScalar");
  });

  test("requires review when an overridden source type changes", () => {
    expect(() =>
      buildCatalog(
        changedEndpoint((entry) => {
          entry.success.fields["Body Response"].find(
            (field: any) => field.field === "result.data.advancePaymentDate",
          ).type = "Date";
        }),
      ),
    ).toThrow("stale type override");
  });

  test("CLI checks fresh input without modifying the checked-in catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esb-catalog-"));
    const original = await Bun.file(catalogPath).text();
    try {
      const copy = structuredClone(data);
      copy[0].description += " Updated upstream documentation.";
      const input = join(directory, "api_data.json");
      await Bun.write(input, JSON.stringify(copy));
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./build-catalog.ts", import.meta.url).pathname,
          "--check",
          "--input",
          input,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("out of date");
      expect(await Bun.file(catalogPath).text()).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an upstream change makes regeneration differ even outside selected endpoints", () => {
    const copy = structuredClone(data);
    copy[0].description += " Updated upstream documentation.";
    expect(renderCatalog(JSON.stringify(copy))).not.toBe(renderCatalog(source));
  });
});
