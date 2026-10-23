import { describe, expect, it, vi } from "vitest";
import {
  defineProvider,
  keys,
  optionsOf,
  PROVIDER_COMMON,
  type ProviderContext,
  type ProviderOptions,
} from "../src/index.js";
import { CALL_ADMISSION } from "../src/provider.js";
import type { Connector } from "../src/types.js";

const SKILL = {
  content: "\n- Resolve ids before writing.\n- Page with cursors.\n",
  instructionsHeading: "Account instructions",
};

function stub(id: string, extra: Partial<Connector> = {}): Connector {
  return {
    id,
    async listTools() {
      return [];
    },
    async callTool() {
      return [];
    },
    ...extra,
  };
}

const createStub = () => vi.fn((id: string, _options: object, _provider: ProviderContext) => stub(id));

describe("shared call admission schema", () => {
  it.each([null, 0])("INV-11: rejects the nested budget %j when parsing a policy", (budget) => {
    expect(() => CALL_ADMISSION.parse({ rules: [{ budget }] }, "callAdmission")).toThrow(
      "callAdmission.rules[0].budget must be an object.",
    );
  });
});

function sample(create = createStub()) {
  return {
    create,
    factory: defineProvider<ProviderOptions & { region?: "us" | "eu" }>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "api",
      skill: SKILL,
      options: optionsOf<ProviderOptions & { region?: "us" | "eu" }>()({ ...PROVIDER_COMMON, ...keys("region") }),
      create,
    }),
  };
}

