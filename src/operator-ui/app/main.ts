import { BrowserHost, BrowserRouter } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { auth, initialPage, productName, TOKEN_KEY } from "./config.js";
import { launch } from "./run.js";
import { operatorServicesLayer } from "./services/layer.js";
import type { OperatorPage } from "../view.js";
import { OperatorContent, operatorContentProps } from "./shell/content.js";
import { IslandRequests } from "./shell/island.js";
import { OperatorNav } from "./shell/nav.js";
import { currentView } from "./shell/operator-view.js";
import { OperatorRoute } from "./shell/routes.js";

const host = (id: string) => {
  const element = document.getElementById(id);
  if (element) element.textContent = "";
  return element;
};

const nav = host("operatorNav");
const content = host("operatorContent");

const platform = Layer.mergeAll(
  BrowserRouter.layer({ routes: OperatorRoute, announce: false, focus: false }),
  IslandRequests.layer,
  operatorServicesLayer({ auth, initialPage: initialPage as OperatorPage, productName, tokenKey: TOKEN_KEY }),
);

const mounts = Layer.mergeAll(
  nav
    ? BrowserHost.mount(
        OperatorNav,
        Effect.map(currentView, (view) => ({ view })),
        nav,
        { head: false },
      )
    : Layer.empty,
  content ? BrowserHost.mount(OperatorContent, operatorContentProps, content) : Layer.empty,
);

launch(Layer.provide(mounts, platform));
