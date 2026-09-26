import { useState } from "preact/hooks";
import type { UiConnector } from "../model.js";
import {
  confirmCopy,
  credentialProblemCopy,
  credentialStateLabel,
  formatDate,
  type Notice,
} from "../view.js";
import {
  askConfirm,
  cancelConfirm,
  editCredential,
  refuseCredential,
  removeCredential,
  saveCredential,
  testCredential,
} from "./store.js";
import { ConfirmBar, FixPrompt, NoticeLine } from "./parts.js";

type Credential = NonNullable<UiConnector["credential"]>;

function CredentialForm({
  connector,
  credential,
  busy,
}: {
  connector: string;
  credential: Credential;
  busy: boolean;
}) {
  const fields = credential.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const single = fields.length === 0;
  const inputId = `credential-input-${connector}`;
  const submit = () => {
    if (single) {
      const value = (values.value ?? "").trim();
      if (!value) return refuseCredential(connector, "Paste a credential before saving.");
      return void saveCredential(connector, { value });
    }
    const entries: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.name] ?? "").trim();
      if (!value) {
        return refuseCredential(
          connector,
          "Complete every credential field before saving.",
        );
      }
      entries[field.name] = value;
    }
    void saveCredential(connector, { values: entries });
  };
  return (
    <div class="credential-form" data-credential-form={connector}>
      {single ? (
        <>
          <label class="visually-hidden" for={inputId}>
            {credential.label}
          </label>
          <input
            id={inputId}
            type="password"
            aria-label={credential.label}
            placeholder={credential.placeholder || "Paste credential"}
            autocomplete="new-password"
            autocapitalize="none"
            spellcheck={false}
            value={values.value ?? ""}
            onInput={(event) =>
              setValues({ value: event.currentTarget.value })
            }
          />
        </>
      ) : (
        <div class="credential-fields">
          {fields.map((field, index) => {
            const id = `credential-input-${connector}-${index}`;
            return (
              <div class="credential-field" key={field.name}>
                <label for={id}>{field.label}</label>
                <input
                  id={id}
                  type={field.inputType || "password"}
                  placeholder={field.placeholder || field.label}
                  autocomplete={
                    (field.inputType ?? "password") === "password"
                      ? "new-password"
                      : "off"
                  }
                  autocapitalize="none"
                  spellcheck={false}
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
      <div class="actions">
        <button class="btn primary" type="button" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          class="btn quiet"
          type="button"
          disabled={busy}
          onClick={() => editCredential(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function CredentialCard({
  connector,
  credential,
  editing,
  busy,
  confirming,
  notice,
}: {
  connector: UiConnector;
  credential: Credential;
  editing: boolean;
  busy: boolean;
  /** Removal is waiting on its in-page confirm. */
  confirming: boolean;
  /** This card's own notice: it renders here, beside the control that caused it. */
  notice: Notice | null;
}) {
  const name = connector.title || connector.id;
  const configured = Boolean(credential.configured);
  const removable = configured || Boolean(credential.removable);
  return (
    <section
      class="subcard"
      id={`credential-${connector.id}`}
      aria-labelledby={`credential-title-${connector.id}`}
    >
      <div class="subcard-head">
        <h3 id={`credential-title-${connector.id}`}>{credential.label}</h3>
        <span class="meta">{credentialStateLabel(credential)}</span>
      </div>
      {credential.description ? (
        <p class="meta">{credential.description}</p>
      ) : null}
      {credential.fields?.length ? (
        <div class="credential-field-summary">
          {credential.fields.map((field) => (
            <div key={field.name}>
              <span>{field.label}</span>
              <span class="meta">
                {field.configured
                  ? `configured · ••••${field.lastFour ?? ""}${
                      field.updatedAt
                        ? ` · updated ${formatDate(field.updatedAt)}`
                        : ""
                    }`
                  : "not configured"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {/* The payload's error text can name a vault failure; the page says a
          fixed sentence keyed by the problem instead. */}
      {credential.error ? (
        <p class="msg">{credentialProblemCopy(credential.problem)}</p>
      ) : null}
      {credential.error && credential.problem ? (
        <FixPrompt
          kind={credential.problem}
          connectorId={connector.id}
          name={connector.title || connector.id}
        />
      ) : null}
      {/* Leftover stored fields are not an error — the credential still works,
          so this stays muted copy rather than the msg block a failure earns. */}
      {credential.notice ? (
        <p class="meta">{credential.notice}</p>
      ) : null}
      <div class="actions">
        <button
          class={removable ? "btn" : "btn primary"}
          type="button"
          aria-expanded={editing ? "true" : "false"}
          disabled={busy}
          onClick={() => editCredential(editing ? null : connector.id)}
        >
          {removable ? "Replace" : "Add credential"}
        </button>
        {configured && credential.testable ? (
          <button
            class="btn"
            type="button"
            disabled={busy}
            onClick={() => void testCredential(connector.id)}
          >
            {busy ? "Working…" : "Test"}
          </button>
        ) : null}
        {removable ? (
          <button
            id={`remove-credential-${connector.id}`}
            class="btn danger"
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
          onCancel={() => cancelConfirm(`remove-credential-${connector.id}`)}
        />
      ) : null}
      {editing ? (
        <CredentialForm
          connector={connector.id}
          credential={credential}
          busy={busy}
        />
      ) : null}
      <NoticeLine id={`credentialNotice-${connector.id}`} notice={notice} />
    </section>
  );
}
