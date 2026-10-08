import type { ComponentProps, ReactNode, RefObject } from "react";
import { Slot } from "@radix-ui/react-slot";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";

function classes(...values: (string | undefined)[]) { return values.filter(Boolean).join(" "); }
export function Button({ className, variant = "default", asChild, ...props }: ComponentProps<"button"> & {
  variant?: "default" | "primary" | "quiet" | "danger"; asChild?: boolean;
}) {
  const Component = asChild ? Slot : "button";
  return <Component className={classes("btn", variant, className)} {...props} />;
}
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={classes("input", className)} {...props} />;
}
export function Dialog({ open, onOpenChange, title, description, children, returnFocusTo }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string;
  description: string; children: ReactNode; returnFocusTo: RefObject<HTMLElement | null>;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className="dialog-content"
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocusTo.current?.isConnected) returnFocusTo.current.focus(); }}>
        <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-sm text-muted">{description}</DialogPrimitive.Description>
        {children}
        <DialogPrimitive.Close asChild><Button variant="quiet" className="dialog-close" aria-label="Close dialog">×</Button></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
export function Tabs({ value, onValueChange, items }: {
  value: string; onValueChange: (value: string) => void;
  items: { value: string; label: string; content: ReactNode }[];
}) {
  return <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
    <TabsPrimitive.List className="tabs-list" aria-label="Color scheme">
      {items.map(item => <TabsPrimitive.Trigger key={item.value} value={item.value} className="tabs-trigger">{item.label}</TabsPrimitive.Trigger>)}
    </TabsPrimitive.List>
    {items.map(item => <TabsPrimitive.Content key={item.value} value={item.value} className="tabs-content">{item.content}</TabsPrimitive.Content>)}
  </TabsPrimitive.Root>;
}
/** Dense semantic table; callers own columns and data, never capability. */
export function DataTable<T>({ data, columns, label }: { data: T[]; columns: ColumnDef<T>[]; label: string }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  return <div className="table-scroll"><table className="data-table" aria-label={label}>
    <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>
      {group.headers.map(header => <th key={header.id} scope="col">{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>)}
    </tr>)}</thead>
    <tbody>{table.getRowModel().rows.map(row => <tr key={row.id}>
      {row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
