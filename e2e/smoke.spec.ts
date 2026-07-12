import { test, expect, type Page } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const PASSWORD = "e2e-password-123";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /登录|login/i }).click();
  // Sidebar header's new-connection button is always present after auth
  await expect(page.getByTestId("new-connection")).toBeVisible({ timeout: 15_000 });
}

test("login page rejects a wrong password", async ({ page }) => {
  await page.goto("/");
  const pw = page.locator('input[type="password"]');
  await expect(pw).toBeVisible();

  await pw.fill("definitely-wrong");
  await page.getByRole("button", { name: /登录|login/i }).click();

  // Error is surfaced and we are still on the login form
  await expect(page.locator("form")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByTestId("new-connection")).toHaveCount(0);
});

test("login → create SQLite connection → run SQL → results", async ({ page }) => {
  await login(page);

  // --- Create a connection ---
  await page.getByTestId("new-connection").click();
  await page.getByTestId("conn-name").fill("e2e-sqlite");
  await page.getByTestId("conn-type").selectOption("sqlite");
  const dbFile = path.join(os.tmpdir(), `crabhub-e2e-${Date.now()}.db`);
  await page.getByTestId("conn-filepath").fill(dbFile);
  await page.getByTestId("conn-save").click();

  // Connection appears in the sidebar tree (auto-connected on save)
  await expect(page.getByText("e2e-sqlite").first()).toBeVisible({ timeout: 15_000 });

  // Activate the connection, then open a query tab via the sidebar button
  await page.getByText("e2e-sqlite").first().click();
  await page.getByRole("button", { name: /新建查询/ }).first().click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });

  // --- Type SQL and execute ---
  await editor.click();
  await page.keyboard.type("SELECT 42 AS answer, 'crab' AS who");
  await page.getByTestId("run-sql").click();

  const results = page.getByTestId("result-table");
  await expect(results).toBeVisible({ timeout: 15_000 });
  await expect(results.getByText("42").first()).toBeVisible();
  await expect(results.getByText("crab").first()).toBeVisible();
});

test("DDL + DML through the editor shows table data", async ({ page }) => {
  await login(page);

  await page.getByTestId("new-connection").click();
  await page.getByTestId("conn-name").fill("e2e-ddl");
  await page.getByTestId("conn-type").selectOption("sqlite");
  await page
    .getByTestId("conn-filepath")
    .fill(path.join(os.tmpdir(), `crabhub-e2e-ddl-${Date.now()}.db`));
  await page.getByTestId("conn-save").click();
  await expect(page.getByText("e2e-ddl").first()).toBeVisible({ timeout: 15_000 });

  await page.getByText("e2e-ddl").first().click();
  await page.getByRole("button", { name: /新建查询/ }).first().click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type(
    "CREATE TABLE fruits (id INTEGER PRIMARY KEY, name TEXT);\n" +
      "INSERT INTO fruits VALUES (1, '苹果'), (2, 'banana');\n" +
      "SELECT * FROM fruits ORDER BY id;"
  );
  await page.getByTestId("run-sql").click();

  const results = page.getByTestId("result-table");
  await expect(results).toBeVisible({ timeout: 15_000 });
  await expect(results.getByText("苹果").first()).toBeVisible();
  await expect(results.getByText("banana").first()).toBeVisible();
});
