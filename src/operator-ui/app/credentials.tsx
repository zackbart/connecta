import { useState } from "react";
import type { UiConnector } from "../model.js";
import { confirmCopy, credentialProblemCopy, formatDate, type Notice } from "../view.js";
import {
  askConfirm,
  cancelConfirm,
  editCredential,
  refuseCredential,
  removeCredential,
  saveCredential,
  testCredential,
} from "./store.js";
import { Callout, ConfirmBar, FixPrompt, focusableId, NoticeLine, Pill } from "./parts.js";
import { Icon } from "./icons.js";

type Credential = NonNullable<UiConnector["credential"]>;

/**
 * What the form needs from a slot: its label, and each field's name and label
 * for a multi-field slot. Never a value. A maintainer's `/ui/data` slot and a
 * member's `manage` both fit.
 */
interface CredentialFormSlot {
  label: string;
  placeholder?: string;
  fields?: Array<{
    name: string;
    label: string;
    description?: string;
    placeholder?: string;
    inputType?: "email" | "password" | "text";
  }>;
}

export function CredentialForm({
  connector,
  credential,
  busy,
  testable = false,
  untested = false,
}: {
  connector: string;
  credential: CredentialFormSlot;
  busy: boolean;
  /** The connector can test a candidate, so Save tests it before storing it. */
  testable?: boolean;
  /** This form's candidate just failed its test; offer saving it without one. */
  untested?: boolean;
}) {
  const fields = credential.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const single = fields.length === 0;
  const inputId = `credential-input-${connector}`;
  const submit = (verify: "test" | "skip") => {
    if (single) {
      const value = (values.value ?? "").trim();
      if (!value) return refuseCredential(connector, "Paste a credential before saving.");
      return void saveCredential(connector, { value }, verify);
    }
    const entries: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.name] ?? "").trim();
      if (!value) {
        return refuseCredential(connector, "Fill every field before saving.");
      }
      entries[field.name] = value;
    }
    void saveCredential(connector, { values: entries }, verify);
  };
  return (
    <div className="credential-form" data-credential-form={connector}>
      {single ? (
        <>
          <label className="visually-hidden" htmlFor={inputId}>
            {credential.label}
          </label>
          <input
            id={inputId}
            type="password"
            aria-label={credential.label}
            placeholder={credential.placeholder || "Paste credential"}
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            value={values.value ?? ""}
            onInput={(event) => setValues({ value: event.currentTarget.value })}
          />
        </>
      ) : (
        <div className="credential-fields">
          {fields.map((field, index) => {
            const id = `credential-input-${connector}-${index}`;
            return (
              <div className="credential-field" key={field.name}>
                <label htmlFor={id}>{field.label}</label>
                {field.description ? (
                  <p className="meta" id={`${id}-description`}>
                    {field.description}
                  </p>
                ) : null}
                <input
                  id={id}
                  {...(field.description ? { "aria-describedby": `${id}-description` } : {})}
                  type={field.inputType || "password"}
                  placeholder={field.placeholder || field.label}
                  autoComplete={(field.inputType ?? "password") === "password" ? "new-password" : "off"}
                  autoCapitalize="none"
                  spellCheck={false}
                  value={values[field.name] ?? ""}
                  onInput={(event) =>
                    setValues({
                      ...values,
                      [field.name]: event.currentTarget.value,
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      )}
      <div className="actions">
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => submit(testable ? "test" : "skip")}
        >
          {busy ? (testable ? "Testing…" : "Saving…") : testable ? "Test and save" : "Save"}
        </button>
        {testable && untested ? (
          <button
            className="btn"
            type="button"
            data-save-untested={connector}
            disabled={busy}
            onClick={() => submit("skip")}
          >
            Save without testing
          </button>
        ) : null}
        <button className="btn quiet" type="button" disabled={busy} onClick={() => editCredential(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type CredentialState = "configured" | "missing" | "unavailable";

/** A slot or field's state, as the page reads it: saved, missing, or unreadable. */
function credentialState(credential: { configured: boolean | null; problem?: string }): CredentialState {
  if (credential.configured === null || credential.problem === "credential_unreadable") return "unavailable";
  return credential.configured ? "configured" : "missing";
}

const STATE_PILL: Record<CredentialState, { label: string; status: "healthy" | "attention" | "neutral" }> = {
  configured: { label: "Saved", status: "healthy" },
  missing: { label: "Not set", status: "attention" },
  unavailable: { label: "Unavailable", status: "neutral" },
};

function StatePill({ state }: { state: CredentialState }) {
  return <Pill status={STATE_PILL[state].status}>{STATE_PILL[state].label}</Pill>;
}

/** The last four characters the vault reports, masked, and when they were saved. */
function Masked({ lastFour, updatedAt }: { lastFour?: string | undefined; updatedAt?: string | undefined }) {
  if (!lastFour && !updatedAt) return null;
  return (
    <span className="credential-masked">
      {lastFour ? <code>••••{lastFour}</code> : null}
      {updatedAt ? <span className="meta">Updated {formatDate(updatedAt)}</span> : null}
    </span>
  );
}

export function CredentialCard({
  connector,
  credential,
  editing,
  untested = false,
  busy,
  confirming,
  notice,
}: {
  connector: UiConnector;
  credential: Credential;
  editing: boolean;
  /** The open form's candidate failed its test. */
  untested?: boolean;
  busy: boolean;
  /** Removal is waiting on its in-page confirm. */
  confirming: boolean;
  /** This card's own notice: it renders here, beside the control that caused it. */
  notice: Notice | null;
}) {
  const name = connector.title || connector.id;
  const configured = Boolean(credential.configured);
  const removable = configured || Boolean(credential.removable);
  const state = credentialState(credential);
  const multi = Boolean(credential.fields?.length);
  return (
    <section
      className="subcard credential-card"
      id={`credential-${connector.id}`}
      aria-labelledby={`credential-title-${connector.id}`}
      data-credential-state={state}
    >
      <div className="subcard-head">
        <span className={`credential-icon ${credential.error ? "danger" : state}`} aria-hidden="true">
          <Icon name="key" size={16} />
        </span>
        <div className="credential-heading">
          <h3 id={`credential-title-${connector.id}`}>{credential.label}</h3>
          {credential.description ? <p className="meta">{credential.description}</p> : null}
        </div>
        <StatePill state={state} />
      </div>
      {!multi && configured ? <Masked lastFour={credential.lastFour} updatedAt={credential.updatedAt} /> : null}
      {multi ? (
        <ul className="credential-field-summary">
          {credential.fields!.map((field) => (
            <li key={field.name} data-field-state={credentialState(field)}>
              <span className="credential-field-label">{field.label}</span>
              {field.configured ? <Masked lastFour={field.lastFour} updatedAt={field.updatedAt} /> : null}
              <StatePill state={credentialState(field)} />
            </li>
          ))}
        </ul>
      ) : null}
      {/* The payload's error text can name a vault failure; the page says a
          fixed sentence keyed by the problem instead. */}
      {credential.error ? (
        <div className="problem-block">
          <Callout data-problem={credential.problem}>{credentialProblemCopy(credential.problem)}</Callout>
          {credential.problem ? (
            <FixPrompt kind={credential.problem} connectorId={connector.id} name={connector.title || connector.id} />
          ) : null}
        </div>
      ) : null}
      {/* Leftover stored fields are not an error — the credential still works,
          so this stays muted copy rather than the msg block a failure earns. */}
      {credential.notice ? <p className="meta">{credential.notice}</p> : null}
      <div className="actions">
        <button
          className={removable ? "btn sm" : "btn sm primary"}
          type="button"
          aria-expanded={editing ? "true" : "false"}
          disabled={busy}
          onClick={() => editCredential(editing ? null : connector.id)}
        >
          {removable ? "Replace" : "Add credential"}
        </button>
        {configured && credential.testable ? (
          <button className="btn sm" type="button" disabled={busy} onClick={() => void testCredential(connector.id)}>
            {busy ? "Working…" : "Test"}
          </button>
        ) : null}
        {removable ? (
          <button
            id={`remove-credential-${connector.id}`}
            className="btn sm danger"
            type="button"
            disabled={busy}
            onClick={() => askConfirm(connector.id, "credential_remove")}
          >
            Remove
          </button>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmBar
          id={connector.id}
          {...confirmCopy("credential_remove", name)}
          onConfirm={() => void removeCredential(connector.id)}
          onCancel={() =>
            cancelConfirm(focusableId(`remove-credential-${connector.id}`, `conn-toggle-${connector.id}`))
          }
        />
      ) : null}
      {editing ? (
        <CredentialForm
          connector={connector.id}
          credential={credential}
          busy={busy}
          testable={credential.testable}
          untested={untested}
        />
      ) : null}
      <NoticeLine id={`credentialNotice-${connector.id}`} notice={notice} />
    </section>
  );
}
