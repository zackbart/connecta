import { ConnectorCallError } from "../errors.js";

/** A local destination guard proved that no OAuth HTTP request left. */
export class OAuthRequestNotSentError extends ConnectorCallError {}
