/** Thrown by decodeFrame for empty or truncated frames. */
export class ProtocolDecodeError extends Error {
  override readonly name: string = 'ProtocolDecodeError';
  constructor(
    message: string,
    /** Frame code (byte 0), or -1 for an empty frame. */
    readonly code: number,
    /** Bytes required to decode the field that failed. */
    readonly needed: number,
    /** Actual frame length. */
    readonly actual: number,
  ) {
    super(message);
  }
}

/** Thrown by encodeCommand for inputs the firmware cannot accept (bad field sizes, frame > 176). */
export class ProtocolEncodeError extends Error {
  override readonly name = 'ProtocolEncodeError';
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
  }
}

/**
 * Thrown by decodeCommand for a host → device frame the firmware would reject before acting on
 * it. `errCode` is the ERR code the firmware answers with (companion-protocol.md §3): usually
 * 1 (UNSUPPORTED_CMD) because a failed length/guard check falls through the `else if` chain,
 * sometimes 6 (ILLEGAL_ARG) for structural checks inside a command's branch.
 */
export class CommandDecodeError extends ProtocolDecodeError {
  override readonly name = 'CommandDecodeError';
  constructor(
    message: string,
    code: number,
    /** ERR code the firmware replies with (ERR.*). */
    readonly errCode: number,
    needed: number,
    actual: number,
  ) {
    super(message, code, needed, actual);
  }
}
