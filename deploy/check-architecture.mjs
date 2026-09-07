import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "src");
const coreRoot = path.join(root, "src-tauri/crates/crabhub-core");
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
  const filename = path.join(directory, item.name);
  return item.isDirectory() ? files(filename) : [filename];
});

const metadata = spawnSync("cargo", ["metadata", "--manifest-path", path.join(root, "src-tauri/Cargo.toml"), "--no-deps", "--format-version", "1", "--offline"], { encoding: "utf8" });
assert.equal(metadata.status, 0, metadata.stderr);
const packages = JSON.parse(metadata.stdout).packages;
const core = packages.find(item => item.name === "crabhub-core");
assert.ok(core, "The independent core crate is required");
assert.ok(core.dependencies.every(dependency => !dependency.name.startsWith("tauri")), "Core must not depend on Tauri");
for (const file of files(path.join(coreRoot, "src")).filter(file => file.endsWith(".rs"))) {
  assert.ok(!/\btauri::|#\[tauri/.test(fs.readFileSync(file, "utf8")), `Desktop API in core: ${file}`);
}
const config = ts.readConfigFile(path.join(root, "tsconfig.app.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const frontend = files(sourceRoot).filter(file => /\.tsx?$/.test(file));
for (const file of frontend) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = node => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && (specifier.text.startsWith(".") || specifier.text.startsWith("@/"))) {
      if (/\.(css|svg|png|jpg|woff2?)(\?.*)?$/.test(specifier.text)) {
        const resource = specifier.text.split("?")[0];
        const filename = resource.startsWith("@/") ? path.join(sourceRoot, resource.slice(2)) : path.resolve(path.dirname(file), resource);
        assert.ok(fs.existsSync(filename), `Missing resource ${specifier.text} in ${file}`);
        return;
      }
      const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
      assert.ok(resolved, `Unresolved module ${specifier.text} in ${file}`);
      if (file.includes(`${path.sep}features${path.sep}`)) {
        const relative = path.relative(sourceRoot, path.resolve(resolved.resolvedFileName));
        assert.notEqual(relative.split(path.sep)[0], "app", `Feature depends on application coordinator: ${file}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
for (const previous of ["Sidebar", "EditorPanel", "ConnectionDialog", "TableDesigner", "AIPanel", "DockerManager"]) {
  assert.ok(!fs.existsSync(path.join(sourceRoot, "components", `${previous}.tsx`)), `${previous} belongs in its feature module`);
}
assert.ok(!fs.readFileSync(path.join(sourceRoot, "stores/modules/ui.ts"), "utf8").includes("schemaData"), "Explorer data must not return to UI preferences");
console.log(`Architecture boundaries verified: core crate and ${frontend.length} frontend modules`);