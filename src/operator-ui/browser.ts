import {
  filterUiConnectors,
  type CredentialManagementCapability,
  type UiData,
} from "./model.js";

type OperatorPage = "connections" | "credentials" | "activity";

interface BrowserAuth {
  kind: string;
  publishableKey?: string;
  frontendApiUrl?: string;
  signInUrl?: string;
  signUpUrl?: string;
}

interface BrowserClerkSession {
  id?: string;
  getToken(): Promise<string | null>;
}

interface BrowserClerk {
  user?: unknown;
  session?: BrowserClerkSession | null;
  load(options: {
    signInUrl?: string;
    signUpUrl?: string;
    signInFallbackRedirectUrl: string;
    signUpFallbackRedirectUrl: string;
    afterSignOutUrl: string;
  }): Promise<void>;
  addListener(
    listener: (resources: { session?: BrowserClerkSession | null }) => void,
  ): void;
  redirectToSignIn(options: {
    signInFallbackRedirectUrl: string;
    signUpFallbackRedirectUrl: string;
  }): void;
  signOut(options: { redirectUrl: string }): Promise<unknown>;
}

interface UiActivityActor {
  kind?: string;
  id?: string;
  namespace?: string;
  label?: string;
}

interface UiActivityEvent {
  occurredAt: string;
  actor?: UiActivityActor;
  connectorId: string;
  toolName: string;
  address: string;
  source: string;
  outcome: string;
  durationMs: number;
  attempts: number;
  errorCode?: string;
}

interface UiActivityResponse {
  events?: UiActivityEvent[];
  nextCursor?: string;
  error?: string;
}

interface UiActionResponse {
  ok?: boolean;
  message?: string;
  error?: string;
}

interface OperatorElement extends HTMLElement {
  disabled: boolean;
  value: string;
}

declare const AUTH: BrowserAuth;
declare const MCP_URL: string;
declare const INITIAL_PAGE: OperatorPage;
declare const TITLE_SUFFIX: string;
declare const PRODUCT_NAME: string;
declare const PRODUCT_OPERATOR_LABEL: string;
declare const Clerk: BrowserClerk;

declare global {
  interface Window {
    Clerk?: BrowserClerk;
  }
}

const KEY = "connecta:token";
const $ = (id: string): OperatorElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing operator UI element #${id}`);
  return element as OperatorElement;
};
const PAGE_META = {
  connections: { path: "/", label: "Connections" },
  credentials: { path: "/credentials", label: "Credentials" },
  activity: { path: "/activity", label: "Activity" },
} satisfies Record<OperatorPage, { path: string; label: string }>;
let DATA: UiData | null = null;
let ACTIVITY: UiActivityEvent[] = [];
let ACTIVITY_CURSOR: string | null = null;
let ACTIVITY_LOADED = false;
let CURRENT_PAGE: OperatorPage = INITIAL_PAGE;
let SESSION_GENERATION = 0;
let ACTIVITY_GENERATION = 0;
let CLERK_SESSION_ID: string | null = null;
$("mcpUrl").textContent = MCP_URL;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function closestElement<T extends Element>(
  target: EventTarget | null,
  selector: string,
): T | null {
  const candidate = target as { closest?: (value: string) => Element | null } | null;
  return typeof candidate?.closest === "function"
    ? candidate.closest(selector) as T | null
    : null;
}

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// Only http/https may become a clickable href — mirrors the server-side gate
// so a hostile scheme (javascript:, data:) can never be linked. Defense in depth.
function safeHttp(u: string): string | null {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : null;
  } catch { return null; }
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
}

function setNotice(message: string, isError = false): void {
  $("credentialNotice").textContent = message || "";
  $("credentialNotice").classList.toggle("error-notice", Boolean(isError));
  $("credentialNotice").setAttribute("role", isError ? "alert" : "status");
}

function setOauthNotice(message: string, isError = false): void {
  $("oauthNotice").textContent = message || "";
  $("oauthNotice").classList.toggle("error-notice", Boolean(isError));
  $("oauthNotice").setAttribute("role", isError ? "alert" : "status");
}

async function sessionToken(): Promise<string | null | undefined> {
  return AUTH.kind === "clerk"
    ? await Clerk.session?.getToken()
    : localStorage.getItem(KEY);
}

