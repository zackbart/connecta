/**
 * The constants `renderUiHtml` writes into the page immediately before this
 * bundle, read once here so no component reaches for a bare global. Everything
 * here is deployment configuration the server already gated; none of it is
 * operator data, which arrives only through the authenticated `/ui/*` APIs.
 */

interface BrowserAuth {
  kind: string;
  publishableKey?: string;
  frontendApiUrl?: string;
  signInUrl?: string;
  signUpUrl?: string;
}

interface BrowserClerkSession {
  id?: string;
  getToken(): Promise<string | null>;
}

interface BrowserClerk {
  user?: unknown;
  session?: BrowserClerkSession | null;
  load(options: {
    signInUrl?: string;
    signUpUrl?: string;
    signInFallbackRedirectUrl: string;
    signUpFallbackRedirectUrl: string;
    afterSignOutUrl: string;
  }): Promise<void>;
  addListener(
    listener: (resources: { session?: BrowserClerkSession | null }) => void,
  ): void;
  redirectToSignIn(options: {
    signInFallbackRedirectUrl: string;
    signUpFallbackRedirectUrl: string;
  }): void;
  signOut(options: { redirectUrl: string }): Promise<unknown>;
}

declare const AUTH: BrowserAuth;
declare const MCP_URL: string;
declare const INITIAL_PAGE: string;
declare const TITLE_SUFFIX: string;
declare const PRODUCT_NAME: string;
declare const PRODUCT_DESCRIPTION: string;
declare const PRODUCT_OPERATOR_LABEL: string;

declare global {
  interface Window {
    Clerk?: BrowserClerk;
  }
}

export const auth = AUTH;
export const mcpUrl = MCP_URL;
export const initialPage = INITIAL_PAGE;
export const titleSuffix = TITLE_SUFFIX;
export const productName = PRODUCT_NAME;
export const productDescription = PRODUCT_DESCRIPTION;
export const productOperatorLabel = PRODUCT_OPERATOR_LABEL;

/** Where a bearer operator's token lives between visits. */
export const TOKEN_KEY = "connecta:token";
