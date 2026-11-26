import { Layer } from "effect";
import { OperatorApi } from "./api.js";
import { ConnectorHealth } from "./health.js";
import { operatorControllerLayer } from "./operator.js";
import {
  BrowserStorage,
  BrowserWindow,
  ClerkClient,
  ShellConfig,
  Transport,
  type ShellConfigShape,
} from "./platform.js";
import { OperatorStore } from "./store.js";

const browserPlatformLayer = Layer.mergeAll(ClerkClient.layer, BrowserWindow.layer, Transport.layer);

export const operatorServicesLayer = (
  config: ShellConfigShape,
  platform: Layer.Layer<ClerkClient | BrowserWindow | Transport> = browserPlatformLayer,
) => {
  const base = Layer.mergeAll(Layer.succeed(ShellConfig, config), platform);
  const state = Layer.mergeAll(BrowserStorage.layer, OperatorStore.layer).pipe(Layer.provideMerge(base));
  const controller = operatorControllerLayer.pipe(
    Layer.provideMerge(OperatorApi.layer.pipe(Layer.provideMerge(state))),
  );
  return ConnectorHealth.layer.pipe(Layer.provideMerge(controller));
};
