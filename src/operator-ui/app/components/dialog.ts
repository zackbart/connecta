import type { View } from "@effect/ui";
import { Dialog as KitDialog } from "@effect/ui-kit";
import type { Html } from "@effect/ui/html";
import { Icon } from "./icons.js";

export const Dialog = <M, C extends View.Children<M>>(
  h: Html.H<M>,
  options: {
    readonly key: string;
    readonly open: boolean;
    readonly title: string;
    readonly description: string;
    readonly drawer?: boolean;
    readonly returnFocus?: boolean;
    readonly onClose: M;
    readonly onClosed?: M;
    readonly children: C;
  },
) =>
  KitDialog(h, {
    key: options.key,
    props: { open: options.open, finalFocus: options.returnFocus !== false },
    onEmit: {
      RequestedOpen: () => undefined,
      RequestedClose: () => options.onClose,
      Settled: ({ open }) => (open ? undefined : options.onClosed),
    },
    view: (dialog) =>
      h.div
        .class("dialog-host")
        .children(
          dialog
            .portal(h.dialog)
            ?.children(
              dialog.backdrop(h.div.class("dialog-overlay")),
              dialog
                .popup(h.div.class("dialog-content", options.drawer === true && "drawer-content"))
                .children(
                  dialog.title(h.h2.class("dialog-title")).children(options.title),
                  dialog.description(h.p.class("dialog-description")).children(options.description),
                  options.children,
                  dialog
                    .close(h.button.class("btn", "quiet", "dialog-close").attr("aria-label", "Close dialog"))
                    .children(Icon(h, "close", 18)),
                ),
            ),
        ),
  });
