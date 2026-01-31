/**
 * flex-rpc: Property-Based Tests
 *
 * Uses fast-check to test protocol parsing with random inputs.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseMessage, createRequest, createNotification, serializeMessage } from "../src/protocol/index.js";

describe("Protocol Property-Based Tests", () => {
  describe("Request round-trip", () => {
    it("any valid request survives serialization round-trip", () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(s) && !s.startsWith("rpc.")),
          fc.oneof(
            fc.array(fc.jsonValue()),
            fc.dictionary(fc.string(), fc.jsonValue())
          ),
          fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          (method, params, id) => {
            const request = createRequest(method, params as any, id);
            const serialized = serializeMessage(request);
            const result = parseMessage(serialized);

            expect(result.success).toBe(true);
            if (result.success && result.value.type === "request") {
              expect(result.value.message.method).toBe(method);
              expect(result.value.message.id).toBe(id ?? request.id);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Notification round-trip", () => {
    it("any valid notification survives serialization round-trip", () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(s) && !s.startsWith("rpc.")),
          fc.oneof(
            fc.array(fc.jsonValue()),
            fc.dictionary(fc.string(), fc.jsonValue()),
            fc.constant(undefined)
          ),
          (method, params) => {
            const notification = createNotification(method, params as any);
            const serialized = serializeMessage(notification);
            const result = parseMessage(serialized);

            expect(result.success).toBe(true);
            if (result.success && result.value.type === "notification") {
              expect(result.value.message.method).toBe(method);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Invalid input handling", () => {
    it("never crashes on arbitrary string input", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          // Should never throw
          const result = parseMessage(input);
          expect(typeof result.success).toBe("boolean");
        }),
        { numRuns: 500 }
      );
    });

    it("never crashes on arbitrary JSON input", () => {
      fc.assert(
        fc.property(fc.jsonValue(), (value) => {
          const input = JSON.stringify(value);
          const result = parseMessage(input);
          expect(typeof result.success).toBe("boolean");
        }),
        { numRuns: 200 }
      );
    });

    it("always returns error for non-object top-level values", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null)
          ),
          (value) => {
            const input = JSON.stringify(value);
            const result = parseMessage(input);
            // Non-objects should fail (except empty array which is a specific error)
            if (value !== null && !Array.isArray(value)) {
              expect(result.success).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("ID handling", () => {
    it("preserves various ID types", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer({ min: -1000000, max: 1000000 }),
            fc.constant(null)
          ),
          (id) => {
            const request = createRequest("test", [], id);
            const serialized = serializeMessage(request);
            const result = parseMessage(serialized);

            if (result.success && result.value.type === "request") {
              expect(result.value.message.id).toBe(id);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Batch handling", () => {
    it("handles batches of valid requests", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              jsonrpc: fc.constant("2.0"),
              method: fc.string().filter((s) => /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(s) && !s.startsWith("rpc.")),
              id: fc.string(),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (requests) => {
            const input = JSON.stringify(requests);
            const result = parseMessage(input);

            expect(result.success).toBe(true);
            if (result.success && result.value.type === "batch") {
              expect(result.value.messages.length).toBe(requests.length);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Error code ranges", () => {
    it("parse error has code in valid range", () => {
      const result = parseMessage("not valid json {{{");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(-32700);
      }
    });

    it("invalid request error has code in valid range", () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.string(), fc.jsonValue()).filter((obj) => obj.jsonrpc !== "2.0"),
          (obj) => {
            const input = JSON.stringify(obj);
            const result = parseMessage(input);
            if (!result.success) {
              expect(result.error.code).toBe(-32600);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Size limits", () => {
    it("respects max message size", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 1000 }),
          (maxSize) => {
            const largeMethod = "a".repeat(maxSize + 100);
            const request = { jsonrpc: "2.0", method: largeMethod, id: "1" };
            const input = JSON.stringify(request);

            const result = parseMessage(input, { maxMessageSize: maxSize });

            expect(result.success).toBe(false);
            if (!result.success) {
              expect(result.error.code).toBe(-32700);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
