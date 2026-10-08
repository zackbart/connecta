// Node-only: parses production TypeScript to guard the single refresh send gate.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const source = (path: string) =>
  ts.createSourceFile(path, readFileSync(root + path, "utf8"), ts.ScriptTarget.Latest, true);
function nodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(...nodes(child));
  });
  return [node, ...children];
}
function files(directory: string): string[] {
  return readdirSync(root + directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + entry.name;
    return entry.isDirectory()
      ? files(path + "/")
      : path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("generated.ts")
        ? [path]
        : [];
  });
}
function method(node: ts.Node): string | undefined {
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent)) return parent.name.getText();
  }
  return undefined;
}

it("routes every production refresh send through the fingerprint resolution CAS gate without redirects (INV-5) (INV-9)", () => {
  const coordinator = source("auth/downstream-oauth.ts");
  const calls = nodes(coordinator).filter(ts.isCallExpression);
  const sends = calls.filter((call) => call.expression.getText() === "baseFetch");
  expect(sends.map(method)).toEqual(["coordinatedFetch", "redeem"]);
  const generic = nodes(coordinator).find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText() === "coordinatedFetch",
  )!;
  expect(generic.getText().indexOf("if (isRefreshTokenRequest(init))")).toBeLessThan(
    generic.getText().indexOf("baseFetch(input"),
  );
  expect(generic.getText()).toContain("return this.refresh(provider, input, init, baseFetch, signal, defer)");
  const refresh = sends[1]!;
  let gated = false;
  for (let parent: ts.Node | undefined = refresh.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && parent.expression.getText() === "provider.dispatchRefresh") gated = true;
  }
  expect(gated).toBe(true);
  for (const send of sends) {
    const init = send.arguments[1]!;
    expect(ts.isObjectLiteralExpression(init)).toBe(true);
    const redirect = nodes(init).find(
      (node) => ts.isPropertyAssignment(node) && node.name.getText() === "redirect",
    ) as ts.PropertyAssignment;
    expect(redirect?.initializer.getText()).toBe('"manual"');
  }
  expect(generic.getText()).toContain("const tokenRequest = isOAuthCredentialRequest(init)");
  expect(generic.getText()).toContain(": resourceFetch(input,");
  expect(calls.filter((call) => call.expression.getText().endsWith(".dispatchRefresh"))).toHaveLength(1);
  const gate = nodes(coordinator).find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText() === "dispatchRefresh",
  )!;
  const gateCalls = nodes(gate).filter(ts.isCallExpression);
  expect(gateCalls.filter((call) => call.expression.getText() === "send")).toHaveLength(1);
  const spent = gateCalls.find(
    (call) =>
      call.expression.getText() === "this.storage.compareAndSet" && call.arguments[0]?.getText() === "lease.spentKey",
  )!;
  expect(spent.arguments[1]!.getText()).toBe("lease.spentExpected");
  expect(spent.arguments).toHaveLength(3); // No TTL.
  expect(spent.arguments[2]!.getText()).toBe("lease.spentRaw");
  expect(gate.getText()).toContain('state: "outstanding"');
  expect(coordinator.getText()).toContain("consent.resolution !== spentExpected");
  expect(gate.getText()).toContain("if (!unspent)");
  expect(gate.getText().indexOf("if (!unspent)")).toBeLessThan(gate.getText().indexOf("const sent = send()"));
  expect(coordinator.getText()).toContain("oauthRefreshSpentKeys.spent(digest)");

  // OAuth forms come from the SDK. A new direct refresh form is a new send path.
  const production = files("").map((path) => ({ path, nodes: nodes(source(path)) }));
  const literal = (node: ts.Node | undefined, value: string) =>
    node !== undefined && ts.isStringLiteral(node) && node.text === value;
  const directForms = production.flatMap(({ path, nodes }) =>
    nodes
      .filter(
        (node) =>
          (ts.isPropertyAssignment(node) &&
            node.name.getText().replace(/["']/g, "") === "grant_type" &&
            literal(node.initializer, "refresh_token")) ||
          (ts.isCallExpression(node) &&
            literal(node.arguments[0], "grant_type") &&
            literal(node.arguments[1], "refresh_token")) ||
          (ts.isArrayLiteralExpression(node) &&
            literal(node.elements[0], "grant_type") &&
            literal(node.elements[1], "refresh_token")) ||
          (ts.isStringLiteral(node) && new URLSearchParams(node.text).get("grant_type") === "refresh_token"),
      )
      .map(() => path),
  );
  expect(directForms).toEqual([]);
  const sdkAuthCalls = production.flatMap(({ path, nodes }) =>
    nodes
      .filter((node) => ts.isCallExpression(node) && node.expression.getText() === "auth")
      .map((call) => ({ path, call: call as ts.CallExpression })),
  );
  expect(sdkAuthCalls.map(({ path }) => path)).toEqual(["auth/static-oauth.ts"]);
  expect(sdkAuthCalls[0]!.call.arguments[1]!.getText()).toContain("fetchFn: coordinatorFor(ctx).coordinatedFetch(");
  const remote = source("connectors/remote-mcp.ts");
  const adapters = nodes(remote)
    .filter(ts.isCallExpression)
    .filter((call) => call.expression.getText() === "refreshCoordinatorFor(ctx).coordinatedFetch");
  expect(adapters).toHaveLength(1);
  expect(adapters[0]!.arguments[1]!.getText()).toBe("learnedUrlSafeFetch(id, url, trackedFetch)");
  expect(adapters[0]!.arguments[4]!.getText()).toBe("learnedUrlSafeFetch(id, url, guardedFetch)");
  const learned = nodes(remote).find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "learnedUrlSafeFetch",
  )!;
  expect(learned.getText()).not.toContain("redirectSafeFetch");
  const tracked = nodes(remote).find(
    (node) => ts.isVariableDeclaration(node) && node.name.getText() === "trackedFetch",
  )!;
  expect(tracked.getText()).toContain("trackSentRequest(ctx, input, init)");
  expect(tracked.getText()).toContain("await fetch(input, init)");
  expect(tracked.getText()).not.toContain("redirectSafeFetch");
  // Bind the active listing/call context for sent-credential tracking while
  // keeping every token send beneath the refresh coordinator's CAS gate.
  expect(sdkAuthCalls[0]!.call.arguments[1]!.getText()).toContain(
    "provider,\n        (input, init) => tokenEndpointFetch(ctx, input, init),",
  );
  const staticOAuth = source("auth/static-oauth.ts");
  expect(staticOAuth.getText()).not.toContain("redirectSafeFetch");
  const tokenEndpoint = nodes(staticOAuth).find(
    (node) => ts.isVariableDeclaration(node) && node.name.getText() === "tokenEndpointFetch",
  )!;
  const tokenCalls = nodes(tokenEndpoint).filter(ts.isCallExpression);
  const staticSends = tokenCalls.filter((call) => call.expression.getText() === "sentSecretsFetch(ctx)");
  expect(staticSends).toHaveLength(2);
  expect(tokenCalls.filter((call) => call.expression.getText() === "fetch")).toHaveLength(0);
  for (const send of staticSends) expect(send.arguments[1]!.getText()).toContain('redirect: "manual"');
});
