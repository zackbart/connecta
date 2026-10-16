import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { Notice, OperatorPage, OperatorState, Tone } from "../view.js";
import { loadFailureCopy, PAGE_META, pageForPath } from "../view.js";
import { fixPrompt, type FixPromptKind } from "../fix-prompts.js";
import { productName } from "./config.js";
import { Icon } from "./icons.js";
import { navigate, retryLoad } from "./store.js";

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
        className={notice?.tone === "error" ? `notice ${className} error-notice` : `notice ${className}`}
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
 * what reaches the clipboard is the same text a test walked. One button and a
 * disclosure: the sentence explaining what the prompt is sits inside the
 * preview, so a page of failing rows does not repeat it on every one.
 */
export function FixPrompt({ kind, connectorId, name }: { kind: FixPromptKind; connectorId: string; name?: string }) {
  return (
    <div className="fix-prompt" data-fix-prompt={kind}>
      <FixPromptButton kind={kind} connectorId={connectorId} {...(name ? { name } : {})} />
      <FixPromptPreview kind={kind} connectorId={connectorId} />
    </div>
  );
}

/** The fix prompt's two halves. */
function FixPromptButton({ kind, connectorId, name }: { kind: FixPromptKind; connectorId: string; name?: string }) {
  return (
    <CopyButton
      value={fixPrompt(kind, connectorId)}
      label="Copy fix prompt"
      ariaLabel={`Copy fix prompt for ${name ?? connectorId}`}
    />
  );
}

function FixPromptPreview({ kind, connectorId }: { kind: FixPromptKind; connectorId: string }) {
  return (
    <details className="fix-prompt-preview">
      <summary className="disclosure">Preview prompt</summary>
      <p className="meta">
        Fixed text for a coding agent working on this deployment. It carries no error details or secrets.
      </p>
      <pre className="fix-prompt-text">{fixPrompt(kind, connectorId)}</pre>
    </details>
  );
}

/** A short tag: a mode, a classification, where a value came from. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === "neutral" ? "badge tag" : `badge tag ${tone}`}>{children}</span>;
}

/** How something is doing, in four words a glance can read. */
type PillStatus = "healthy" | "attention" | "error" | "neutral" | "info";

const PILL_TONE: Record<PillStatus, string> = {
  healthy: "ok",
  attention: "warn",
  error: "danger",
  neutral: "",
  info: "accent",
};

/** The status a tone from the view model reads as. */
export function pillStatus(tone: Tone): PillStatus {
  return tone === "ok"
    ? "healthy"
    : tone === "warn"
      ? "attention"
      : tone === "danger"
        ? "error"
        : tone === "accent"
          ? "info"
          : "neutral";
}

