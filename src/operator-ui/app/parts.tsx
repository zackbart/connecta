import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Notice, OperatorPage } from "../view.js";
import { PAGE_META } from "../view.js";
import { navigate } from "./store.js";

/** The handful of shapes every page repeats: notices, links, copy, and nothing-here. */

export function NoticeLine({
  id,
  notice,
  className = "meta",
}: {
  id: string;
  notice: Notice | null;
  className?: string;
}) {
  // The element stays mounted with a stable id so a focus request can land on
  // it, and so assistive technology announces a change rather than an arrival.
  return (
    <p
      id={id}
      class={notice?.tone === "error" ? `${className} error-notice` : className}
      role={notice?.tone === "error" ? "alert" : "status"}
      aria-live="polite"
      tabIndex={-1}
    >
      {notice ? notice.message : null}
    </p>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

export function Unavailable({ children }: { children: ComponentChildren }) {
  return <div class="unavailable">{children}</div>;
}

/**
 * A same-origin operator link that navigates in place. Anything a browser would
 * treat as "open elsewhere" — a modifier key, a middle click, another origin —
 * is left to the browser, which is also why the href is a real one.
 */
export function PageLink({
  page,
  class: className,
  current,
  children,
}: {
  page: OperatorPage;
  class?: string;
  current?: boolean;
  children: ComponentChildren;
}) {
  const href = PAGE_META[page].path;
  return (
    <a
      class={className}
      href={href}
      {...(current ? { "aria-current": "page" as const } : {})}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(page, href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Copy to clipboard with its own outcome. The label reverts on a timer so a
 * failed copy cannot masquerade as a success on the next glance.
 */
export function CopyButton({
  value,
  label,
  class: className = "linklike",
}: {
  value: string;
  label: string;
  class?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <button
      class={className}
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setStatus("copied"),
          () => setStatus("failed"),
        );
      }}
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label}
    </button>
  );
}
