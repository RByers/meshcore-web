/** Thrown by decodeFrame for empty or truncated frames. */
export class ProtocolDecodeError extends Error {
  override readonly name = 'ProtocolDecodeError';
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
