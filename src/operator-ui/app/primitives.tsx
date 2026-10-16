import type { ComponentProps, ReactNode, RefObject } from "react";
import { Slot } from "@radix-ui/react-slot";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Icon } from "./icons.js";

function classes(...values: (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}
export function Button({
  className,
  variant = "default",
  size,
  asChild,
  ...props
}: ComponentProps<"button"> & {
  variant?: "default" | "primary" | "quiet" | "danger";
  /** `sm` for actions inside a row or card; the default is a page action. */
  size?: "sm";
  asChild?: boolean;
}) {
  const Component = asChild ? Slot : "button";
  return <Component className={classes("btn", variant, size, className)} {...props} />;
}
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={classes("input", className)} {...props} />;
}
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  returnFocusTo,
  drawer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  drawer?: boolean;
  children: ReactNode;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className={drawer ? "dialog-content drawer-content" : "dialog-content"}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // While the recovery banner is up its Retry is the one way on; the
            // control that opened this dialog is behind the inert page.
            const retry = document.getElementById("recoveryRetry");
            if (retry) retry.focus();
            else if (returnFocusTo.current?.isConnected) returnFocusTo.current.focus();
          }}
        >
          <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">{description}</DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close asChild>
            <Button variant="quiet" className="dialog-close" aria-label="Close dialog">
              <Icon name="close" size={18} />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Tabs({
  value,
  onValueChange,
  items,
  label = "Color scheme",
  variant = "underline",
}: {
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string; content: ReactNode }[];
  /** Page sections sit on an underline; a small choice inside a dialog is a segmented control. */
  variant?: "underline" | "segmented";
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List
        className={classes("tabs-list", variant === "segmented" ? "segmented" : undefined)}
        aria-label={label}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger key={item.value} value={item.value} className="tabs-trigger">
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="tabs-content">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
/**
 * A surface that groups one thing: soft border, white fill, a little lift.
 * The optional head names it; the body is the caller's.
 */
export function Card({
  title,
  titleId,
  description,
  actions,
  children,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={classes("card", className)} {...props}>
      {title ? (
        <div className="card-head">
          <div className="card-heading">
            <h2 {...(titleId ? { id: titleId } : {})}>{title}</h2>
            {description ? <p className="meta">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

/**
 * Two to four mutually exclusive views or filters, one pressed. Only for
 * choosing what the page shows: configuration is never edited here.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Dense semantic table; callers own columns and data, never capability. */
export function DataTable<T>({ data, columns, label }: { data: T[]; columns: ColumnDef<T>[]; label: string }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="table-scroll">
      <table className="data-table" aria-label={label}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id} scope="col">
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
