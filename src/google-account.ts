/**
 * One Google account, every Google product: the connectors `googleAccount()`
 * returns share one OAuth grant, so a person connects the account once (#1416).
 */
import { sharedOAuthGrant } from "./auth/static-oauth.js";
import { assertKnownOptions, keys, optionsOf } from "./config-schema.js";
import { CALL_ADMISSION, MEMBERS } from "./connectors/option-shapes.js";
import { apiUsingGrant, constructOnGrant } from "./http/provider.js";
import { googleOAuth } from "./providers/_shared/google/kit.js";
import type {
  GoogleOAuthClient,
  GoogleServiceAccount,
  GoogleWorkspaceOptions,
} from "./providers/_shared/google/workspace.js";
import type { Connector } from "./types.js";
import { calendar, CALENDAR_API_BASE_URL, CALENDAR_SCOPES } from "./providers/calendar/index.js";
import { docs, DOCS_API_BASE_URL, DOCS_SCOPES } from "./providers/docs/index.js";
import { drive, DRIVE_API_BASE_URL, DRIVE_SCOPES } from "./providers/drive/index.js";
import { forms, FORMS_API_BASE_URL, FORMS_SCOPES } from "./providers/forms/index.js";
import { gmail, GMAIL_API_BASE_URL, GMAIL_SCOPES } from "./providers/gmail/index.js";
import { meet, MEET_API_BASE_URL, MEET_SCOPES } from "./providers/meet/index.js";
import { people, PEOPLE_API_BASE_URL, PEOPLE_SCOPES } from "./providers/people/index.js";
import { sheets, SHEETS_API_BASE_URL, SHEETS_SCOPES } from "./providers/sheets/index.js";
import { slides, SLIDES_API_BASE_URL, SLIDES_SCOPES } from "./providers/slides/index.js";

export type {
  GoogleOAuthClient,
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceSubject,
} from "./providers/_shared/google/workspace.js";

const PRODUCTS = {
  gmail: { factory: gmail, title: "Gmail", scopes: GMAIL_SCOPES, baseUrl: GMAIL_API_BASE_URL },
  drive: { factory: drive, title: "Google Drive", scopes: DRIVE_SCOPES, baseUrl: DRIVE_API_BASE_URL },
  docs: { factory: docs, title: "Google Docs", scopes: DOCS_SCOPES, baseUrl: DOCS_API_BASE_URL },
  sheets: { factory: sheets, title: "Google Sheets", scopes: SHEETS_SCOPES, baseUrl: SHEETS_API_BASE_URL },
  slides: { factory: slides, title: "Google Slides", scopes: SLIDES_SCOPES, baseUrl: SLIDES_API_BASE_URL },
  forms: { factory: forms, title: "Google Forms", scopes: FORMS_SCOPES, baseUrl: FORMS_API_BASE_URL },
  meet: { factory: meet, title: "Google Meet", scopes: MEET_SCOPES, baseUrl: MEET_API_BASE_URL },
  people: { factory: people, title: "Google People", scopes: PEOPLE_SCOPES, baseUrl: PEOPLE_API_BASE_URL },
  calendar: { factory: calendar, title: "Google Calendar", scopes: CALENDAR_SCOPES, baseUrl: CALENDAR_API_BASE_URL },
} as const;

/** A Google product `googleAccount()` can include. */
export type GoogleProductName = keyof typeof PRODUCTS;

/** Every product, in the order `googleAccount()` returns them. */
export const GOOGLE_PRODUCTS = Object.freeze(Object.keys(PRODUCTS) as GoogleProductName[]);

/**
 * The options every Google product takes, without a per-product `baseUrl`,
 * plus `products`: the products to include, every one when omitted.
 */
export type GoogleAccountOptions = DistributiveOmit<GoogleWorkspaceOptions, "baseUrl"> & {
  products?: readonly GoogleProductName[];
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const OPTIONS = optionsOf<GoogleAccountOptions>()({
  ...keys(
    "purpose",
    "subject",
    "title",
    "instructions",
    "maxResultBytes",
    "readOnly",
    "authScope",
    "accounts",
    "products",
  ),
  serviceAccount: optionsOf<GoogleServiceAccount>()(keys("clientEmail", "privateKey", "clientId")),
  members: MEMBERS,
  oauth: optionsOf<GoogleOAuthClient>()(keys("clientId", "clientSecret")),
  callAdmission: CALL_ADMISSION,
});

/**
 * The connectors for one Google account: one per product, `<id>_<product>`
 * (`work_gmail`, `work_drive`, …), each with that product's tools and guide.
 *
 * In OAuth mode (`{ oauth, authScope }`) the first connector is `<id>` itself,
 * the account. It has no tools and owns the one grant every product uses:
 * consent asks once for all the products' scopes, its callback is
 * `<publicUrl>/oauth/callback/<id>`, and every Connect link for a product
 * connects the account. In delegation mode (`{ serviceAccount, subject }`)
 * there is no grant to share, and only the product connectors are returned.
 *
 * Pass them all to `createConnecta`: `connectors: [...googleAccount("work", { … })]`.
 */
export function googleAccount(id: string, options: GoogleAccountOptions): Connector[] {
  const at = `googleAccount(${JSON.stringify(id)})`;
  options = assertKnownOptions(options, at, OPTIONS);
  const { products: selected, ...common } = options;
  const names = selectedProducts(at, selected);
  const productOptions = (): GoogleWorkspaceOptions => ({ ...common }) as GoogleWorkspaceOptions;
  if (common.oauth === undefined && common.authScope === undefined) {
    return names.map((name) => PRODUCTS[name].factory(`${id}_${name}`, productOptions() as never));
  }
  const accountOptions = productOptions();
  const scopes = [...new Set(names.flatMap((name) => PRODUCTS[name].scopes))];
  const oauth = googleOAuth(
    { provider: "Google", api: "Google", scopes, notFound: "absent" },
    "googleAccount",
    accountOptions,
    names.map((name) => PRODUCTS[name].baseUrl),
  );
  if (!oauth) throw new Error(`${at} requires one access mode: { oauth, authScope } or { serviceAccount, subject }.`);
  const grant = sharedOAuthGrant(id);
  const titles = names.map((name) => PRODUCTS[name].title);
  const account = apiUsingGrant(
    id,
    {
      title: common.title?.trim() || "Google",
      description: `The Google account ${titles.join(", ")} use; connect it once for all of them — ${common.purpose.trim()}`,
      authScope: accountOptions.authScope!,
      ...(common.members !== undefined ? { members: common.members } : {}),
      oauth,
      tools: [],
    },
    grant,
  );
  const connectors = constructOnGrant(grant, oauth, () =>
    names.map((name) => PRODUCTS[name].factory(`${id}_${name}`, productOptions() as never)),
  );
  return [account, ...connectors];
}

function selectedProducts(at: string, selected: unknown): GoogleProductName[] {
  if (selected === undefined) return [...GOOGLE_PRODUCTS];
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    !selected.every((name) => typeof name === "string" && Object.hasOwn(PRODUCTS, name)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error(`${at} products must be a non-empty list of distinct names from: ${GOOGLE_PRODUCTS.join(", ")}.`);
  }
  return GOOGLE_PRODUCTS.filter((name) => selected.includes(name));
}
