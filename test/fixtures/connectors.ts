import type { Connector, ToolDef } from "../../src/types.js";

type ConnectorFixture = Omit<Connector, "listTools" | "callTool"> & {
  tools?: ToolDef[] | Connector["listTools"];
  call?: Connector["callTool"];
};

export function connectorWith({
  tools = [],
  call = async () => ({}),
  ...connector
}: ConnectorFixture): Connector {
  return {
    ...connector,
    listTools:
      typeof tools === "function" ? tools : async () => tools,
    callTool: call,
  };
}
