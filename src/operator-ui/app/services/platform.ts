import { Context, Effect, Layer } from "effect";
import type { OperatorPage } from "../../view.js";

interface BrowserAuth {
  readonly kind: string;
  readonly signInUrl?: string;
  readonly signUpUrl?: string;
}

export interface ShellConfigShape {
  readonly auth: BrowserAuth;
  readonly initialPage: OperatorPage;
  readonly productName: string;
  readonly tokenKey: string;
}

export class ShellConfig extends Context.Service<ShellConfig, ShellConfigShape>()("connecta/operator-ui/ShellConfig") {}

export interface BrowserStorageShape {
  readonly readToken: () => string | null;
  readonly writeToken: (value: string | null) => void;
  readonly readNavHint: () => { activity: boolean };
  readonly writeNavHint: (hint: { activity: boolean } | null) => void;
}

const NAV_HINT_KEY = "connecta:nav";

export class BrowserStorage extends Context.Service<BrowserStorage, BrowserStorageShape>()(
  "connecta/operator-ui/BrowserStorage",
) {
  static readonly layer = Layer.effect(
    BrowserStorage,
    ShellConfig.useSync(({ tokenKey }) =>
      BrowserStorage.of({
        readToken: () => {
          try {
            return localStorage.getItem(tokenKey);
          } catch {
            return null;
          }
        },
        writeToken: (value) => {
          try {
            if (value === null) localStorage.removeItem(tokenKey);
            else localStorage.setItem(tokenKey, value);
          } catch {
            return;
          }
        },
        readNavHint: () => {
          try {
            const hint = JSON.parse(sessionStorage.getItem(NAV_HINT_KEY) ?? "null") as { activity?: unknown } | null;
            return { activity: hint?.activity === true };
          } catch {
            return { activity: false };
          }
        },
        writeNavHint: (hint) => {
          try {
            if (hint === null) sessionStorage.removeItem(NAV_HINT_KEY);
            else sessionStorage.setItem(NAV_HINT_KEY, JSON.stringify(hint));
          } catch {
            return;
          }
        },
      }),
    ),
  );
}

export interface ClerkSession {
  readonly id?: string;
  getToken(): Promise<string | null>;
}

interface ClerkGlobal {
  user?: unknown;
  session?: ClerkSession | null;
  load(options: {
    signInUrl?: string;
    signUpUrl?: string;
    signInFallbackRedirectUrl: string;
    signUpFallbackRedirectUrl: string;
    afterSignOutUrl: string;
  }): Promise<void>;
  addListener(listener: (resources: { session?: ClerkSession | null }) => void): void;
  redirectToSignIn(options: { signInFallbackRedirectUrl: string; signUpFallbackRedirectUrl: string }): void;
  signOut(options: { redirectUrl: string }): Promise<unknown>;
}

export interface ClerkClientShape {
  readonly present: () => boolean;
  readonly session: () => ClerkSession | null;
  readonly signedIn: () => boolean;
  readonly email: () => string | null;
  readonly load: (options: {
    signInUrl?: string;
    signUpUrl?: string;
    returnTo: string;
  }) => Effect.Effect<void, unknown>;
  readonly onSessionChange: (listener: (next: ClerkSession | null) => void) => void;
  readonly redirectToSignIn: (returnTo: string) => void;
  readonly signOut: (returnTo: string) => void;
}

const clerkGlobal = () => (globalThis as { window?: { Clerk?: ClerkGlobal } }).window?.Clerk;

export class ClerkClient extends Context.Service<ClerkClient, ClerkClientShape>()("connecta/operator-ui/ClerkClient") {
  static readonly layer = Layer.succeed(
    ClerkClient,
    ClerkClient.of({
      present: () => Boolean(clerkGlobal()),
      session: () => clerkGlobal()?.session ?? null,
      signedIn: () => Boolean(clerkGlobal()?.user),
      email: () => {
        const user = clerkGlobal()?.user as { primaryEmailAddress?: { emailAddress?: unknown } | null } | undefined;
        const email = user?.primaryEmailAddress?.emailAddress;
        return typeof email === "string" && email ? email : null;
      },
      load: ({ signInUrl, signUpUrl, returnTo }) =>
        Effect.tryPromise({
          try: () =>
            clerkGlobal()!.load({
              ...(signInUrl ? { signInUrl } : {}),
              ...(signUpUrl ? { signUpUrl } : {}),
              signInFallbackRedirectUrl: returnTo,
              signUpFallbackRedirectUrl: returnTo,
              afterSignOutUrl: returnTo,
            }),
          catch: (cause) => cause,
        }),
      onSessionChange: (listener) => clerkGlobal()?.addListener((resources) => listener(resources.session ?? null)),
      redirectToSignIn: (returnTo) =>
        clerkGlobal()?.redirectToSignIn({ signInFallbackRedirectUrl: returnTo, signUpFallbackRedirectUrl: returnTo }),
      signOut: (returnTo) => void clerkGlobal()?.signOut({ redirectUrl: returnTo }),
    }),
  );
}

export interface BrowserWindowShape {
  readonly href: () => string;
  readonly assign: (url: string) => void;
  readonly hidden: () => boolean;
  readonly openBlankTab: () => Window | null;
}

export class BrowserWindow extends Context.Service<BrowserWindow, BrowserWindowShape>()(
  "connecta/operator-ui/BrowserWindow",
) {
  static readonly layer = Layer.succeed(
    BrowserWindow,
    BrowserWindow.of({
      href: () => window.location.href,
      assign: (url) => window.location.assign(url),
      hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
      openBlankTab: () => {
        let tab: Window | null = null;
        try {
          tab = window.open("", "_blank");
        } catch {
          return null;
        }
        if (!tab) return null;
        try {
          tab.document.title = "Opening authorization…";
          tab.document.body.textContent = "Opening the authorization page…";
        } catch {
          return tab;
        }
        return tab;
      },
    }),
  );
}

class TransportError {
  readonly _tag = "TransportError";
}

export interface TransportShape {
  readonly fetch: (path: string, init: RequestInit) => Effect.Effect<Response, TransportError>;
}

export class Transport extends Context.Service<Transport, TransportShape>()("connecta/operator-ui/Transport") {
  static readonly layer = Layer.succeed(
    Transport,
    Transport.of({
      fetch: (path, init) =>
        Effect.tryPromise({
          try: (interrupted) =>
            fetch(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, interrupted]) : interrupted }),
          catch: () => new TransportError(),
        }),
    }),
  );
}
