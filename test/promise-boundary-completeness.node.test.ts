// Node-only: reads production TypeScript contracts to check the lifetime matrix.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { ENTRIES } from "./helpers/promise-boundary/entries.js";

/** Discover Promise methods, including nested capabilities, without executing I/O. */
function promiseMethods(members: ts.NodeArray<ts.TypeElement>, prefix: string): string[] {
  return members.flatMap((member) => {
    if (!member.name || !ts.isIdentifier(member.name)) return [];
    // The production field predates the matrix's shorter capability name.
    const name = `${prefix}.${member.name.text === "downstreamSkills" ? "skills" : member.name.text}`;
    const type = ts.isPropertySignature(member) ? member.type : undefined;
    if (type && ts.isTypeLiteralNode(type)) return promiseMethods(type.members, name);
    const result = ts.isMethodSignature(member)
      ? member.type
      : type && ts.isFunctionTypeNode(type)
        ? type.type
        : undefined;
    return (result && ts.isTypeReferenceNode(result) && result.typeName.getText() === "Promise") ||
      (type && ts.isTypeQueryNode(type) && type.exprName.getText() === "fetch")
      ? [name]
      : [];
  });
}

it("INV-7: covers production connector and capability Promise methods in the entry-point lifetime matrix", () => {
  const contracts = [
    ["../src/types.ts", "Connector", "Connector"],
    ["../src/types.ts", "ConnectorCredentialAccess", "ctx.credential"],
    ["../src/connectors/api-connector.ts", "ApiHandlerContext", "ctx"],
    ["../src/connectors/api-connector.ts", "ApiOAuthAccess", "ctx.oauth"],
    ["../src/auth/renewable-grant.ts", "RenewableGrant", "Grant"],
  ] as const;
  const expected = contracts.flatMap(([path, contract, prefix]) => {
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL(path, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === contract,
    );
    expect(declaration, `${path}: missing ${contract} contract`).toBeDefined();
    return promiseMethods(declaration!.members, prefix);
  });
  // Teardown is the revocation machinery: it must run after the owner closes,
  // rather than obey the caller-entry rule this matrix exercises. Its bounded
  // joins and idempotence have separate cleanup coverage.
  expect(expected).toContain("Connector.closeScope");
  const entries = new Set(ENTRIES.map(({ name }) => name.replace(/^(?:api|remote)\./, "Connector.")));
  expect(expected.filter((name) => name !== "Connector.closeScope" && !entries.has(name))).toEqual([]);
});
