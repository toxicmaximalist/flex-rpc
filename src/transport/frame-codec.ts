/**
 * flex-rpc: Frame Codec
 *
 * Handles message framing for stream-based transports (TCP).
 * Supports newline-delimited JSON (default) and length-prefixed framing.
 */

// ============================================================================
// Framing Types
// ============================================================================

export type FramingType = "newline" | "length-prefix";

export interface FrameCodecOptions {
  /** Framing type to use */
  type: FramingType;
  /** Maximum message size in bytes */
  maxMessageSize: number;
}

const defaultOptions: FrameCodecOptions = {
  type: "newline",
  maxMessageSize: 1024 * 1024, // 1MB
};

// ============================================================================
// Frame Codec
// ============================================================================

/**
 * Handles encoding and decoding of framed messages for stream transports.
 * Buffers partial messages and emits complete messages.
 */
export class FrameCodec {
  private buffer: Buffer;
  private readonly options: FrameCodecOptions;

  constructor(options: Partial<FrameCodecOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Encode a message for transmission
   */
  encode(message: string): Buffer {
    const data = Buffer.from(message, "utf8");

    if (this.options.type === "length-prefix") {
      // 4-byte length prefix (big-endian)
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(data.length, 0);
      return Buffer.concat([lengthBuffer, data]);
    }

    // Newline-delimited
    return Buffer.concat([data, Buffer.from("\n")]);
  }

  /**
   * Decode incoming data and extract complete messages
   * @returns Array of complete message strings
   */
  decode(chunk: Buffer | string): string[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, data]);

    const messages: string[] = [];

    if (this.options.type === "length-prefix") {
      // Length-prefixed decoding
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);

        // Check message size
        if (length > this.options.maxMessageSize) {
          throw new Error(
            `Message size ${length} exceeds maximum ${this.options.maxMessageSize}`
          );
        }

        // Wait for complete message
        if (this.buffer.length < 4 + length) {
          break;
        }

        const message = this.buffer.subarray(4, 4 + length).toString("utf8");
        messages.push(message);
        this.buffer = this.buffer.subarray(4 + length);
      }
    } else {
      // Newline-delimited decoding
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf(0x0a)) !== -1) {
        // Check message size
        if (newlineIndex > this.options.maxMessageSize) {
          throw new Error(
            `Message size ${newlineIndex} exceeds maximum ${this.options.maxMessageSize}`
          );
        }

        const message = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
        messages.push(message);
        this.buffer = this.buffer.subarray(newlineIndex + 1);
      }

      // Check if buffer is getting too large (incomplete message)
      if (this.buffer.length > this.options.maxMessageSize) {
        throw new Error(
          `Buffer size ${this.buffer.length} exceeds maximum ${this.options.maxMessageSize}`
        );
      }
    }

    return messages;
  }

  /**
   * Reset the internal buffer
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Get the current buffer size
   */
  get bufferSize(): number {
    return this.buffer.length;
  }
}
