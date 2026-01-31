/**
 * flex-rpc: Protocol Tests
 *
 * Tests JSON-RPC 2.0 protocol compliance including all 13 spec test cases.
 */

import { describe, it, expect } from "vitest";
import {
  parseMessage,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
} from "../protocol/index.js";
import { ParseError, InvalidRequestError } from "../errors/index.js";

describe("Protocol Types", () => {
  describe("createRequest", () => {
    it("creates a valid request with positional params", () => {
      const request = createRequest("subtract", [42, 23]);

      expect(request.jsonrpc).toBe("2.0");
      expect(request.method).toBe("subtract");
      expect(request.params).toEqual([42, 23]);
      expect(request.id).toBeDefined();
    });

    it("creates a valid request with named params", () => {
      const request = createRequest("subtract", { minuend: 42, subtrahend: 23 });

      expect(request.params).toEqual({ minuend: 42, subtrahend: 23 });
    });

    it("creates a request without params", () => {
      const request = createRequest("ping");

      expect(request.params).toBeUndefined();
    });

    it("uses provided id", () => {
      const request = createRequest("test", [], "custom-id");

      expect(request.id).toBe("custom-id");
    });

    it("supports null id", () => {
      const request = createRequest("test", [], null);

      expect(request.id).toBeNull();
    });

    it("supports numeric id", () => {
      const request = createRequest("test", [], 42);

      expect(request.id).toBe(42);
    });
  });

  describe("createNotification", () => {
    it("creates a valid notification", () => {
      const notification = createNotification("update", [1, 2, 3]);

      expect(notification.jsonrpc).toBe("2.0");
      expect(notification.method).toBe("update");
      expect(notification.params).toEqual([1, 2, 3]);
      expect("id" in notification).toBe(false);
    });
  });

  describe("createSuccessResponse", () => {
    it("creates a valid success response", () => {
      const response = createSuccessResponse("1", 19);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.result).toBe(19);
      expect(response.id).toBe("1");
    });
  });

  describe("createErrorResponse", () => {
    it("creates a valid error response", () => {
      const response = createErrorResponse("1", -32601, "Method not found");

      expect(response.jsonrpc).toBe("2.0");
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toBe("Method not found");
      expect(response.id).toBe("1");
    });

    it("includes error data when provided", () => {
      const response = createErrorResponse("1", -32602, "Invalid params", { field: "name" });

      expect(response.error.data).toEqual({ field: "name" });
    });
  });

  describe("Type Guards", () => {
    it("isJsonRpcRequest identifies requests", () => {
      const request = { jsonrpc: "2.0", method: "test", id: "1" };
      const notification = { jsonrpc: "2.0", method: "test" };

      expect(isJsonRpcRequest(request)).toBe(true);
      expect(isJsonRpcRequest(notification)).toBe(false);
    });

    it("isJsonRpcNotification identifies notifications", () => {
      const request = { jsonrpc: "2.0", method: "test", id: "1" };
      const notification = { jsonrpc: "2.0", method: "test" };

      expect(isJsonRpcNotification(notification)).toBe(true);
      expect(isJsonRpcNotification(request)).toBe(false);
    });

    it("isJsonRpcSuccessResponse identifies success responses", () => {
      const success = { jsonrpc: "2.0", result: 42, id: "1" };
      const error = { jsonrpc: "2.0", error: { code: -32600, message: "Error" }, id: "1" };

      expect(isJsonRpcSuccessResponse(success)).toBe(true);
      expect(isJsonRpcSuccessResponse(error)).toBe(false);
    });

    it("isJsonRpcErrorResponse identifies error responses", () => {
      const success = { jsonrpc: "2.0", result: 42, id: "1" };
      const error = { jsonrpc: "2.0", error: { code: -32600, message: "Error" }, id: "1" };

      expect(isJsonRpcErrorResponse(error)).toBe(true);
      expect(isJsonRpcErrorResponse(success)).toBe(false);
    });
  });
});

