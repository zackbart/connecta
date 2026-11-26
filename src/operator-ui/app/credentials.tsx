import { useState } from "react";
import { editCredential, refuseCredential, saveCredential } from "./bridge.js";

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
