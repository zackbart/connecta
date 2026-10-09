/** Shared transport policy, independent of any optional executor implementation. */
export const PROGRAM_RESULT_INLINE_BYTES = 1024 * 1024;
/** Leave room for the bridge envelope and six-character JSON escapes per byte. */
export const PROGRAM_RESULT_PAGE_BYTES = 32 * 1024;
export const PROGRAM_RESULT_WIRE_BYTES = 240 * 1024;

/** Host-issued paging metadata; callers must still pass the live access checks. */
export type { GuestResultHandle as ProgramResultHandle } from "./guest-types.js";
