import { describe, it, expect } from "vitest";
import { mapRawQueryResult } from "@/lib/tauri-commands";

const COLS = [
  { name: "id", dataType: "int4", nullable: false, isPrimaryKey: true },
  { name: "name", dataType: "text", nullable: true, isPrimaryKey: false },
];

describe("mapRawQueryResult", () => {
  it("maps wire-format array rows to name-keyed objects by column order", () => {
    const r = mapRawQueryResult({
      columns: COLS,
      rows: [
        [1, "alice"],
        [2, "bob"],
      ],
      rowCount: 2,
      executionTimeMs: 12,
    });
    expect(r.rows).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    expect(r.rowCount).toBe(2);
    expect(r.duration).toBe(12);
    expect(r.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("maps legacy object rows unchanged", () => {
    const r = mapRawQueryResult({
      columns: COLS,
      rows: [{ id: 1, name: "alice" }],
      rowCount: 1,
      executionTimeMs: 5,
    });
    expect(r.rows).toEqual([{ id: 1, name: "alice" }]);
  });

  it("preserves SQL NULL as null (never empty string)", () => {
    const r = mapRawQueryResult({
      columns: COLS,
      rows: [[1, null]],
      rowCount: 1,
      executionTimeMs: 0,
    });
    expect(r.rows[0].name).toBeNull();
    expect(r.rows[0].name).not.toBe("");
  });

  it("ignores extra cells when a row is longer than the column list", () => {
    const r = mapRawQueryResult({
      columns: COLS,
      rows: [[1, "alice", "overflow"]],
      rowCount: 1,
      executionTimeMs: 0,
    });
    expect(r.rows[0]).toEqual({ id: 1, name: "alice" });
  });

  it("leaves missing cells undefined when a row is shorter than the column list", () => {
    const r = mapRawQueryResult({
      columns: COLS,
      rows: [[1]],
      rowCount: 1,
      executionTimeMs: 0,
    });
    expect(r.rows[0].id).toBe(1);
    expect(r.rows[0].name).toBeUndefined();
  });

  it("handles empty result sets and missing fields with safe defaults", () => {
    const r = mapRawQueryResult({});
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
    expect(r.duration).toBe(0);
  });

  it("keeps column metadata for empty result sets", () => {
    const r = mapRawQueryResult({ columns: COLS, rows: [], rowCount: 0, executionTimeMs: 3 });
    expect(r.columns.length).toBe(2);
    expect(r.rows).toEqual([]);
  });

  it("passes through complex JSON cell values (objects and arrays)", () => {
    const cols = [{ name: "payload", dataType: "jsonb" }];
    const r = mapRawQueryResult({
      columns: cols,
      rows: [[{ a: [1, 2], b: { c: true } }]],
      rowCount: 1,
      executionTimeMs: 0,
    });
    expect(r.rows[0].payload).toEqual({ a: [1, 2], b: { c: true } });
  });
});