function clearActivityState(): void {
  ACTIVITY_GENERATION += 1;
  ACTIVITY = [];
  ACTIVITY_CURSOR = null;
  ACTIVITY_LOADED = false;
  $("activityList").innerHTML = "";
  $("activityList").setAttribute("aria-busy", "false");
  $("activityNotice").textContent = "";
  $("activityNotice").setAttribute("role", "status");
  $("activitySummary").textContent = "Arguments and results are never stored.";
  $("activitySearch").value = "";
  $("refreshActivity").disabled = false;
  $("moreActivity").disabled = false;
  $("moreActivity").classList.add("hidden");
}

function clearIdentityState(): void {
  SESSION_GENERATION += 1;
  DATA = null;
  clearActivityState();
  $("list").innerHTML = "";
  setOauthNotice("");
  $("filter").value = "";
  $("credentialList").innerHTML = "";
  $("credentialList").setAttribute("aria-busy", "false");
  $("credentialNotice").textContent = "";
  $("credentialNotice").setAttribute("role", "status");
  $("credentialNotice").classList.remove("error-notice");
  $("credentialUnavailable").textContent = "";
  $("credentialUnavailable").classList.add("hidden");
  $("credentialList").classList.add("hidden");
  $("activityUnavailable").classList.add("hidden");
  $("activityAvailable").classList.add("hidden");
  $("credentialsNav").classList.add("hidden");
  $("activityNav").classList.add("hidden");
  $("serverInfo").textContent = PRODUCT_OPERATOR_LABEL;
}

function showGate(msg: string): void {
  clearIdentityState();
  $("app").classList.add("hidden");
  $("appNav").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("err").textContent = msg || "";
  if (AUTH.kind === "clerk") {
    const signedIn = Boolean(window.Clerk && Clerk.user);
    $("gateCopy").textContent = signedIn
      ? "Signed in with Clerk, but this account cannot open deployment-wide operator pages."
      : "Sign in with Clerk to open this operator page.";
    $("signin").classList.toggle("hidden", signedIn);
    $("gateSignout").classList.toggle("hidden", !signedIn);
  } else {
    $("gateCopy").textContent = "";
  }
}

function pageForPath(path: string): OperatorPage {
  if (path === "/credentials") return "credentials";
  if (path === "/activity") return "activity";
  return "connections";
}

function credentialUnavailableCopy(
  capability?: CredentialManagementCapability,
): string {
  if (capability === "no_slots") {
    return "No connectors declare operator-managed credential slots. Connector credentials remain configuration-as-code until a slot is declared.";
  }
  if (capability === "vault_not_configured") {
    return "Credential storage is not configured. Set credentials.encryptionKey before managing connector credentials here.";
  }
  return "Credential management requires an eligible Clerk operator. Bearer-authenticated sessions can inspect connections but cannot manage stored credentials.";
}

function updateCapabilities(): void {
  const credentialsAvailable =
    DATA?.credentialManagement === "available";
  $("credentialsNav").classList.toggle("hidden", !credentialsAvailable);
  $("activityNav").classList.toggle("hidden", !DATA?.activityEnabled);
  $("credentialUnavailable").classList.toggle("hidden", credentialsAvailable);
  $("credentialList").classList.toggle("hidden", !credentialsAvailable);
  $("credentialUnavailable").textContent = credentialsAvailable
    ? ""
    : credentialUnavailableCopy(DATA?.credentialManagement);
  $("activityUnavailable").classList.toggle("hidden", Boolean(DATA?.activityEnabled));
  $("activityAvailable").classList.toggle("hidden", !DATA?.activityEnabled);
}

