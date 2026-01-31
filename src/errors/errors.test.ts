/**
 * flex-rpc: Error System Tests
 */

import { describe, it, expect } from "vitest";
import {
  ErrorCodes,
  RpcError,
  ParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  ServerError,
  ConnectionError,
  TimeoutError,
  TransportClosedError,
  ReconnectFailedError,
  AbortError,
  isRpcError,
  isSpecError,
  isServerError,
  wrapError,
  createErrorFromCode,
} from "../errors/index.js";

describe("Error System", () => {
  describe("Error Codes", () => {
    it("has correct spec error codes", () => {
      expect(ErrorCodes.PARSE_ERROR).toBe(-32700);
      expect(ErrorCodes.INVALID_REQUEST).toBe(-32600);
      expect(ErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
      expect(ErrorCodes.INVALID_PARAMS).toBe(-32602);
      expect(ErrorCodes.INTERNAL_ERROR).toBe(-32603);
    });

    it("has server error code in range", () => {
      expect(ErrorCodes.SERVER_ERROR).toBeGreaterThanOrEqual(-32099);
      expect(ErrorCodes.SERVER_ERROR).toBeLessThanOrEqual(-32000);
    });
  });

  describe("RpcError base class", () => {
    it("creates error with code and message", () => {
      const error = new RpcError(-32600, "Test error");

      expect(error.code).toBe(-32600);
      expect(error.message).toBe("Test error");
      expect(error.name).toBe("RpcError");
      expect(error.data).toBeUndefined();
    });

    it("creates error with data", () => {
      const error = new RpcError(-32600, "Test error", { field: "test" });

      expect(error.data).toEqual({ field: "test" });
    });

    it("serializes to JSON-RPC error object", () => {
      const error = new RpcError(-32600, "Test error", { field: "test" });
      const json = error.toJsonRpcError();

      expect(json).toEqual({
        code: -32600,
        message: "Test error",
        data: { field: "test" },
      });
    });

    it("serializes without data when not provided", () => {
      const error = new RpcError(-32600, "Test error");
      const json = error.toJsonRpcError();

      expect(json).toEqual({
        code: -32600,
        message: "Test error",
      });
    });

    it("creates from JSON-RPC error object", () => {
      const error = RpcError.fromJsonRpcError({
        code: -32601,
        message: "Method not found",
        data: { method: "test" },
      });

      expect(error.code).toBe(-32601);
      expect(error.message).toBe("Method not found");
      expect(error.data).toEqual({ method: "test" });
    });

    it("toJSON returns same as toJsonRpcError", () => {
      const error = new RpcError(-32600, "Test error");
      expect(error.toJSON()).toEqual(error.toJsonRpcError());
    });

    it("is instanceof Error", () => {
      const error = new RpcError(-32600, "Test");
      expect(error instanceof Error).toBe(true);
      expect(error instanceof RpcError).toBe(true);
    });
  });

  describe("Spec Errors", () => {
    it("ParseError has correct code", () => {
      const error = new ParseError();
      expect(error.code).toBe(-32700);
      expect(error.name).toBe("ParseError");
    });

    it("InvalidRequestError has correct code", () => {
      const error = new InvalidRequestError();
      expect(error.code).toBe(-32600);
      expect(error.name).toBe("InvalidRequestError");
    });

    it("MethodNotFoundError has correct code and method", () => {
      const error = new MethodNotFoundError("testMethod");
      expect(error.code).toBe(-32601);
      expect(error.name).toBe("MethodNotFoundError");
      expect(error.method).toBe("testMethod");
      expect(error.message).toBe("Method not found: testMethod");
    });

    it("InvalidParamsError has correct code", () => {
      const error = new InvalidParamsError();
      expect(error.code).toBe(-32602);
      expect(error.name).toBe("InvalidParamsError");
    });

    it("InternalError has correct code and preserves cause", () => {
      const cause = new Error("Original error");
      const error = new InternalError("Internal error", undefined, cause);
      expect(error.code).toBe(-32603);
      expect(error.name).toBe("InternalError");
      expect(error.cause).toBe(cause);
    });

    it("ServerError clamps code to valid range", () => {
      const validError = new ServerError(-32050, "Server error");
      expect(validError.code).toBe(-32050);

      const outOfRangeError = new ServerError(-33000, "Server error");
      expect(outOfRangeError.code).toBe(-32000); // Clamped to default
    });
  });

  describe("Transport Errors", () => {
    it("ConnectionError captures address and cause", () => {
      const cause = new Error("ECONNREFUSED");
      const error = new ConnectionError("Connection failed", {
        address: "localhost:3000",
        cause,
      });

      expect(error.code).toBe(ErrorCodes.CONNECTION_ERROR);
      expect(error.name).toBe("ConnectionError");
      expect(error.address).toBe("localhost:3000");
      expect(error.cause).toBe(cause);
    });

    it("TimeoutError captures timeout and request id", () => {
      const error = new TimeoutError(5000, { requestId: "123" });

      expect(error.code).toBe(ErrorCodes.TIMEOUT_ERROR);
      expect(error.name).toBe("TimeoutError");
      expect(error.timeoutMs).toBe(5000);
      expect(error.requestId).toBe("123");
      expect(error.message).toBe("Request timed out after 5000ms");
    });

    it("TransportClosedError captures reason", () => {
      const error = new TransportClosedError("Server shutdown");

      expect(error.code).toBe(ErrorCodes.TRANSPORT_CLOSED);
      expect(error.reason).toBe("Server shutdown");
    });

    it("ReconnectFailedError captures attempts", () => {
      const lastError = new Error("Connection refused");
      const error = new ReconnectFailedError(5, { lastError });

      expect(error.code).toBe(ErrorCodes.RECONNECT_FAILED);
      expect(error.attempts).toBe(5);
      expect(error.lastError).toBe(lastError);
    });

    it("AbortError has correct code", () => {
      const error = new AbortError();

      expect(error.code).toBe(ErrorCodes.ABORT_ERROR);
      expect(error.name).toBe("AbortError");
    });
  });

  describe("Error Utilities", () => {
    it("isRpcError identifies RpcError instances", () => {
      expect(isRpcError(new RpcError(-32600, "Test"))).toBe(true);
      expect(isRpcError(new ParseError())).toBe(true);
      expect(isRpcError(new TimeoutError(1000))).toBe(true);
      expect(isRpcError(new Error("Regular error"))).toBe(false);
      expect(isRpcError(null)).toBe(false);
      expect(isRpcError(undefined)).toBe(false);
    });

    it("isSpecError identifies spec error codes", () => {
      expect(isSpecError(-32700)).toBe(true);
      expect(isSpecError(-32600)).toBe(true);
      expect(isSpecError(-32601)).toBe(true);
      expect(isSpecError(-32602)).toBe(true);
      expect(isSpecError(-32603)).toBe(true);
      expect(isSpecError(-32000)).toBe(false);
      expect(isSpecError(-1)).toBe(false);
    });

    it("isServerError identifies server error range", () => {
      expect(isServerError(-32000)).toBe(true);
      expect(isServerError(-32099)).toBe(true);
      expect(isServerError(-32050)).toBe(true);
      expect(isServerError(-32100)).toBe(false);
      expect(isServerError(-31999)).toBe(false);
    });

    it("wrapError wraps unknown errors as InternalError", () => {
      const regularError = new Error("Test error");
      const wrapped = wrapError(regularError);

      expect(wrapped).toBeInstanceOf(InternalError);
      expect(wrapped.code).toBe(-32603);
      expect(wrapped.message).toBe("Test error");
    });

    it("wrapError passes through RpcError unchanged", () => {
      const rpcError = new MethodNotFoundError("test");
      const wrapped = wrapError(rpcError);

      expect(wrapped).toBe(rpcError);
    });

    it("wrapError handles string errors", () => {
      const wrapped = wrapError("String error");

      expect(wrapped).toBeInstanceOf(InternalError);
      expect(wrapped.message).toBe("String error");
    });

    it("createErrorFromCode creates correct error types", () => {
      expect(createErrorFromCode(-32700)).toBeInstanceOf(ParseError);
      expect(createErrorFromCode(-32600)).toBeInstanceOf(InvalidRequestError);
      expect(createErrorFromCode(-32601, "test")).toBeInstanceOf(MethodNotFoundError);
      expect(createErrorFromCode(-32602)).toBeInstanceOf(InvalidParamsError);
      expect(createErrorFromCode(-32603)).toBeInstanceOf(InternalError);
      expect(createErrorFromCode(-32050, "Server error")).toBeInstanceOf(ServerError);
      expect(createErrorFromCode(-1, "Unknown")).toBeInstanceOf(RpcError);
    });
  });
});
