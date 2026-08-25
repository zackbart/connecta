import { expect, it, vi } from "vitest";
import { silentLogger } from "../helpers.js";
import type { Connector, ConnectorContext, ToolDef } from "../../src/types.js";

export function mockRemoteMcp(mocks: {
  listTools: ReturnType<typeof vi.fn<() => Promise<ToolDef[]>>>;
  remoteMcp: ReturnType<typeof vi.fn>;
}): void {
  mocks.listTools.mockReset();
  mocks.remoteMcp.mockReset();
  mocks.remoteMcp.mockImplementation(
    (id: string, options: object): Connector => ({
      id,
      kind: "mcp",
      ...options,
      listTools: mocks.listTools,
      async callTool() {
        return [];
      },
    }),
  );
}

export const context: ConnectorContext = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: silentLogger,
  baseUrl: "https://connecta.example",
};

/** Every maintained hosted-provider guide is structured (P7). */
export function guideOf(connector: Connector): string {
  const guide = connector.usageGuide;
  if (typeof guide !== "object" || guide === undefined) {
    throw new Error("expected a structured usage guide");
  }
  return guide.content;
}

interface ClassificationNames {
  read: [silent: string, silentWithoutAnnotations: string, contradicted: string];
  write: string;
  destructive: string;
  unknown: [silent: string, explicitRead: string, explicitDestructive: string];
}

export function itClassifiesLikeARelease(
  factory: () => Connector,
  opts: { listTools: ReturnType<typeof vi.fn<() => Promise<ToolDef[]>>> },
  names: ClassificationNames,
): void {
  const { listTools } = opts;

  it("fills in silent annotations and fails closed on catalog drift", async () => {
    listTools.mockResolvedValue([
      { name: names.read[0], annotations: { openWorldHint: true } },
      { name: names.read[1] },
      { name: names.write },
      { name: names.unknown[0] },
    ]);
    const tools = await factory().listTools(context);
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tools[2]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("keeps a vetted destructive tool closed despite a read-only claim", async () => {
    listTools.mockResolvedValue([
      { name: names.destructive, annotations: { readOnlyHint: true } },
    ]);
    const tools = await factory().listTools(context);
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("believes an explicit annotation on a tool no release has classified", async () => {
    listTools.mockResolvedValue([
      { name: names.unknown[1], annotations: { readOnlyHint: true } },
      { name: names.unknown[2], annotations: { destructiveHint: true } },
    ]);
    const tools = await factory().listTools(context);
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("never overrules an explicit downstream annotation on a vetted read", async () => {
    listTools.mockResolvedValue([
      {
        name: names.read[0],
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      { name: names.read[2], annotations: { readOnlyHint: false } },
    ]);
    const tools = await factory().listTools(context);
    expect(tools[0]?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });
}
