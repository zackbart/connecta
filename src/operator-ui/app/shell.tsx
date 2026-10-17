import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { Dialog, Tabs } from "./primitives.js";
import { PAGE_META, type OperatorPage, type OperatorState } from "../view.js";
import { navigate } from "./store.js";
import { useCloseOnRecovery } from "./contract-state.js";
import { schemePinned } from "./config.js";
import { SCHEME_KEY } from "./scheme.js";
import { Icon } from "./icons.js";

type Scheme = "light" | "dark" | "system";
/**
 * The saved scheme is already on the element: `scheme-init.ts` applies it
 * before first paint. A deployment's pin, also on the element, comes from the
 * server, so the shell config tells the two apart.
 */
function readScheme(): Scheme {
  const current = document.documentElement.dataset.scheme;
  if (schemePinned && (current === "light" || current === "dark")) return current;
  try {
    const stored = localStorage.getItem(SCHEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* private browsing */
  }
  return "system";
}

export function ShellControls({ pages, state }: { pages: OperatorPage[]; state: OperatorState }) {
  // Each dialog keeps its own return target, including when ⌘K opens over
  // Appearance. Closing the palette returns to the still-open appearance tab.
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  const appearanceReturnFocus = useRef<HTMLElement | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // Neither modal may hold focus away from the recovery banner's Retry.
  useCloseOnRecovery(state, () => {
    setCommandOpen(false);
    setAppearanceOpen(false);
  });
  const activeDialogs = useRef({ command: false, appearance: false });
  useLayoutEffect(() => {
    activeDialogs.current = { command: commandOpen, appearance: appearanceOpen };
  }, [commandOpen, appearanceOpen]);
  const [scheme, setScheme] = useState<Scheme>(readScheme);
  const pinned = schemePinned;
  useEffect(() => {
    if (scheme === "system") delete document.documentElement.dataset.scheme;
    else document.documentElement.dataset.scheme = scheme;
    if (!pinned) {
      try {
        localStorage.setItem(SCHEME_KEY, scheme);
      } catch {
        /* private browsing */
      }
    }
  }, [scheme, pinned]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const open = activeDialogs.current;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!open.command) commandReturnFocus.current = document.activeElement as HTMLElement;
        setCommandOpen(!open.command);
      } else if (event.key === "Escape" && (open.command || open.appearance)) {
        // A newly opened Radix layer registers its Escape listener in a passive
        // effect. Handle this shell's stack before that registration settles so
        // a fast Escape cannot dismiss the underlying Appearance dialog.
        event.preventDefault();
        event.stopPropagation();
        if (open.command) setCommandOpen(false);
        else setAppearanceOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const go = (page: OperatorPage, href = PAGE_META[page].path) => {
    // Page navigation owns focus. Radix's deferred close callbacks must not
    // restore a sidebar trigger after the destination heading receives it.
    commandReturnFocus.current = null;
    appearanceReturnFocus.current = null;
    setAppearanceOpen(false);
    setCommandOpen(false);
    navigate(page, href);
  };
  return (
    <>
      <button
        type="button"
        className="command-trigger"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => {
          commandReturnFocus.current = document.activeElement as HTMLElement;
          setCommandOpen(true);
        }}
      >
        <Icon name="search" size={15} />
        <span className="command-label" aria-hidden="true">
          Search
        </span>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>
      <button
        type="button"
        className="icon-button appearance-trigger"
        aria-label="Appearance"
        title="Appearance"
        onClick={() => {
          appearanceReturnFocus.current = document.activeElement as HTMLElement;
          setAppearanceOpen(true);
        }}
      >
        <Icon name={scheme === "dark" ? "moon" : scheme === "light" ? "sun" : "monitor"} size={17} />
      </button>
      <Dialog
        returnFocusTo={appearanceReturnFocus}
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
        title="Appearance"
        description={pinned ? "Set by this deployment" : "Color scheme"}
      >
        {pinned ? (
          <p className="meta">{scheme === "dark" ? "Dark" : "Light"} mode</p>
        ) : (
          <Tabs
            variant="segmented"
            value={scheme}
            onValueChange={(value) => setScheme(value as Scheme)}
            items={[
              { value: "light", label: "Light", content: <p>Light surfaces</p> },
              { value: "dark", label: "Dark", content: <p>Dark surfaces</p> },
              { value: "system", label: "System", content: <p>Match your device</p> },
            ]}
          />
        )}
      </Dialog>
      <Dialog
        palette
        returnFocusTo={commandReturnFocus}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="Search"
        description="Pages, connectors and tools"
      >
        <Command label="Operator commands" loop>
          <div className="command-field">
            <Icon name="search" size={16} />
            <Command.Input className="command-input" placeholder="Search pages, connectors, tools…" autoFocus />
          </div>
          <Command.List className="command-list">
            <Command.Empty>No matches</Command.Empty>
            <Command.Group heading="Pages">
              {pages.map((page) => (
                <Command.Item key={page} value={PAGE_META[page].label} onSelect={() => go(page)}>
                  <Icon name="page" size={15} />
                  {PAGE_META[page].label}
                </Command.Item>
              ))}
            </Command.Group>
            {state.session === "ready" && state.contract?.role === "maintainer" && state.contract.config ? (
              <>
                <Command.Group heading="Connectors">
                  {state.contract.config.connectors.map((connector) => (
                    <Command.Item
                      key={connector.id}
                      value={`connector ${connector.id} ${connector.title ?? ""}`}
                      onSelect={() => go("connector", `/connectors/${encodeURIComponent(connector.id)}#tools`)}
                    >
                      <Icon name="plug" size={15} />
                      {connector.title ?? connector.id}
                    </Command.Item>
                  ))}
                </Command.Group>
                <Command.Group heading="Tools">
                  {state.contract.live.connectors.flatMap((connector) =>
                    connector.tools.map((tool) => (
                      <Command.Item
                        key={tool.address}
                        value={`tool ${tool.address} ${tool.description ?? ""}`}
                        onSelect={() => go("connector", `/connectors/${encodeURIComponent(connector.id)}#tools`)}
                      >
                        <Icon name="tool" size={15} />
                        <code>{tool.address}</code>
                      </Command.Item>
                    )),
                  )}
                </Command.Group>
              </>
            ) : null}
            <Command.Group heading="Preferences">
              <Command.Item
                onSelect={() => {
                  if (!appearanceOpen) {
                    appearanceReturnFocus.current = commandReturnFocus.current;
                    // A newly mounted Appearance dialog supplies its own autofocus.
                    commandReturnFocus.current = null;
                  }
                  // If already mounted, restore the tab the palette interrupted.
                  setCommandOpen(false);
                  setAppearanceOpen(true);
                }}
              >
                <Icon name="sun" size={15} />
                Appearance
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </Dialog>
    </>
  );
}

/**
 * The account in the top bar: who is signed in, and the way out. A
 * disclosure, not a menu widget: its contents are a line of text and one or
 * two plain buttons, reachable with Tab. Escape, a click elsewhere, and focus
 * leaving it close it.
 */
export function AccountMenu({
  account,
  role,
  children,
}: {
  /** The signed-in email, where the sign-in exposes one. */
  account: string | null;
  role: string;
  /** The session action: Sign out or Change token. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const initial = account?.trim().charAt(0).toUpperCase();
  return (
    <div
      className="account-menu"
      ref={root}
      onBlur={(event) => {
        // Tabbing past the panel's last button closes it, as a click elsewhere does.
        const next = event.relatedTarget as Node | null;
        if (open && next && !root.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="account-trigger"
        aria-label="Account"
        title="Account"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="account-avatar" aria-hidden="true">
          {initial ? initial : <Icon name="user" size={15} />}
        </span>
      </button>
      <div id={panel} className="account-panel" hidden={!open}>
        <div className="account-who">
          <p className="account-label">{account ?? "Signed in"}</p>
          <p className="meta">{role}</p>
        </div>
        <div className="account-session">{children}</div>
      </div>
    </div>
  );
}
