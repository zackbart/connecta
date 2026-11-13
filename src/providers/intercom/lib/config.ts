/** The Intercom data-hosting region a workspace lives in. */
export type IntercomRegion = "us" | "eu" | "au";

export const INTERCOM_BASE_URLS: Readonly<Record<IntercomRegion, string>> = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
  au: "https://api.au.intercom.io",
};

export const INTERCOM_REGION_NAMES: Readonly<Record<IntercomRegion, string>> = {
  us: "United States",
  eu: "Europe",
  au: "Australia",
};

export function regionOf(value: unknown): IntercomRegion {
  if (value === undefined) return "us";
  if (value === "us" || value === "eu" || value === "au") return value;
  throw new Error('intercom() region must be "us", "eu" or "au", the workspace\'s Intercom data-hosting region.');
}