describe("Protocol Parser - JSON-RPC 2.0 Spec Compliance", () => {
  // Test case 1: Valid request with positional params
  it("1. parses valid request with positional params", () => {
    const raw = '{"jsonrpc":"2.0","method":"subtract","params":[42,23],"id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe("request");
      if (result.value.type === "request") {
        expect(result.value.message.method).toBe("subtract");
        expect(result.value.message.params).toEqual([42, 23]);
        expect(result.value.message.id).toBe("1");
      }
    }
  });

  // Test case 2: Valid request with named params
  it("2. parses valid request with named params", () => {
    const raw = '{"jsonrpc":"2.0","method":"subtract","params":{"minuend":42,"subtrahend":23},"id":"2"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success && result.value.type === "request") {
      expect(result.value.message.params).toEqual({ minuend: 42, subtrahend: 23 });
    }
  });

  // Test case 3: Notification (no id)
  it("3. parses notification (no id) - expects no response", () => {
    const raw = '{"jsonrpc":"2.0","method":"update","params":[1,2,3,4,5]}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe("notification");
    }
  });

  // Test case 4: Batch request
  it("4. parses batch request - responses may be out of order", () => {
    const raw = '[{"jsonrpc":"2.0","method":"sum","params":[1,2],"id":"1"},{"jsonrpc":"2.0","method":"notify"}]';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe("batch");
      if (result.value.type === "batch") {
        expect(result.value.messages).toHaveLength(2);
      }
    }
  });

  // Test case 5: Parse error (invalid JSON)
  it("5. returns -32700 Parse error for invalid JSON", () => {
    const raw = '{"jsonrpc":"2.0","method":"test",';
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32700);
    }
  });

  // Test case 6: Invalid Request (missing jsonrpc)
  it("6. returns -32600 Invalid Request for missing jsonrpc field", () => {
    const raw = '{"method":"test","id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32600);
    }
  });

  // Test case 7: Invalid Request (wrong jsonrpc version)
  it("7. returns -32600 for wrong jsonrpc version", () => {
    const raw = '{"jsonrpc":"1.0","method":"test","id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32600);
    }
  });

  // Test case 8: Invalid params (not array or object)
  it("8. returns -32600 for invalid params type", () => {
    const raw = '{"jsonrpc":"2.0","method":"test","params":"invalid","id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32600);
    }
  });

  // Test case 9: Request with id: null
  it("9. accepts request with id: null", () => {
    const raw = '{"jsonrpc":"2.0","method":"test","id":null}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success && result.value.type === "request") {
      expect(result.value.message.id).toBeNull();
    }
  });

  // Test case 10: Request with numeric id
  it("10. accepts request with numeric id", () => {
    const raw = '{"jsonrpc":"2.0","method":"test","id":42}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success && result.value.type === "request") {
      expect(result.value.message.id).toBe(42);
    }
  });

  // Test case 11: Empty batch is invalid
  it("11. returns -32600 for empty batch []", () => {
    const raw = "[]";
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32600);
    }
  });

  // Test case 12: Batch with mixed valid/invalid
  it("12. handles batch with mixed valid/invalid - returns partial responses", () => {
    const raw = '[{"jsonrpc":"2.0","method":"test","id":"1"},{"invalid":true}]';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success && result.value.type === "batch") {
      expect(result.value.messages).toHaveLength(2);
      expect(result.value.messages[0]!.type).toBe("request");
      expect(result.value.messages[1]!.type).toBe("response"); // Error response
    }
  });

  // Test case 13: Response parsing
  it("13. parses success response", () => {
    const raw = '{"jsonrpc":"2.0","result":19,"id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe("response");
    }
  });

  // Additional edge cases
  it("rejects reserved method prefix by default", () => {
    const raw = '{"jsonrpc":"2.0","method":"rpc.internal","id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32600);
    }
  });

  it("allows reserved methods with option", () => {
    const raw = '{"jsonrpc":"2.0","method":"rpc.internal","id":"1"}';
    const result = parseMessage(raw, { allowReservedMethods: true });

    expect(result.success).toBe(true);
  });

  it("rejects oversized messages", () => {
    const raw = '{"jsonrpc":"2.0","method":"test","id":"1"}';
    const result = parseMessage(raw, { maxMessageSize: 10 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(-32700);
    }
  });

  it("handles Buffer input", () => {
    const raw = Buffer.from('{"jsonrpc":"2.0","method":"test","id":"1"}');
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
  });

  it("parses error response", () => {
    const raw = '{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":"1"}';
    const result = parseMessage(raw);

    expect(result.success).toBe(true);
    if (result.success && result.value.type === "response") {
      expect("error" in result.value.message).toBe(true);
    }
  });
});