function activatePage(
  page: OperatorPage,
  options?: { focus?: boolean },
): void {
  const next = PAGE_META[page] ? page : "connections";
  CURRENT_PAGE = next;
  for (const name of Object.keys(PAGE_META)) {
    $(name + "View").classList.toggle("hidden", name !== next);
    const link = $(name + "Nav");
    if (name === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("gateHeading").textContent = PAGE_META[next].label;
  document.title = PAGE_META[next].label + " — " + TITLE_SUFFIX;
  if (DATA) {
    updateCapabilities();
    if (next === "connections") renderConnections();
    if (next === "credentials") renderCredentials();
    if (next === "activity" && DATA.activityEnabled && !ACTIVITY_LOADED) {
      loadActivity(true);
    }
  }
  if (next !== "credentials") {
    $("credentialList").innerHTML = "";
    setNotice("");
  }
  // Focus what is actually on screen. While gated the page views are hidden, so
  // focusing their heading is a silent no-op that drops focus to <body> and
  // restarts the next Tab from the top of the document — the gate's own h1 is
  // the visible heading, and activatePage has just relabelled it.
  if (options?.focus) $(DATA ? next + "Heading" : "gateHeading").focus();
}

function navigateTo(page: OperatorPage, href: string): void {
  history.pushState({ operatorPage: page }, "", href);
  activatePage(page, { focus: true });
}

async function load(): Promise<void> {
  const generation = SESSION_GENERATION;
  let token;
  try {
    token = await sessionToken();
  } catch (error) {
    if (generation !== SESSION_GENERATION) return;
    return showGate(
      "Could not read the Clerk session: " +
        errorMessage(error, "unknown error"),
    );
  }
  if (generation !== SESSION_GENERATION) return;
  if (!token) return showGate("");
  let res;
  try {
    res = await fetch("/ui/data", { headers: { Authorization: "Bearer " + token } });
  } catch (error) {
    if (generation !== SESSION_GENERATION) return;
    return showGate("Network error: " + errorMessage(error, "unknown error"));
  }
  if (generation !== SESSION_GENERATION) return;
  if (res.status === 401 || res.status === 403) {
    if (AUTH.kind === "clerk") {
      return showGate(
        res.status === 403
          ? "This Clerk account is not allowed to access connecta."
          : "Your Clerk session was not accepted. Sign out and try again."
      );
    }
    localStorage.removeItem(KEY);
    return showGate("Token rejected — enter a valid bearer token.");
  }
  if (!res.ok) return showGate("Error " + res.status);
  let data: UiData;
  try {
    data = await res.json() as UiData;
  } catch {
    if (generation !== SESSION_GENERATION) return;
    return showGate("Operator data could not be read.");
  }
  if (generation !== SESSION_GENERATION) return;
  DATA = data;
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("appNav").classList.remove("hidden");
  const si = data.serverInfo || {};
  $("serverInfo").textContent =
    (si.name || PRODUCT_NAME) + " v" + (data.connectaVersion || "?");
  updateCapabilities();
  activatePage(CURRENT_PAGE);
}

function actorLabel(actor?: UiActivityActor): string {
  if (!actor || !actor.kind) return "unknown";
  return actor.label
    ? actor.kind + " · " + actor.label
    : actor.id ? actor.kind + " · " + actor.id : actor.kind;
}

function renderActivity(): void {
  const list = $("activityList");
  list.innerHTML = "";
  const query = $("activitySearch").value.trim().toLowerCase();
  const visible = ACTIVITY.filter((event) => {
    if (!query) return true;
    const actor = event.actor || {};
    return [
      event.address,
      event.connectorId,
      event.toolName,
      event.source,
      event.outcome,
      event.errorCode,
      actor.kind,
      actor.id,
      actor.namespace,
      actor.label,
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
  const uniqueTools = new Set(ACTIVITY.map((event) => event.address)).size;
  $("activitySummary").textContent = ACTIVITY.length
    ? ACTIVITY.length + " loaded call" + (ACTIVITY.length === 1 ? "" : "s") +
      " · " + uniqueTools + " tool" + (uniqueTools === 1 ? "" : "s") +
      " · no arguments or results stored"
    : "Arguments and results are never stored.";
  if (visible.length === 0) {
    list.innerHTML = '<div class="activity-empty">' +
      (query ? "No loaded activity matches this search." :
        "No connector tool calls recorded yet.") + "</div>";
  }
  for (const event of visible) {
    const item = document.createElement("article");
    const outcomeClass = [
      "success",
      "error",
      "timeout",
      "cancelled",
    ].includes(event.outcome) ? event.outcome : "error";
    item.className = "activity-item " + outcomeClass;
    const retryCopy = event.attempts > 1
      ? " · " + esc(event.attempts) + " attempts"
      : "";
    const errorCopy = event.errorCode ? " · " + esc(event.errorCode) : "";
    const actorId = event.actor?.id
      ? (event.actor.namespace
        ? event.actor.namespace + " · " + event.actor.id
        : event.actor.id)
      : "";
    const stableActorId = actorId &&
      (event.actor?.label || event.actor?.namespace)
      ? '<div class="activity-actor-id mono">' + esc(actorId) + "</div>"
      : "";
    item.innerHTML =
      '<div class="activity-stamp"><span class="dot ' +
      (outcomeClass === "success" ? "ok" : "") +
      '" aria-hidden="true"></span><div><time class="activity-time" datetime="' +
      esc(event.occurredAt) + '">' +
      esc(formatDate(event.occurredAt)) +
      '</time><div class="activity-actor">' + esc(actorLabel(event.actor)) +
      "</div>" + stableActorId + "</div></div>" +
      '<div><div class="activity-address">' + esc(event.address) +
      '</div><div class="activity-detail">' + esc(event.source) + retryCopy +
      errorCopy + '</div></div>' +
      '<div><div class="activity-outcome">' + esc(event.outcome) +
      '</div><div class="activity-detail">' + esc(event.durationMs) + ' ms</div></div>';
    list.appendChild(item);
  }
  $("moreActivity").classList.toggle("hidden", !ACTIVITY_CURSOR);
}

async function loadActivity(reset: boolean): Promise<void> {
  if (!DATA?.activityEnabled) return;
  const sessionGeneration = SESSION_GENERATION;
  if (reset) ACTIVITY_GENERATION += 1;
  const activityGeneration = ACTIVITY_GENERATION;
  const isCurrent = () =>
    sessionGeneration === SESSION_GENERATION &&
    activityGeneration === ACTIVITY_GENERATION;
  $("activityNotice").textContent = "Loading activity…";
  $("activityNotice").setAttribute("role", "status");
  $("activityList").setAttribute("aria-busy", "true");
  $("refreshActivity").disabled = true;
  $("moreActivity").disabled = true;
  try {
    const token = await sessionToken();
    if (!isCurrent()) return;
    if (!token) return showGate("Your session has expired.");
    const cursor = reset ? null : ACTIVITY_CURSOR;
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch("/ui/activity?" + params, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!isCurrent()) return;
    let payload: UiActivityResponse = {};
    try {
      payload = await res.json() as UiActivityResponse;
    } catch {
      // The status code below still owns the operator-facing error.
    }
    if (!isCurrent()) return;
    if (res.status === 401) {
      return showGate("Your session was not accepted. Sign in again.");
    }
    if (res.status === 403) {
      clearActivityState();
      $("activityNotice").setAttribute("role", "alert");
      $("activityNotice").textContent =
        "This identity may not read activity history.";
      return;
    }
    if (!res.ok) {
      throw new Error(
        payload.error || "Activity could not be loaded (" + res.status + ")."
      );
    }
    ACTIVITY = reset
      ? (payload.events || [])
      : ACTIVITY.concat(payload.events || []);
    ACTIVITY_CURSOR = payload.nextCursor || null;
    ACTIVITY_LOADED = true;
    $("activityNotice").textContent = "";
    renderActivity();
  } catch (error) {
    if (!isCurrent()) return;
    $("activityNotice").setAttribute("role", "alert");
    $("activityNotice").textContent = errorMessage(
      error,
      "Activity could not be loaded.",
    );
  } finally {
    if (isCurrent()) {
      $("activityList").setAttribute("aria-busy", "false");
      $("refreshActivity").disabled = false;
      $("moreActivity").disabled = false;
    }
  }
}

function renderConnections(): void {
  const data = DATA;
  if (!data) return;
  const q = $("filter").value.trim().toLowerCase();
  const list = $("list");
  list.innerHTML = "";
  for (const filtered of filterUiConnectors(data.connectors, q)) {
    const c = filtered.connector;
    const tools = filtered.tools;
    const el = document.createElement("div");
    el.className = "card";
    const status = c.status === "ok"
      ? "Connected"
      : c.status === "auth_required"
        ? "Authorization needed"
        : "Unavailable";
    let head = '<div class="connector-head"><div><div class="connector-title">' +
      '<span class="dot ' + esc(c.status) + '" aria-hidden="true"></span>' +
      '<h2>' + esc(c.title || c.id) + "</h2></div>";
    if (c.description) {
      head += '<p class="connector-description meta">' + esc(c.description) + "</p>";
    }
    head += '</div><div class="connector-state cap">' + esc(status) + " · " +
      c.toolCount + (c.toolCount === 1 ? " tool" : " tools") +
      '<br><span class="mono">' + esc(c.id) + "</span></div></div>";
    if (c.message) {
      head += '<p class="connector-message msg">' + esc(c.message) + "</p>";
    }
    if (c.authorizationUrl) {
      const safe = safeHttp(c.authorizationUrl);
      head += safe
        ? '<p class="connector-auth"><a class="linklike" href="' + esc(safe) +
          '" target="_blank" rel="noopener">Authorize connector →</a></p>'
        : '<p class="connector-auth meta">Authorization URL: ' +
          esc(c.authorizationUrl) + "</p>";
    }
    if (c.oauth && data.oauthManagement) {
      const oauthName = c.title || c.id;
      head += '<div class="credential-actions">';
      head += '<button type="button" class="linklike danger" ' +
        'aria-label="Disconnect OAuth for ' + esc(oauthName) + '" ' +
        'data-oauth-action="disconnect" data-connector="' + esc(c.id) +
        '">Disconnect OAuth</button>';
      head += '<button type="button" class="linklike" ' +
        'aria-label="' + (c.status === "ok" ? "Reconnect OAuth for " :
          "Restart authorization for ") + esc(oauthName) + '" ' +
        'data-oauth-action="reconnect" data-connector="' + esc(c.id) +
        '">' + (c.status === "ok" ? "Reconnect OAuth" : "Restart authorization") +
        "</button></div>";
    }
    if (c.credential) {
      head += '<p class="connector-auth"><a class="linklike" href="/credentials" ' +
        'data-operator-page="credentials">Manage credential →</a></p>';
    }
    let body = "";
    if (tools.length) {
      body = "<details" + (q ? " open" : "") +
        '><summary class="linklike">Show tools (' + tools.length + ")</summary>" +
        '<div class="tool-list">';
      for (const t of tools) {
        body += '<div class="tool"><code>' + esc(t.address) + "</code>";
        if (t.description) body += '<span class="td">' + esc(t.description) + "</span>";
        body += "</div>";
      }
      body += "</div></details>";
    }
    el.innerHTML = head + body;
    list.appendChild(el);
  }
  if (!list.children.length) {
    list.innerHTML = '<p class="empty">' +
      (q
        ? "No connectors or tools match this filter."
        : "No connectors are declared in this deployment.") +
      "</p>";
  }
}

async function operatorRequest(
  path: string,
  method: "DELETE" | "POST" | "PUT",
  generation: number,
  body?: object,
): Promise<UiActionResponse | null> {
  const token = await sessionToken();
  if (generation !== SESSION_GENERATION) {
    throw new Error("The operator session changed.");
  }
  if (!token) throw new Error("Your Clerk session has expired.");
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  let payload: UiActionResponse = {};
  try {
    payload = await res.json() as UiActionResponse;
  } catch {
    // The status code below still owns the operator-facing error.
  }
  if (!res.ok) throw new Error(payload.error || "Request failed (" + res.status + ").");
  return payload;
}

$("list").onclick = async (event) => {
  const button = closestElement<HTMLButtonElement>(
    event.target,
    "[data-oauth-action]",
  );
  if (!button) return;
  const connector = button.dataset.connector;
  const action = button.dataset.oauthAction;
  if (!connector || (action !== "disconnect" && action !== "reconnect")) return;
  const generation = SESSION_GENERATION;
  const question = action === "disconnect"
    ? "Disconnect OAuth for " + connector +
      "? Stored credentials and any pending authorization will be removed."
    : "Restart OAuth for " + connector +
      "? Stored credentials and any pending authorization will be replaced.";
  if (!window.confirm(question)) return;

  setOauthNotice("");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(
    '[data-connector="' + CSS.escape(connector) + '"]'
  )];
  buttons.forEach((item) => { item.disabled = true; });
  try {
    const result = await operatorRequest(
      "/ui/oauth/" + encodeURIComponent(connector),
      action === "disconnect" ? "DELETE" : "POST",
      generation,
    );
    if (generation !== SESSION_GENERATION) return;
    await load();
    if (generation !== SESSION_GENERATION) return;
    setOauthNotice(
      action === "disconnect"
        ? "OAuth disconnected. Restart authorization when you are ready to reconnect."
        : result?.message ||
          "Authorization restarted. Open the authorization link to reconnect.",
    );
    $("oauthNotice").focus();
  } catch (error) {
    if (generation !== SESSION_GENERATION) return;
    // A reset can publish its durable epoch before best-effort physical cleanup
    // reports failure. Refresh so stale tools/health/actions never survive that
    // partial success, while preserving the original error for the operator.
    try {
      await load();
    } catch {
      // The mutation error is the actionable one; load() already owns its gate.
    }
    if (generation !== SESSION_GENERATION) return;
    setOauthNotice(errorMessage(error, "OAuth action failed."), true);
    $("oauthNotice").focus();
  } finally {
    if (generation === SESSION_GENERATION) {
      buttons.forEach((item) => { item.disabled = false; });
    }
  }
};

function renderCredentials(): void {
  const data = DATA;
  if (!data) return;
  const list = $("credentialList");
  list.innerHTML = "";
  if (data.credentialManagement !== "available") return;
  for (const c of data.connectors) {
    const cred = c.credential;
    if (!cred) continue;
    const configured = Boolean(cred.configured);
    const removable = configured || Boolean(cred.removable);
    const state = configured
      ? cred.fields?.length
        ? "configured"
        : "configured · ••••" + esc(cred.lastFour || "")
      : "not configured";
    const updated = configured && cred.updatedAt
      ? " · updated " + esc(formatDate(cred.updatedAt))
      : "";
    const el = document.createElement("section");
    el.className = "credential-card";
    el.id = "credential-" + c.id;
    el.setAttribute("aria-labelledby", "credential-title-" + c.id);
    let body = '<div class="credential-head"><div class="connector-title">' +
      '<span class="dot ' + (configured ? "ok" : "auth_required") +
      '" aria-hidden="true"></span><h2 id="credential-title-' + esc(c.id) + '">' +
      esc(c.title || c.id) + '</h2></div><span class="credential-state">' +
      state + updated + "</span></div>";
    body += '<p class="mono">' + esc(c.id) + " · " + esc(cred.label) + "</p>";
    if (cred.description) {
      body += '<p class="credential-copy meta">' + esc(cred.description) + "</p>";
    }
    if (cred.fields?.length) {
      body += '<div class="credential-field-summary">';
      for (const field of cred.fields) {
        const fieldState = field.configured
          ? "configured · ••••" + esc(field.lastFour || "") +
            (field.updatedAt ? " · updated " + esc(formatDate(field.updatedAt)) : "")
          : "not configured";
        body += '<div><span>' + esc(field.label) +
          '</span><span class="meta">' + fieldState + "</span></div>";
      }
      body += "</div>";
    }
    if (cred.error) body += '<div class="msg">' + esc(cred.error) + "</div>";
    // Leftover stored fields are not an error — the credential still works, so
    // this stays muted copy rather than the msg block an actual failure earns.
    if (cred.notice) {
      body += '<p class="credential-copy meta">' + esc(cred.notice) + "</p>";
    }
    body += '<div class="credential-actions">';
    body += '<button class="linklike" type="button" data-credential-action="edit" data-connector="' +
      esc(c.id) + '">' + (removable ? "Replace" : "Add credential") + "</button>";
    if (configured && cred.testable) {
      body += '<button class="linklike" type="button" data-credential-action="test" data-connector="' +
        esc(c.id) + '">Test</button>';
    }
    if (removable) {
      body += '<button type="button" class="linklike danger" data-credential-action="remove" data-connector="' +
        esc(c.id) + '">Remove</button>';
    }
    body += "</div>";
    body += '<div class="credential-form hidden" data-credential-form="' +
      esc(c.id) + '">';
    if (cred.fields && cred.fields.length) {
      body += '<div class="credential-fields">';
      for (const [index, field] of cred.fields.entries()) {
        const inputId = "credential-input-" + c.id + "-" + index;
        body += '<div class="credential-field"><label for="' + esc(inputId) + '">' +
          esc(field.label) + '</label><input id="' + esc(inputId) + '" type="' +
          esc(field.inputType || "password") + '" data-credential-field="' +
          esc(field.name) + '" placeholder="' + esc(field.placeholder || field.label) +
          '" autocomplete="' +
          (field.inputType === "password" ? "new-password" : "off") +
          '" autocapitalize="none" spellcheck="false"></div>';
      }
      body += "</div>";
    } else {
      const inputId = "credential-input-" + c.id;
      body += '<label class="visually-hidden" for="' + esc(inputId) + '">' +
        esc(cred.label) + '</label><input id="' + esc(inputId) +
        '" type="password" data-credential-input="' +
        esc(c.id) + '" aria-label="' + esc(cred.label) + '" placeholder="' +
        esc(cred.placeholder || "Paste credential") +
        '" autocomplete="new-password" autocapitalize="none" spellcheck="false">';
    }
    body += '<button class="linklike" type="button" data-credential-action="save" data-connector="' +
      esc(c.id) + '">Save</button><button class="linklike" type="button" data-credential-action="cancel" data-connector="' +
      esc(c.id) + '">Cancel</button></div>';
    el.innerHTML = body;
    list.appendChild(el);
  }
}

async function credentialRequest(
  connector: string,
  method: "DELETE" | "POST" | "PUT",
  action: "" | "test",
  body: { value: string } | { values: Record<string, string> } | null,
  generation: number,
): Promise<UiActionResponse | null> {
  const suffix = action ? "/" + action : "";
  return operatorRequest(
    "/ui/credentials/" + encodeURIComponent(connector) + suffix,
    method,
    generation,
    body ?? undefined,
  );
}

function credentialForm(connector: string): HTMLElement {
  const form = document.querySelector<HTMLElement>(
    '[data-credential-form="' + CSS.escape(connector) + '"]',
  );
  if (!form) throw new Error("Credential form is unavailable.");
  return form;
}

$("credentialList").onclick = async (event) => {
  const button = closestElement<HTMLButtonElement>(
    event.target,
    "[data-credential-action]",
  );
  if (!button) return;
  const connector = button.dataset.connector;
  const action = button.dataset.credentialAction;
  if (!connector || !action) return;
  const form = credentialForm(connector);
  const generation = SESSION_GENERATION;

  if (action === "edit") {
    form.classList.remove("hidden");
    form.querySelector("input")?.focus();
    return;
  }
  if (action === "cancel") {
    form.querySelectorAll("input").forEach((input) => { input.value = ""; });
    form.classList.add("hidden");
    document.querySelector<HTMLButtonElement>(
      '[data-credential-action="edit"][data-connector="' +
      CSS.escape(connector) + '"]'
    )?.focus();
    return;
  }
  if (action === "remove" && !window.confirm(
    "Remove this credential? The connector will stop authenticating until a replacement is added."
  )) return;

  setNotice("");
  $("credentialList").setAttribute("aria-busy", "true");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(
    '[data-connector="' + CSS.escape(connector) + '"]'
  )];
  buttons.forEach((item) => { item.disabled = true; });
  try {
    if (action === "save") {
      const fieldInputs = [
        ...form.querySelectorAll<HTMLInputElement>("[data-credential-field]"),
      ];
      if (fieldInputs.length) {
        const values: Record<string, string> = {};
        for (const input of fieldInputs) {
          const value = input.value.trim();
          if (!value) throw new Error("Complete every credential field before saving.");
          const field = input.dataset.credentialField;
          if (!field) throw new Error("Credential field is unnamed.");
          values[field] = value;
        }
        await credentialRequest(connector, "PUT", "", { values }, generation);
      } else {
        const input = form.querySelector<HTMLInputElement>(
          "[data-credential-input]",
        );
        if (!input) throw new Error("Credential input is unavailable.");
        const value = input.value.trim();
        if (!value) throw new Error("Paste a credential before saving.");
        await credentialRequest(connector, "PUT", "", { value }, generation);
      }
      if (generation !== SESSION_GENERATION) return;
      form.querySelectorAll<HTMLInputElement>("input")
        .forEach((input) => { input.value = ""; });
      setNotice("Credential saved.");
      await load();
      if (generation !== SESSION_GENERATION) return;
      $("credentialNotice").focus();
    } else if (action === "remove") {
      await credentialRequest(connector, "DELETE", "", null, generation);
      if (generation !== SESSION_GENERATION) return;
      setNotice("Credential removed.");
      await load();
      if (generation !== SESSION_GENERATION) return;
      $("credentialNotice").focus();
    } else if (action === "test") {
      const result = await credentialRequest(
        connector,
        "POST",
        "test",
        null,
        generation,
      );
      if (generation !== SESSION_GENERATION) return;
      setNotice(
        result?.message ||
          (result?.ok ? "Credential is valid." : "Credential test failed."),
        !result?.ok,
      );
    }
  } catch (error) {
    if (generation !== SESSION_GENERATION) return;
    setNotice(errorMessage(error, "Credential action failed."), true);
  } finally {
    if (generation === SESSION_GENERATION) {
      $("credentialList").setAttribute("aria-busy", "false");
      buttons.forEach((item) => { item.disabled = false; });
    }
  }
};

$("save").onclick = async () => {
  const v = $("token").value.trim();
  if (!v) return;
  clearIdentityState();
  localStorage.setItem(KEY, v);
  $("token").value = "";
  await load();
  if (DATA) $(CURRENT_PAGE + "Heading").focus();
};
$("change").onclick = () => {
  localStorage.removeItem(KEY);
  showGate("");
  $("token").focus();
};
$("copyMcpUrl").onclick = async () => {
  const button = $("copyMcpUrl");
  try {
    await navigator.clipboard.writeText(MCP_URL);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => { button.textContent = "Copy URL"; }, 1600);
};
$("signin").onclick = () => Clerk.redirectToSignIn({
  signInFallbackRedirectUrl: window.location.href,
  signUpFallbackRedirectUrl: window.location.href,
});
function signOut(): Promise<unknown> {
  clearIdentityState();
  return Clerk.signOut({ redirectUrl: window.location.href });
}
$("gateSignout").onclick = signOut;
$("signout").onclick = signOut;
$("filter").oninput = () => { if (DATA) renderConnections(); };
$("refreshActivity").onclick = () => loadActivity(true);
$("moreActivity").onclick = () => loadActivity(false);
$("activitySearch").oninput = () => renderActivity();
document.addEventListener("click", (event) => {
  const link = closestElement<HTMLAnchorElement>(
    event.target,
    "a[data-operator-page]",
  );
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  const target = new URL(link.href, window.location.href);
  if (target.origin !== window.location.origin) return;
  const page = link.dataset.operatorPage;
  if (
    page !== "connections" &&
    page !== "credentials" &&
    page !== "activity"
  ) return;
  event.preventDefault();
  navigateTo(page, target.pathname + target.search + target.hash);
});
window.addEventListener("popstate", () => {
  activatePage(pageForPath(window.location.pathname), { focus: true });
});

async function init(): Promise<void> {
  if (AUTH.kind === "clerk") {
    $("clerkGate").classList.remove("hidden");
    $("signout").classList.remove("hidden");
    try {
      if (!window.Clerk) {
        return showGate("Clerk could not load. Check your network and try again.");
      }
      await Clerk.load({
        ...(AUTH.signInUrl ? { signInUrl: AUTH.signInUrl } : {}),
        ...(AUTH.signUpUrl ? { signUpUrl: AUTH.signUpUrl } : {}),
        signInFallbackRedirectUrl: window.location.href,
        signUpFallbackRedirectUrl: window.location.href,
        afterSignOutUrl: window.location.href,
      });
      CLERK_SESSION_ID = Clerk.session?.id ?? null;
      Clerk.addListener((resources) => {
        const nextSessionId = resources.session?.id ?? null;
        if (nextSessionId === CLERK_SESSION_ID) return;
        CLERK_SESSION_ID = nextSessionId;
        // Clerk has already updated its public session before notifying
        // listeners. Clear synchronously so stale identity-scoped data cannot
        // be repainted while the replacement identity is being fetched.
        showGate("");
        void load();
      });
    } catch (error) {
      return showGate(
        "Clerk could not initialize: " +
          errorMessage(error, "unknown error"),
      );
    }
  } else {
    $("tokenGate").classList.remove("hidden");
    $("change").classList.remove("hidden");
  }
  activatePage(pageForPath(window.location.pathname));
  await load();
}

if (AUTH.kind === "clerk") {
  window.addEventListener("load", init);
} else {
  init();
}
