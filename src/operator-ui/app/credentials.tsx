import { useState } from "preact/hooks";
import type { UiConnector } from "../model.js";
import {
  credentialStateLabel,
  formatDate,
} from "../view.js";
import {
  editCredential,
  refuseCredential,
  removeCredential,
  saveCredential,
  testCredential,
} from "./store.js";

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
      if (!value) return refuseCredential("Paste a credential before saving.");
      return void saveCredential(connector, { value });
    }
    const entries: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.name] ?? "").trim();
      if (!value) {
        return refuseCredential(
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
      <button class="linklike" type="button" disabled={busy} onClick={submit}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        class="linklike"
        type="button"
        disabled={busy}
        onClick={() => editCredential(null)}
      >
        Cancel
      </button>
    </div>
  );
}

export function CredentialCard({
  connector,
  credential,
  editing,
  busy,
}: {
  connector: UiConnector;
  credential: Credential;
  editing: boolean;
  busy: boolean;
}) {
  const configured = Boolean(credential.configured);
  const removable = configured || Boolean(credential.removable);
  return (
    <section
      class="credential-card"
      id={`credential-${connector.id}`}
      aria-labelledby={`credential-title-${connector.id}`}
    >
      <div class="credential-head">
        <div class="connector-title">
          <h2 id={`credential-title-${connector.id}`}>
            {credential.label}
          </h2>
        </div>
        <span class="credential-state">{credentialStateLabel(credential)}</span>
      </div>
      {credential.description ? (
        <p class="credential-copy meta">{credential.description}</p>
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
      {credential.error ? <div class="msg">{credential.error}</div> : null}
      {/* Leftover stored fields are not an error — the credential still works,
          so this stays muted copy rather than the msg block a failure earns. */}
      {credential.notice ? (
        <p class="credential-copy meta">{credential.notice}</p>
      ) : null}
      <div class="credential-actions">
        <button
          class="linklike"
          type="button"
          disabled={busy}
          onClick={() => editCredential(editing ? null : connector.id)}
        >
          {removable ? "Replace" : "Add credential"}
        </button>
        {configured && credential.testable ? (
          <button
            class="linklike"
            type="button"
            disabled={busy}
            onClick={() => void testCredential(connector.id)}
          >
            {busy ? "Working…" : "Test"}
          </button>
        ) : null}
        {removable ? (
          <button
            class="linklike danger"
            type="button"
            disabled={busy}
            onClick={() => void removeCredential(connector.id)}
          >
            Remove
          </button>
        ) : null}
      </div>
      {editing ? (
        <CredentialForm
          connector={connector.id}
          credential={credential}
          busy={busy}
        />
      ) : null}
    </section>
  );
}
