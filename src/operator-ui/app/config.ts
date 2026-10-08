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

declare global {
  interface Window {
    Clerk?: BrowserClerk;
  }
}

interface ShellConfig {
  auth: BrowserAuth;
  mcpUrl: string;
  initialPage: string;
  titleSuffix: string;
  productName: string;
  productDescription: string;
  productOperatorLabel: string;
}

const config = JSON.parse(document.getElementById("operatorConfig")!.textContent!) as ShellConfig;
export const { auth, mcpUrl, initialPage, titleSuffix, productName,
  productDescription } = config;

/** Where a bearer operator's token lives between visits. */
export const TOKEN_KEY = "connecta:token";