describe("defineProvider()", () => {
  it("INV-11: checks the declared shape before reading options and preserves behaviour objects", () => {
    const { factory, create } = sample();
    const purpose = vi.fn(() => "Sales");
    expect(() =>
      factory("crm", {
        get purpose() {
          return purpose();
        },
        regoin: "eu",
      } as never),
    ).toThrow('Unknown option: acmeCrm("crm").regoin.');
    expect(purpose).not.toHaveBeenCalled();
    expect(() =>
      factory("crm", {
        get purpose() {
          return purpose();
        },
      }),
    ).toThrow('acmeCrm("crm") requires purpose to be a plain value');
    expect(purpose).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    class Handler {
      #value = "receiver";
      read() {
        return this.#value;
      }
    }
    type Options = ProviderOptions & { handler: Handler; data: { region: string } };
    const handler = new Handler();
    const data = { region: "eu" };
    let received: Readonly<Options> | undefined;
    const custom = defineProvider<Options>({
      name: "acme",
      title: "Acme",
      kind: "api",
      skill: SKILL,
      options: optionsOf<Options>()({
        ...PROVIDER_COMMON,
        ...keys("handler"),
        data: optionsOf<Options["data"]>()(keys("region")),
      }),
      create(id, options) {
        received = options;
        return stub(id);
      },
    });
    custom("crm", { purpose: "Sales", handler, data });
    expect(received?.handler).toBe(handler);
    expect(received?.handler.read()).toBe("receiver");
    expect(received?.data).toEqual(data);
    expect(received?.data).not.toBe(data);
    data.region = "us";
    expect(received?.data.region).toBe("eu");
  });

  it("renders a standard guide's selected when-blocks per connection, closing the gaps unselected ones leave", () => {
    type Options = ProviderOptions & { via?: "hosted" | "api" };
    const guides: string[] = [];
    const factory = defineProvider<Options>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "api",
      skill: {
        content: [
          "## Identity",
          "",
          "Resolve ids before writing.",
          "",
          "<!-- when: hosted -->",
          "Select the workspace first.",
          "<!-- end -->",
          "",
          "## Conventions",
          "",
          "<!-- when: api -->",
          "- **Results:** `fields` narrows a result.",
          "<!-- end -->",
          "- **Writes:** a write is sent once.",
          "<!-- when: hosted -->",
          "- **Hosted tools:** the catalog varies by plan.",
          "<!-- end -->",
        ].join("\n"),
        instructionsHeading: "Account instructions",
      },
      blocks: { keys: ["api", "hosted"], select: (options) => [options.via ?? "hosted"] },
      options: optionsOf<Options>()({ ...PROVIDER_COMMON, ...keys("via") }),
      create(id, _options, provider) {
        guides.push(provider.usageGuide({ context: ["Context."] }).content);
        return stub(id);
      },
    });
    factory("crm", { purpose: "Sales" });
    factory("crm", { purpose: "Sales", via: "api" });
    expect(guides).toEqual([
      "# Acme CRM usage\n\nContext.\n\n## Identity\n\nResolve ids before writing.\n\nSelect the workspace first.\n\n" +
        "## Conventions\n\n- **Writes:** a write is sent once.\n- **Hosted tools:** the catalog varies by plan.\n",
      "# Acme CRM usage\n\nContext.\n\n## Identity\n\nResolve ids before writing.\n\n" +
        "## Conventions\n\n- **Results:** `fields` narrows a result.\n- **Writes:** a write is sent once.\n",
    ]);
    expect(Object.isFrozen(factory.definition.blocks)).toBe(true);
    expect(Object.isFrozen(factory.definition.blocks!.keys)).toBe(true);
  });

  it("INV-11: refuses a guide's malformed or undeclared when-blocks at load, and an undeclared selection at construction", () => {
    const base = {
      name: "acme",
      title: "Acme",
      kind: "api" as const,
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      create: stub,
    };
    const guide = (content: string) => ({ content, instructionsHeading: "Notes" });
    const select = () => ["api"];
    const cases: Array<[object, string]> = [
      [{ skill: guide("<!-- when: api -->\nText.\n<!-- end -->") }, 'uses the when-block "api" its blocks omit'],
      [{ skill: guide("<!-- when: api -->\nText."), blocks: { keys: ["api"], select } }, "is never closed"],
      [
        { skill: guide("<!-- when: api -->\n<!-- when: api -->\n<!-- end -->"), blocks: { keys: ["api"], select } },
        "open and close in turn, unnested",
      ],
      [
        { skill: guide("Text <!-- when: api -->x<!-- end -->"), blocks: { keys: ["api"], select } },
        "alone on its line",
      ],
      [{ blocks: { keys: ["api", "api"], select } }, "blocks require unique lowercase keys"],
      [{ blocks: { keys: ["api"] } }, "blocks require unique lowercase keys and a select function"],
    ];
    for (const [patch, message] of cases) {
      expect(() => defineProvider({ ...base, ...patch } as never)).toThrow(message);
    }
    const factory = defineProvider<ProviderOptions>({
      ...base,
      skill: guide("<!-- when: api -->\nText.\n<!-- end -->"),
      blocks: { keys: ["api"], select: () => ["hosted"] },
      create(id, _options, provider) {
        provider.usageGuide({ context: [] });
        return stub(id);
      },
    });
    expect(() => factory("crm", { purpose: "Sales" })).toThrow(
      'acme("crm") requires blocks.select() to return declared keys; it returned hosted.',
    );
  });

  it("INV-11: rejects invalid common options before create runs", () => {
    const { factory, create } = sample();
    const bad: Array<[unknown, string]> = [
      [undefined, 'acmeCrm("crm") requires an options object.'],
      [{ purpose: "   " }, 'acmeCrm("crm") requires a non-empty purpose'],
      [{ purpose: 7 }, 'acmeCrm("crm") requires a non-empty purpose'],
      [{ purpose: "Sales", title: " " }, "title to be a non-empty string"],
      [{ purpose: "Sales", instructions: 3 }, "instructions to be a string"],
      [{ purpose: "Sales", authScope: "team" }, 'authScope to be "shared" or "personal"'],
    ];
    for (const [options, message] of bad) {
      expect(() => factory("crm", options as never)).toThrow(message);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a create that returns a connector under another id", () => {
    const { factory } = sample(vi.fn(() => stub("other")));
    expect(() => factory("crm", { purpose: "Sales" })).toThrow('create() must return a connector with id "crm"');
  });
});
