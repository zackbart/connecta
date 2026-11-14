import type { ReactNode } from "react";
import { Card } from "./primitives.js";

type Width = "xs" | "sm" | "md" | "lg" | "full";

export function Skeleton({ width = "md", className }: { width?: Width; className?: string }) {
  return <span className={`skeleton w-${width}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

function LoadingNote({ children = "Loading configuration…" }: { children?: ReactNode }) {
  return (
    <p className="visually-hidden" role="status">
      {children}
    </p>
  );
}

export function ConnectorCardSkeleton({
  title,
  id,
  description,
}: {
  title?: ReactNode;
  id?: string;
  description?: string;
}) {
  return (
    <li className="connector-card pending" aria-busy="true">
      <div className="connector-card-top">
        <div className="connector-card-name">
          <h3>{title ?? <Skeleton width="lg" />}</h3>
          <span className="connector-card-sub">
            {id ? <code title={id}>{id}</code> : <Skeleton width="sm" />}
            <Skeleton width="xs" className="skeleton-badge" />
          </span>
        </div>
        <Skeleton width="sm" className="skeleton-pill" />
      </div>
      {description !== undefined ? <p className="connector-card-description">{description}</p> : null}
      <div className="tool-split">
        <span className="tool-split-total">
          <Skeleton width="sm" />
        </span>
        <span className="skeleton skeleton-bar" aria-hidden="true" />
      </div>
      <div className="connector-card-foot">
        <span className="connector-card-last">
          <span className="meta">Last call</span> <Skeleton width="xs" />
        </span>
      </div>
    </li>
  );
}

export function ConnectorsSkeleton() {
  return (
    <section className="section" aria-busy="true">
      <LoadingNote />
      <div className="connector-toolbar" aria-hidden="true">
        <Skeleton width="lg" className="skeleton-control" />
        <Skeleton width="lg" className="skeleton-control" />
      </div>
      <ul className="connector-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <ConnectorCardSkeleton key={index} />
        ))}
      </ul>
    </section>
  );
}

function StatSkeleton({ label }: { label: string }) {
  return (
    <Card className="overview-stat" aria-label={label}>
      <div className="stat-head">
        <h2 className="stat-label">{label}</h2>
      </div>
      <p className="stat-number">
        <Skeleton width="sm" />
      </p>
      <div className="stat-bar" aria-hidden="true">
        <span className="skeleton" />
      </div>
      <ul className="stat-legend" aria-hidden="true">
        <li>
          <Skeleton width="md" />
        </li>
      </ul>
    </Card>
  );
}

export function PendingLine({ children }: { children: ReactNode }) {
  return (
    <div className="attention-pending" role="status">
      <span className="attention-icon" aria-hidden="true">
        <span className="spinner" />
      </span>
      <h3>{children}</h3>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div aria-busy="true">
      <LoadingNote />
      <div className="overview-stats">
        <StatSkeleton label="Connectors" />
        <StatSkeleton label="Endpoints" />
        <StatSkeleton label="People · Agents" />
      </div>
      <Card className="overview-section overview-attention" title="Needs attention" titleId="attentionHeading">
        <div className="attention-pending" aria-hidden="true">
          <span className="attention-icon skeleton" />
          <Skeleton width="lg" />
        </div>
      </Card>
      <Card className="overview-section overview-map" title="Who reaches what" titleId="mapHeading">
        <div className="skeleton skeleton-map" aria-hidden="true" />
      </Card>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <Card className="skeleton-page" aria-busy="true">
      <LoadingNote />
      {(["lg", "md", "full", "md"] as const).map((width, index) => (
        <div key={index} className="skeleton-row" aria-hidden="true">
          <Skeleton width={width} />
        </div>
      ))}
    </Card>
  );
}
