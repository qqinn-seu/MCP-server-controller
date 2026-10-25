import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { CoreError } from '../contracts/errors.js';

const CURSOR_PREFIX = 'or1';
const OFFSET_BYTES = 8;
const MAC_BYTES = 32;
const MAX_SAFE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A per-output-store cursor signer.  The signing key intentionally lives only
 * in the owning OutputRing instance: cursors are useful for this server
 * lifetime, but are neither portable to another session nor recoverable after
 * a restart.
 */
export class OutputCursorCodec {
  private readonly key = randomBytes(MAC_BYTES);

  constructor(
    private readonly sessionId: string,
    private readonly epoch: string,
  ) {
    if (sessionId.length === 0 || epoch.length === 0) {
      throw new CoreError('INVALID_ARGUMENT', 'sessionId and epoch must be non-empty');
    }
  }

  cursorAt(offset: number): string {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new CoreError('INVALID_ARGUMENT', 'cursor offset must be a non-negative safe integer');
    }

    const encodedOffset = Buffer.allocUnsafe(OFFSET_BYTES);
    encodedOffset.writeBigUInt64BE(BigInt(offset));
    const offsetPart = encodedOffset.toString('base64url');
    const mac = this.mac(offsetPart);
    return `${CURSOR_PREFIX}.${offsetPart}.${mac.toString('base64url')}`;
  }

  /**
   * Validates structure, MAC, cursor kind, session binding and epoch binding.
   * Range/retention checks are deliberately left to OutputRing, which owns the
   * current log range.
   */
  offsetOf(cursor: string): number {
    if (typeof cursor !== 'string') {
      this.invalid();
    }

    const match = /^or1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (match === null) {
      this.invalid();
    }

    const offsetPart = match[1]!;
    const macPart = match[2]!;
    let encodedOffset: Buffer;
    let suppliedMac: Buffer;
    try {
      encodedOffset = Buffer.from(offsetPart, 'base64url');
      suppliedMac = Buffer.from(macPart, 'base64url');
    } catch {
      this.invalid();
    }

    if (encodedOffset!.length !== OFFSET_BYTES || suppliedMac!.length !== MAC_BYTES) {
      this.invalid();
    }

    if (encodedOffset!.toString('base64url') !== offsetPart || suppliedMac!.toString('base64url') !== macPart) {
      this.invalid();
    }

    const expectedMac = this.mac(offsetPart);
    if (!timingSafeEqual(expectedMac, suppliedMac!)) {
      this.invalid();
    }

    const value = encodedOffset!.readBigUInt64BE();
    if (value > MAX_SAFE_OFFSET) {
      this.invalid();
    }
    return Number(value);
  }

  private mac(offsetPart: string): Buffer {
    // JSON encoding makes the bound fields unambiguous even when IDs contain
    // delimiter-like characters.  The cursor itself exposes only an offset and
    // a MAC; the session ID and epoch remain inside the signed payload.
    const payload = JSON.stringify(['output-ring-v1', this.sessionId, this.epoch, offsetPart]);
    return createHmac('sha256', this.key).update(payload, 'utf8').digest();
  }

  private invalid(): never {
    throw new CoreError('INVALID_CURSOR', 'cursor is invalid');
  }
}
