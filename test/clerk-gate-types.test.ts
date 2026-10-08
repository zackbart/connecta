import { expectTypeOf, it } from "vitest";
import { createClerkClient } from "@clerk/backend";
import type { ClerkAuthOptions, ClerkGateClient, ClerkUser } from "../src/auth/clerk.js";
import type { ClerkSdkClient } from "../src/auth/clerk-sdk/client.js";
import { createByteReadingClerkClient } from "../src/auth/clerk-transport.js";

it("INV-13: declares the bundled gate client independently of consumer Clerk types", () => {
  // The exact generator dependency proves every declared operation and result
  // is a subset of the reviewed SDK, without publishing that SDK's types.
  expectTypeOf<ReturnType<typeof createClerkClient>>().toExtend<ClerkSdkClient>();
  expectTypeOf<ReturnType<typeof createByteReadingClerkClient>>().toEqualTypeOf<ClerkSdkClient>();
  expectTypeOf<NonNullable<ClerkAuthOptions["gate"]>>().parameters.toEqualTypeOf<[string, ClerkGateClient]>();
  expectTypeOf<ClerkGateClient["users"]["getUser"]>().returns.toEqualTypeOf<Promise<ClerkUser>>();
  expectTypeOf<ClerkUser["fullName"]>().toEqualTypeOf<string | null>();
  expectTypeOf<ClerkUser["emailAddresses"][number]["verification"]>().toEqualTypeOf<{ readonly status: string } | null>();
  // @ts-expect-error The gate contract does not claim the full Clerk API.
  expectTypeOf<ClerkGateClient["organizations"]>();
  // @ts-expect-error Gate code cannot depend on the internal auth operations.
  expectTypeOf<ClerkGateClient["authenticateRequest"]>();
});