/** A status with its dot. The word carries the meaning; the color repeats it. */
export function Pill({ status = "neutral", children }: { status?: PillStatus; children: ReactNode }) {
  const tone = PILL_TONE[status];
  return (
    <span className={tone ? `badge pill ${tone}` : "badge pill"}>
      <span className="pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * A message the reader has to act on or know: a problem (red) or a notice
 * (amber). The caller's attributes land on the box, so data hooks stay.
 */
export function Callout({
  tone = "problem",
  children,
  ...props
}: { tone?: "problem" | "notice"; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={tone === "notice" ? "msg callout warn" : "msg callout"} {...props}>
      <Icon name="alert" />
      <p>{children}</p>
    </div>
  );
}

/** Label and value pairs read across one line, wrapping on a narrow screen. */
export function SummaryRow({ items, className }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={className ? `summary-row ${className}` : "summary-row"}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The one shape for "nothing to show here": a list that is empty, still
 * loading, or could not load. Centered, with the next step under it, so every
 * page's empty and error states read the same. An error is an alert; the
 * rest are status.
 */
export function StateBlock({
  title,
  children,
  tone = "neutral",
  action,
  id,
  busy,
}: {
  title?: string;
  children?: ReactNode;
  tone?: "neutral" | "error";
  action?: { label: string; onClick: () => void; id?: string };
  id?: string;
  /** Still loading: a spinner beside the words, not instead of them. */
  busy?: boolean;
}) {
  return (
    <div
      className={tone === "error" ? "state-block error" : busy ? "state-block busy" : "state-block"}
      role={tone === "error" ? "alert" : "status"}
      {...(id ? { id } : {})}
    >
      {tone === "error" ? (
        <span className="state-mark">
          <Icon name="alert" size={20} />
        </span>
      ) : busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : null}
      {title ? <p className="state-title">{title}</p> : null}
      {children ? <p className="state-copy">{children}</p> : null}
      {action ? (
        <button className="btn" type="button" onClick={action.onClick} {...(action.id ? { id: action.id } : {})}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Why `/ui/data` could not be read, still signed in, with the one way forward. */
export function LoadFailure({ state }: { state: OperatorState }) {
  if (!state.loadFailure) return null;
  const copy = loadFailureCopy(state.loadFailure, productName);
  return (
    <StateBlock
      id="loadFailure"
      tone="error"
      title={copy.title}
      action={{ label: "Retry", onClick: () => void retryLoad(), id: "retryLoad" }}
    >
      {copy.body}
    </StateBlock>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <StateBlock>{children}</StateBlock>;
}

export function Unavailable({ children }: { children: ReactNode }) {
  return <div className="unavailable">{children}</div>;
}

/**
 * A second, in-page click for a row action that takes something away. It
 * renders where the first click happened, names the connector by its title,
 * and starts with focus on Cancel so a stray Enter undoes nothing.
 */
export function ConfirmBar({
  id,
  question,
  confirm,
  onConfirm,
  onCancel,
}: {
  id: string;
  question: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="confirm"
      role="group"
      aria-labelledby={`confirm-question-${id}`}
      // Escape backs out, from either button, the way a dialog would.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <p id={`confirm-question-${id}`}>{question}</p>
      <div className="actions">
        <button className="btn danger" type="button" onClick={onConfirm}>
          {confirm}
        </button>
        <button id={`confirm-cancel-${id}`} className="btn quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The first of these elements that can take focus now. A confirm's trigger
 * can vanish under it — a refresh puts the row in its loading state — and
 * focus then goes to the next target rather than to the page.
 */
export function focusableId(...ids: string[]): string {
  for (const id of ids) {
    const element = document.getElementById(id) as HTMLButtonElement | null;
    if (element && !element.disabled) return id;
  }
  return ids[ids.length - 1] ?? "";
}

/**
 * Follow a same-origin operator link in place. Anything a browser would treat
 * as "open elsewhere" — a modifier key, a middle click — is left to the
 * browser, which is also why every such link carries a real href. The page
 * comes from the href's path unless the caller names it.
 */
export function followLink(event: MouseEvent, href: string, page?: OperatorPage): void {
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
  navigate(page ?? pageForPath(href.replace(/[?#].*$/, "")), href);
}

/** A nav link to one of the operator's pages. */
export function PageLink({
  page,
  className,
  current,
  children,
}: {
  page: OperatorPage;
  className?: string;
  current?: boolean;
  children: ReactNode;
}) {
  const href = PAGE_META[page].path;
  return (
    <a
      className={className}
      href={href}
      {...(current ? { "aria-current": "page" as const } : {})}
      onClick={(event) => followLink(event, href, page)}
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
  className = "btn sm copy-btn",
  ariaLabel,
  id,
  icon,
}: {
  value: string;
  label: string;
  className?: string;
  /** Draw a small icon instead of the label; the label stays the fallback name. */
  icon?: boolean;
  /** For a row of identical labels, the name that tells them apart. */
  ariaLabel?: string;
  id?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [status]);
  const text = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label;
  return (
    <button
      className={icon ? `${className} quiet icon` : className}
      type="button"
      {...(id ? { id } : {})}
      {...(icon ? { title: text } : {})}
      {...(ariaLabel && status === "idle" ? { "aria-label": ariaLabel } : {})}
      onClick={() => {
        // No clipboard at all — an insecure origin, an old browser — is a
        // failed copy too, and says so rather than doing nothing.
        const write = navigator.clipboard?.writeText(value) ?? Promise.reject(new Error("no clipboard"));
        write.then(
          () => setStatus("copied"),
          () => setStatus("failed"),
        );
      }}
    >
      {icon ? (
        <>
          <CopyIcon done={status === "copied"} />
          <span className="visually-hidden">{text}</span>
        </>
      ) : (
        text
      )}
    </button>
  );
}

function CopyIcon({ done }: { done: boolean }) {
  return <Icon name={done ? "check" : "copy"} size={15} />;
}
