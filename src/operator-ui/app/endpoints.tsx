import { Fragment, useState, type ReactNode, type RefObject } from "react";
import type { EndpointAudience } from "../endpoints.js";
import { clientSetupCommands, type ClientSetupCommand } from "../setup-commands.js";
import { CopyButton } from "./parts.js";
import { Dialog, SegmentedControl } from "./primitives.js";

/** What the client setup drawer needs: an endpoint's label, its absolute URL, and the name a client files it under. */
export interface SetupTarget {
  label: string;
  url: string;
  name: string;
}

export function EndpointLine({ url, label, kind }: { url: string; label: string; kind?: EndpointAudience }) {
  return (
    <div className={kind === "agents" ? "endpoint endpoint-agent" : "endpoint"}>
      {kind ? <span className="endpoint-kind">{kind === "agents" ? "Agents" : "People"}</span> : null}
      <code>{breakable(url)}</code>
      <CopyButton
        value={url}
        label="Copy URL"
        icon
        ariaLabel={kind === "agents" ? `Copy agent URL for ${label}` : `Copy URL for ${label}`}
      />
    </div>
  );
}

/** A URL that wraps only after a slash, never inside a word. */
function breakable(url: string): ReactNode[] {
  return url.split(/(?<=\/)(?!\/)/).map((part, index) => (
    <Fragment key={index}>
      {index ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

const CLIENT_LABELS: Record<ClientSetupCommand["id"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  json: "JSON",
};

export function ClientSetupDialog({
  target,
  onClose,
  returnFocus,
}: {
  target: SetupTarget | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [client, setClient] = useState<ClientSetupCommand["id"]>("claude");
  const commands = target ? clientSetupCommands(target.name, target.url) : [];
  const command = commands.find((candidate) => candidate.id === client) ?? commands[0];
  return (
    <Dialog
      drawer
      returnFocusTo={returnFocus}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Client setup"
      description={target?.label ?? ""}
    >
      {target && command ? (
        <section className="setup-list">
          <EndpointLine url={target.url} label={target.label} />
          <SegmentedControl
            label="Client"
            value={command.id}
            options={commands.map((candidate) => ({ value: candidate.id, label: CLIENT_LABELS[candidate.id] }))}
            onChange={setClient}
          />
          <div className="setup-item" data-setup={command.id}>
            <pre className="setup-code">{command.text}</pre>
            <CopyButton
              value={command.text}
              label="Copy"
              icon
              className="btn sm copy-btn setup-copy"
              ariaLabel={`Copy ${command.label} setup for ${target.label}`}
            />
          </div>
        </section>
      ) : null}
    </Dialog>
  );
}
