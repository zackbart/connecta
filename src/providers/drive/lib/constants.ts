/** The API and upload roots remain separately confined. */
export const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
/** Full Drive access as the delegated user; narrower scopes cannot serve these writes. */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"] as const;
/** Drive's export ceiling is 10 MB. */
export const DRIVE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
