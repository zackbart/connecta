// Node-only: compares shipped declaration syntax with TypeScript's parser and filesystem.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { buildSandboxProviders } from "../src/execute.js";
import { guestInitializer } from "../src/guest-runtime.js";
import { GUEST_API_DECLARATION } from "../src/usage-guide.js";
import { makeRegistry, silentLogger } from "./helpers.js";

it("shipped guest declaration has no unresolved or invalid types", () => {
  const path = new URL("../src/guest-types.ts", import.meta.url).pathname;
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists)!;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
  const program = ts.createProgram([path], { ...options, skipLibCheck: false });
  const source = program.getSourceFile(path)!;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))).toEqual([]);
}, 60_000);

it("INV-3: advertised guest signatures match the shipped declaration and runtime method set", async () => {
  const source = readFileSync(new URL("../src/guest-types.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("guest.d.ts", source, ts.ScriptTarget.Latest, true);
  const api = file.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "GuestApi",
  )!;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  expect(normalize(GUEST_API_DECLARATION)).toBe(normalize(api.members.map((m) => m.getText(file)).join("\n")));
  const advertised = [...new Set(api.members.map((m) => (m.name as ts.Identifier).text))].sort();
  const [provider] = await buildSandboxProviders(makeRegistry([]), "https://usage.test", silentLogger);
  expect(Object.keys(provider!.fns).sort()).toEqual(advertised);
  const initializer = ts.createSourceFile(
    "initializer.js",
    guestInitializer(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let namespace: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(initializer) === "namespace" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      namespace = node.initializer.arguments[0] as ts.ObjectLiteralExpression;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  expect(namespace).toBeDefined();
  const members = namespace!.properties.filter((p) => p.name?.getText(initializer) !== "__proto__");
  // The only undeclared member is connecta.skills, the same host function as skill.
  expect(members.map((p) => p.name?.getText(initializer)).sort()).toEqual([...advertised, "skills"].sort());
  const alias = members.find((p) => p.name?.getText(initializer) === "skills");
  expect(alias && ts.isPropertyAssignment(alias) ? alias.initializer.getText(initializer) : undefined).toBe(
    "provider.skill",
  );
});
