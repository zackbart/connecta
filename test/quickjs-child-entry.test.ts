import { describe, expect, it, vi } from "vitest";

const { existsSyncMock, forkMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  forkMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import { quickJsExecutor } from "../src/executors/quickjs.js";

describe("QuickJS child entry diagnostics", () => {
  it("names the missing child path and the bundling constraint before forking", async () => {
    existsSyncMock.mockReturnValueOnce(false);
    const executor = quickJsExecutor();

    await expect(executor.execute("async () => 1", [])).rejects.toThrow(
      /QuickJS child entry is missing at .*quickjs-child\.ts.*externalize @zackbart\/connecta.*when bundling the server/s,
    );
    expect(forkMock).not.toHaveBeenCalled();
    await executor.close?.();
  });
});
