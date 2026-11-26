import type { ReactNode } from "react";
import { Card } from "./primitives.js";

type Width = "xs" | "sm" | "md" | "lg" | "full";

function Skeleton({ width = "md", className }: { width?: Width; className?: string }) {
  return <span className={`skeleton w-${width}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

function LoadingNote({ children = "Loading configuration…" }: { children?: ReactNode }) {
  return (
    <p className="visually-hidden" role="status">
      {children}
    </p>
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
