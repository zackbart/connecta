import { describe, expect, it } from "vitest";
import hosted from "./fixtures/hosted-presets-abc0d176.json";
import before from "./fixtures/providers-before-5b.json";
import trustChanges from "./fixtures/providers-p2-item1-contract-changes.json";
import errorChanges from "./fixtures/providers-p2-item4-contract-changes.json";
import usageChanges from "./fixtures/providers-p2-item5-contract-changes.json";
import attachmentChanges from "./fixtures/providers-gmail-attachment-contract-changes.json";
import readOnlyChanges from "./fixtures/providers-readonly-820-contract-changes.json";
import charsetChanges from "./fixtures/providers-gmail-charset-811-contract-changes.json";
import guestChanges from "./fixtures/providers-p2-item2-contract-changes.json";
import poolOwnerChanges from "./fixtures/providers-pool-owner-837-contract-changes.json";
import docsCorrectnessChanges from "./fixtures/providers-docs-correctness-contract-changes.json";
import ownerlessChanges from "./fixtures/providers-agent-ownerless-workspace-contract-changes.json";
import { providerContract, type ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";

// Captured from 919c149 before moving modules, using the same fixtures and
// registry path. Each SHA-256 covers the complete serialized field, including
// every describe() schema, rather than a partial match or a selected subset.
// Phase 2 item 1 removes classifications from raw connector descriptions and
// revises Breeze/Cloudflare write routing guides. Keep those explicit changes
// separate so the original migration baseline still guards every other field.
// Item 5 replaces repeated guest guidance with usage-skill pointers.
// Item 4 updates the permission recovery guides through a separate overlay.
// Converted hosted providers have their subsequent baseline in hosted-presets.test.ts.
// Issue #809 adds Gmail attachment reads and immutable part identifiers.
// Issue #820 replaces pool trust wording in the Breeze and Gmail guides with readOnly.
// Issue #811 adds Gmail bodyNote to read schemas and documents separate decoding notices.
// Issue #837 says in each Workspace guide that an agent acts as its pool's owner.
// The docs correctness pass corrects Overflow, Planning Center, Sheets, and Slides guide claims.
// Agents no longer see a Workspace connector in an ownerless pool, so its guide stops saying they fail there.
// Providers added after the migration are covered by their own contract tests.
describe.each(
  providerFixtures.filter(
    (fixture) => Object.hasOwn(before, fixture.name) && !Object.hasOwn(hosted.providers, fixture.name),
  ) as unknown as ContractFixture[],
)("$name provider contract", (fixture) => {
  it("INV-1: preserves provider contracts with explicit classifier, trust and error-guide changes", async () => {
    const actual = await providerContract(fixture);
    const snapshot = await Promise.all(
      actual.map(async (row) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(JSON.parse(JSON.stringify(row)) as Record<string, unknown>).map(async ([key, value]) => {
              if (key === "label") return [key, value];
              const bytes = new TextEncoder().encode(JSON.stringify(value));
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
              return [key, [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")];
            }),
          ),
        ),
      ),
    );
    const changes = trustChanges as Record<string, Record<string, Record<string, string>>>;
    const repairs = errorChanges as Record<string, Record<string, Record<string, string>>>;
    const usage = usageChanges as Record<string, Record<string, Record<string, string>>>;
    const guest = guestChanges as Record<string, Record<string, Record<string, string>>>;
    const attachments = attachmentChanges as Record<string, Record<string, Record<string, string>>>;
    const readOnly = readOnlyChanges as Record<string, Record<string, Record<string, string>>>;
    const charsets = charsetChanges as Record<string, Record<string, Record<string, string>>>;
    const poolOwners = poolOwnerChanges as Record<string, Record<string, Record<string, string>>>;
    const docsCorrectness = docsCorrectnessChanges as Record<string, Record<string, Record<string, string>>>;
    const ownerless = ownerlessChanges as Record<string, Record<string, Record<string, string>>>;
    const expected = before[fixture.name as keyof typeof before].map((row) => ({
      ...row,
      ...changes[fixture.name]?.[row.label],
      ...repairs[fixture.name]?.[row.label],
      ...guest[fixture.name]?.[row.label],
      ...usage[fixture.name]?.[row.label],
      ...attachments[fixture.name]?.[row.label],
      ...readOnly[fixture.name]?.[row.label],
      ...charsets[fixture.name]?.[row.label],
      ...poolOwners[fixture.name]?.[row.label],
      ...docsCorrectness[fixture.name]?.[row.label],
      ...ownerless[fixture.name]?.[row.label],
    }));
    expect(snapshot).toEqual(expected);
  });
});

describe.each(providerFixtures as unknown as ContractFixture[])("$name provider construction", (fixture) => {
  it("INV-2 INV-11: accepts and retains connector readOnly in every provider mode", () => {
    for (const scenario of fixture.cases) {
      for (const readOnly of [true, false]) {
        expect(fixture.create("reader", { ...scenario.options, readOnly }).readOnly).toBe(readOnly);
      }
      expect(() => fixture.create("reader", { ...scenario.options, readOnly: "true" })).toThrow(/readOnly.*boolean/);
    }
  });

  it("INV-11: names the provider and id in construction refusals", () => {
    const factory = fixture.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(() => fixture.create("bad", { purpose: "" })).toThrow(`${factory}("bad") requires `);
  });
});
