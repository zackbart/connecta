import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Notice, OperatorPage, Tone } from "../view.js";
import { PAGE_META } from "../view.js";
import { fixPrompt, type FixPromptKind } from "../fix-prompts.js";
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
  // `notice` is what keeps an empty one rendered and measurable at zero height;
  // hiding it outright would take the live region with it. A failure that has
  // a fix prompt renders it beside the live region, never inside it, so the
  // announced text stays the message alone.
  return (
    <>
    <p
      id={id}
      class={
        notice?.tone === "error"
          ? `notice ${className} error-notice`
          : `notice ${className}`
      }
      role={notice?.tone === "error" ? "alert" : "status"}
      aria-live="polite"
      tabIndex={-1}
    >
      {notice ? notice.message : null}
    </p>
    {notice?.tone === "error" && notice.fix ? (
      <FixPrompt kind={notice.fix.kind} connectorId={notice.fix.connectorId} />
    ) : null}
    </>
  );
}

/**
 * "Copy fix prompt" and the text it copies. The text comes from the fixed
 * catalogue in `fix-prompts.ts` by kind, so whatever the notice above it says,
 * what reaches the clipboard is the same text a test walked.
 */
export function FixPrompt({
  kind,
  connectorId,
  name,
}: {
  kind: FixPromptKind;
  connectorId: string;
  name?: string;
}) {
  const text = fixPrompt(kind, connectorId);
  return (
    <div class="fix-prompt" data-fix-prompt={kind}>
      <div class="fix-prompt-head">
        <CopyButton
          value={text}
          label="Copy fix prompt"
          class="btn quiet"
          ariaLabel={`Copy fix prompt for ${name ?? connectorId}`}
        />
        <span class="meta">
          Fixed text for a coding agent working on this deployment. It carries no error details or secrets.
        </span>
      </div>
      <details>
        <summary class="disclosure">Preview prompt</summary>
        <pre class="fix-prompt-text">{text}</pre>
      </details>
    </div>
  );
}

/** A status word with a tone. The page's one piece of decoration. */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ComponentChildren;
}) {
  return <span class={tone === "neutral" ? "badge" : `badge ${tone}`}>{children}</span>;
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
  class: className = "btn",
  ariaLabel,
}: {
  value: string;
  label: string;
  class?: string;
  /** For a row of identical labels, the name that tells them apart. */
  ariaLabel?: string;
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
      {...(ariaLabel && status === "idle" ? { "aria-label": ariaLabel } : {})}
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
