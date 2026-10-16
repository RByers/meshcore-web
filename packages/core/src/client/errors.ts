/** Errors raised by CompanionClient. */

import type { ErrName } from '../protocol/constants.js';
import type { CommandKind } from '../protocol/types.js';

export class ClientError extends Error {
  override readonly name: string = 'ClientError';
}

/**
 * The device answered a command with RESP_CODE_ERR (companion-protocol.md §3) or with
 * RESP_CODE_DISABLED (feature compiled out; `errCode` -1, `errName` 'DISABLED').
 */
export class DeviceError extends ClientError {
  override readonly name = 'DeviceError';
  constructor(
    readonly command: CommandKind,
    readonly errCode: number,
    readonly errName: ErrName | 'UNKNOWN' | 'DISABLED',
  ) {
    super(`${command}: device returned ${errName}${errCode >= 0 ? ` (${errCode})` : ''}`);
  }
}

/** No (complete) reply to a command arrived within the timeout. */
export class RequestTimeoutError extends ClientError {
  override readonly name = 'RequestTimeoutError';
  constructor(
    readonly command: CommandKind,
    readonly timeoutMs: number,
  ) {
    super(`${command}: no reply within ${timeoutMs} ms`);
  }
}

/** A remote node (repeater / room / sensor / peer) did not answer within the expected time. */
export class RemoteTimeoutError extends ClientError {
  override readonly name = 'RemoteTimeoutError';
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation}: no response from the remote node within ${timeoutMs} ms`);
  }
}

/** LOGIN_FAIL push (only sent by servers that answer a wrong password at all, §6.6). */
export class LoginFailedError extends ClientError {
  override readonly name = 'LoginFailedError';
  constructor(readonly pubKeyPrefix: Uint8Array) {
    super('login rejected by the remote node');
  }
}

/** The link was closed (or never open) while the operation was pending. */
export class DisconnectedError extends ClientError {
  override readonly name = 'DisconnectedError';
  constructor(message = 'disconnected', options?: { cause?: unknown }) {
    super(message, options);
  }
}
