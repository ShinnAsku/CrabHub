import { describe, it, expect } from "vitest";
import { convertSql, dialectFamily, conversionHeader } from "@/lib/sql-convert";

describe("dialectFamily", () => {
  it("groups pg-family engines", () => {
    for (const db of ["postgresql", "gaussdb", "kingbase", "vastbase", "yashandb"]) {
      expect(dialectFamily(db)).toBe("pg");
    }
  });
  it("groups mysql-family engines", () => {
    for (const db of ["mysql", "oceanbase", "tidb", "tdsql"]) {
      expect(dialectFamily(db)).toBe("mysql");
    }
  });
});

describe("convertSql mysql → postgresql", () => {
  const mysqlDDL = [
    "CREATE TABLE `users` (",
    "    `id` INT AUTO_INCREMENT COMMENT '主键',",
    "    `age` TINYINT UNSIGNED,",
    "    `bio` LONGTEXT,",
    "    `created` DATETIME ON UPDATE CURRENT_TIMESTAMP,",
    "    PRIMARY KEY (`id`)",
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';",
  ].join("\n");

  it("converts identifiers, types and extracts comments", () => {
    const { sql, warnings } = convertSql(mysqlDDL, "mysql", "postgresql");
    expect(sql).toContain('"users"');
    expect(sql).not.toContain("`");
    expect(sql).toContain("SERIAL");
    expect(sql).toContain("SMALLINT"); // TINYINT mapped
    expect(sql).toContain("TEXT"); // LONGTEXT mapped
    expect(sql).not.toMatch(/ENGINE=/i);
    expect(sql).toContain(`COMMENT ON TABLE "users" IS '用户表';`);
    expect(sql).toContain(`COMMENT ON COLUMN "users"."id" IS '主键';`);
    // UNSIGNED + ON UPDATE removed with warnings
    expect(sql).not.toMatch(/UNSIGNED/i);
    expect(sql).not.toMatch(/ON UPDATE CURRENT_TIMESTAMP/i);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("convertSql postgresql → mysql", () => {
  const pgDDL = [
    'CREATE TABLE "public"."orders" (',
    '    "id" bigserial NOT NULL,',
    '    "note" text,',
    "    PRIMARY KEY (\"id\")",
    ");",
    "COMMENT ON TABLE \"public\".\"orders\" IS '订单表';",
    "COMMENT ON COLUMN \"public\".\"orders\".\"note\" IS '备注';",
  ].join("\n");

  it("converts quoting, serial types and table comment", () => {
    const { sql, warnings } = convertSql(pgDDL, "postgresql", "mysql");
    expect(sql).toContain("`orders`");
    expect(sql).toMatch(/BIGINT AUTO_INCREMENT/i);
    expect(sql).toMatch(/ALTER TABLE .* COMMENT = '订单表';/);
    // column comment cannot be auto-translated
    expect(sql).not.toMatch(/COMMENT ON COLUMN/i);
    expect(warnings.some((w) => w.includes("列注释"))).toBe(true);
  });
});

describe("convertSql within pg family", () => {
  it("passes through pg → gaussdb with identity warning", () => {
    const sql = "CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY);";
    const r = convertSql(sql, "postgresql", "gaussdb");
    expect(r.sql).toBe(sql);
    expect(r.warnings.some((w) => w.includes("IDENTITY"))).toBe(true);
  });

  it("strips DISTRIBUTE BY when gaussdb → postgresql", () => {
    const r = convertSql("CREATE TABLE t (id int) DISTRIBUTE BY HASH(id);", "gaussdb", "postgresql");
    expect(r.sql).not.toMatch(/DISTRIBUTE BY/i);
    expect(r.warnings.length).toBe(1);
  });
});

describe("edge cases", () => {
  it("identical source and target is a no-op", () => {
    const r = convertSql("SELECT 1", "postgresql", "postgresql");
    expect(r.sql).toBe("SELECT 1");
    expect(r.warnings).toEqual([]);
  });

  it("unsupported pair returns original with warning", () => {
    const r = convertSql("SELECT 1", "sqlite", "oracle");
    expect(r.sql).toBe("SELECT 1");
    expect(r.warnings.length).toBe(1);
  });

  it("conversionHeader includes warnings", () => {
    const h = conversionHeader("mysql", "postgresql", ["something"]);
    expect(h).toContain("mysql → postgresql");
    expect(h).toContain("⚠ something");
  });
});
