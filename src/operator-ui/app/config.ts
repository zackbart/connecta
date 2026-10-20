/**
 * The inert JSON `renderUiHtml` writes into the shell, read once here so
 * components receive only the deployment configuration the server gated. Everything
 * here is deployment configuration the server already gated; none of it is
 * operator data, which arrives only through the authenticated `/ui/*` APIs.
 */

interface BrowserAuth {
  kind: string;
  publishableKey?: string;
  frontendApiUrl?: string;
  signInUrl?: string;
  signUpUrl?: string;
  organizationId?: string;
}

interface BrowserClerkSession {
  id?: string;
  getToken(options?: { organizationId?: string }): Promise<string | null>;
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
  addListener(listener: (resources: { session?: BrowserClerkSession | null }) => void): void;
  redirectToSignIn(options: { signInFallbackRedirectUrl: string; signUpFallbackRedirectUrl: string }): void;
  signOut(options: { redirectUrl: string }): Promise<unknown>;
}

declare global {
  interface Window {
    Clerk?: BrowserClerk;
  }
}

interface ShellConfig {
  auth: BrowserAuth;
  mcpUrl: string;
  initialPage: string;
  /** The deployment pinned a color scheme; the viewer's choice does not apply. */
  schemePinned: boolean;
  titleSuffix: string;
  productName: string;
  /** The mark beside the brand: connecta's drawn "C", the served SVG favicon, or none. */
  brandMark: "connecta" | "favicon" | "none";
  productDescription: string;
  productOperatorLabel: string;
}

const config = JSON.parse(document.getElementById("operatorConfig")!.textContent!) as ShellConfig;
export const { auth, mcpUrl, initialPage, schemePinned, titleSuffix, productName, productDescription, brandMark } =
  config;

/** Where a bearer operator's token lives between visits. */
export const TOKEN_KEY = "connecta:token";
