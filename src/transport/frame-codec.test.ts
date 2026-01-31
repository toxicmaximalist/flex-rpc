/**
 * flex-rpc: Frame Codec Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FrameCodec } from "../transport/frame-codec.js";

describe("FrameCodec", () => {
  describe("Newline-delimited framing (default)", () => {
    let codec: FrameCodec;

    beforeEach(() => {
      codec = new FrameCodec();
    });

    it("encodes message with newline", () => {
      const encoded = codec.encode('{"test":true}');
      expect(encoded.toString()).toBe('{"test":true}\n');
    });

    it("decodes single complete message", () => {
      const messages = codec.decode('{"test":true}\n');
      expect(messages).toEqual(['{"test":true}']);
    });

    it("decodes multiple messages", () => {
      const messages = codec.decode('{"a":1}\n{"b":2}\n');
      expect(messages).toEqual(['{"a":1}', '{"b":2}']);
    });

    it("buffers partial messages", () => {
      const messages1 = codec.decode('{"test":');
      expect(messages1).toEqual([]);
      expect(codec.bufferSize).toBeGreaterThan(0);

      const messages2 = codec.decode('true}\n');
      expect(messages2).toEqual(['{"test":true}']);
      expect(codec.bufferSize).toBe(0);
    });

    it("handles message split across multiple chunks", () => {
      codec.decode('{"');
      codec.decode('test');
      codec.decode('":');
      const messages = codec.decode('1}\n');
      expect(messages).toEqual(['{"test":1}']);
    });

    it("handles multiple messages with partial at end", () => {
      const messages1 = codec.decode('{"a":1}\n{"b":2}\n{"c":');
      expect(messages1).toEqual(['{"a":1}', '{"b":2}']);
      expect(codec.bufferSize).toBeGreaterThan(0);

      const messages2 = codec.decode('3}\n');
      expect(messages2).toEqual(['{"c":3}']);
    });

    it("trims whitespace from messages", () => {
      const messages = codec.decode('  {"test":1}  \n');
      expect(messages).toEqual(['{"test":1}']);
    });

    it("resets buffer", () => {
      codec.decode('partial');
      expect(codec.bufferSize).toBeGreaterThan(0);

      codec.reset();
      expect(codec.bufferSize).toBe(0);
    });

    it("throws on message exceeding max size", () => {
      const smallCodec = new FrameCodec({ type: "newline", maxMessageSize: 10 });

      expect(() => {
        smallCodec.decode('{"test":"very long message"}\n');
      }).toThrow(/exceeds maximum/);
    });

    it("throws on buffer exceeding max size", () => {
      const smallCodec = new FrameCodec({ type: "newline", maxMessageSize: 10 });

      expect(() => {
        smallCodec.decode('{"test":"very long message without newline');
      }).toThrow(/exceeds maximum/);
    });
  });

  describe("Length-prefixed framing", () => {
    let codec: FrameCodec;

    beforeEach(() => {
      codec = new FrameCodec({ type: "length-prefix", maxMessageSize: 1024 });
    });

    it("encodes message with 4-byte length prefix", () => {
      const encoded = codec.encode('test');
      expect(encoded.length).toBe(8); // 4 bytes prefix + 4 bytes data
      expect(encoded.readUInt32BE(0)).toBe(4);
      expect(encoded.subarray(4).toString()).toBe('test');
    });

    it("decodes single complete message", () => {
      const data = Buffer.alloc(8);
      data.writeUInt32BE(4, 0);
      data.write('test', 4);

      const messages = codec.decode(data);
      expect(messages).toEqual(['test']);
    });

    it("decodes multiple messages", () => {
      const msg1 = '{"a":1}';
      const msg2 = '{"b":2}';

      const buffer = Buffer.alloc(4 + msg1.length + 4 + msg2.length);
      let offset = 0;

      buffer.writeUInt32BE(msg1.length, offset);
      buffer.write(msg1, offset + 4);
      offset += 4 + msg1.length;

      buffer.writeUInt32BE(msg2.length, offset);
      buffer.write(msg2, offset + 4);

      const messages = codec.decode(buffer);
      expect(messages).toEqual([msg1, msg2]);
    });

    it("buffers partial messages", () => {
      const msg = '{"test":true}';
      const buffer = Buffer.alloc(4 + msg.length);
      buffer.writeUInt32BE(msg.length, 0);
      buffer.write(msg, 4);

      // Send only first 10 bytes
      const messages1 = codec.decode(buffer.subarray(0, 10));
      expect(messages1).toEqual([]);

      // Send rest
      const messages2 = codec.decode(buffer.subarray(10));
      expect(messages2).toEqual([msg]);
    });

    it("waits for complete length prefix", () => {
      const messages1 = codec.decode(Buffer.from([0, 0]));
      expect(messages1).toEqual([]);

      const messages2 = codec.decode(Buffer.from([0, 4, 116, 101, 115, 116])); // Complete: length=4, "test"
      expect(messages2).toEqual(['test']);
    });

    it("throws on message exceeding max size", () => {
      const smallCodec = new FrameCodec({ type: "length-prefix", maxMessageSize: 10 });
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(100, 0); // Claim 100 bytes

      expect(() => {
        smallCodec.decode(buffer);
      }).toThrow(/exceeds maximum/);
    });
  });
});
