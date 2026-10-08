import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Button, Dialog, Tabs } from "./primitives.js";
import { homeUrl } from "./config.js";
import { isArtifactPage, PAGE_META, type OperatorPage } from "../view.js";
import { navigate } from "./store.js";

const THEME_KEY = "connecta:scheme";
type Scheme = "light" | "dark" | "system";
function readScheme(): Scheme {
  const pinned = document.documentElement.dataset.scheme;
  if (pinned === "light" || pinned === "dark") return pinned;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* private browsing */ }
  return "system";
}
export function ShellControls({ pages, current }: { pages: OperatorPage[]; current: OperatorPage }) {
  // Each dialog keeps its own return target, including when ⌘K opens over
  // Appearance. Closing the palette returns to the still-open appearance tab.
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  const appearanceReturnFocus = useRef<HTMLElement | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [scheme, setScheme] = useState<Scheme>(readScheme);
  const [pinned] = useState(Boolean(document.documentElement.dataset.scheme));
  useEffect(() => {
    if (scheme === "system") delete document.documentElement.dataset.scheme;
    else document.documentElement.dataset.scheme = scheme;
    if (!pinned) {
      try { localStorage.setItem(THEME_KEY, scheme); } catch { /* private browsing */ }
    }
  }, [scheme, pinned]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!commandOpen) commandReturnFocus.current = document.activeElement as HTMLElement;
        setCommandOpen(open => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commandOpen]);
  const go = (page: OperatorPage) => {
    setCommandOpen(false);
    if (page === "artifacts" || isArtifactPage(current)) {
      window.location.assign(page === "artifacts" ? PAGE_META[page].path : new URL(PAGE_META[page].path, new URL(homeUrl, window.location.href)).href);
    } else navigate(page, PAGE_META[page].path);
  };
  return <>
    <Button variant="quiet" className="command-trigger" onClick={() => { commandReturnFocus.current = document.activeElement as HTMLElement; setCommandOpen(true); }}>
      <span>Search pages</span><kbd>⌘K</kbd>
    </Button>
    <Button variant="quiet" className="appearance-trigger" onClick={() => { appearanceReturnFocus.current = document.activeElement as HTMLElement; setAppearanceOpen(true); }}>Appearance</Button>
    <Dialog returnFocusTo={commandReturnFocus} open={commandOpen} onOpenChange={setCommandOpen} title="Go to page" description="Search operator pages and actions.">
      <Command label="Operator commands" loop>
        <Command.Input className="command-input" placeholder="Search pages…" autoFocus />
        <Command.List className="command-list">
          <Command.Empty>No matching pages or actions.</Command.Empty>
          <Command.Group heading="Pages">
            {pages.map(page => <Command.Item key={page} value={PAGE_META[page].label} onSelect={() => go(page)}>{PAGE_META[page].label}</Command.Item>)}
          </Command.Group>
          <Command.Group heading="Preferences"><Command.Item onSelect={() => {
            if (!appearanceOpen) appearanceReturnFocus.current = commandReturnFocus.current;
            setCommandOpen(false); setAppearanceOpen(true);
          }}>Appearance</Command.Item></Command.Group>
        </Command.List>
      </Command>
    </Dialog>
    <Dialog returnFocusTo={appearanceReturnFocus} open={appearanceOpen} onOpenChange={setAppearanceOpen} title="Appearance" description={pinned ? "This deployment sets the color scheme." : "Choose a color scheme for operator pages."}>
      {pinned ? <p className="meta">{scheme === "dark" ? "Dark" : "Light"} mode</p> : <Tabs value={scheme} onValueChange={value => setScheme(value as Scheme)} items={[
        { value: "light", label: "Light", content: <p>Use light surfaces.</p> },
        { value: "dark", label: "Dark", content: <p>Use dark surfaces.</p> },
        { value: "system", label: "System", content: <p>Follow your device’s appearance.</p> },
      ]} />}
    </Dialog>
  </>;
}
