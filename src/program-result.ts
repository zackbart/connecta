/** Shared transport policy, independent of any optional executor implementation. */
export const PROGRAM_RESULT_INLINE_BYTES = 1024 * 1024;
/** Leave room for the bridge envelope and six-character JSON escapes per byte. */
export const PROGRAM_RESULT_PAGE_BYTES = 32 * 1024;
export const PROGRAM_RESULT_WIRE_BYTES = 240 * 1024;
/** What `connecta.result(id, { all: true })` delivers unless the executor says less. */
export const PROGRAM_RESULT_READ_BYTES = 1.5 * 1024 * 1024;
/**
 * Read bytes one run holds in memory for its guest at once: four whole transfers, and
 * 8 MiB of a Worker isolate at the Dynamic Worker's two concurrent runs.
 */
const PROGRAM_TRANSFER_MEMORY_BYTES = 4 * 1024 * 1024;

export interface MemoryTransfer {
  readonly kind: "memory";
  bytes: Uint8Array | undefined;
  offset: number;
  finished?: boolean;
}

/** A run's read bytes held for its guest, each until it is paged and all once the run ends. */
export class TransferMemory {
  private held = 0;
  private closed = false;
  private readonly transfers = new Set<MemoryTransfer>();

  constructor(
    private readonly limitBytes: number = PROGRAM_TRANSFER_MEMORY_BYTES,
    signal?: AbortSignal,
  ) {
    const close = () => {
      this.closed = true;
      for (const transfer of this.transfers) this.release(transfer);
    };
    if (signal?.aborted) close();
    else signal?.addEventListener("abort", close, { once: true });
  }

  get heldBytes(): number {
    return this.held;
  }

  /** Holds `bytes`, or refuses past the limit and once the run has ended. */
  hold(bytes: Uint8Array): MemoryTransfer | undefined {
    if (this.closed || this.held + bytes.length > this.limitBytes) return undefined;
    const transfer: MemoryTransfer = { kind: "memory", bytes, offset: 0 };
    this.held += bytes.length;
    this.transfers.add(transfer);
    return transfer;
  }

  release(transfer: MemoryTransfer): void {
    if (!this.transfers.delete(transfer) || !transfer.bytes) return;
    this.held -= transfer.bytes.length;
    transfer.bytes = undefined;
  }
}

/** Host-issued paging metadata; callers must still pass the live access checks. */
export type { GuestResultHandle as ProgramResultHandle } from "./guest-types.js";
