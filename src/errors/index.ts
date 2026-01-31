/**
 * flex-rpc: Error System
 *
 * Typed errors for JSON-RPC 2.0 and transport-level failures.
 * All errors serialize to valid JSON-RPC error objects.
 */

import type { JsonRpcErrorObject, JsonRpcId } from "../protocol/types.js";

// ============================================================================
// JSON-RPC 2.0 Error Codes (per specification)
// ============================================================================

export const ErrorCodes = {
  // Standard JSON-RPC 2.0 errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Server errors (reserved range: -32000 to -32099)
  SERVER_ERROR: -32000,

  // Custom flex-rpc transport errors (outside reserved range)
  CONNECTION_ERROR: -32001,
  TIMEOUT_ERROR: -32002,
  TRANSPORT_CLOSED: -32003,
  RECONNECT_FAILED: -32004,
  ABORT_ERROR: -32005,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ============================================================================
// Base RPC Error
// ============================================================================

/**
 * Base error class for all flex-rpc errors.
 * Extends Error and includes JSON-RPC error code and optional data.
 */
export class RpcError<TData = unknown> extends Error {
  public readonly code: number;
  public readonly data: TData | undefined;

  constructor(code: number, message: string, data?: TData) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;

    // Maintains proper stack trace for where error was thrown (V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // Set prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Convert to JSON-RPC error object for serialization
   */
  toJsonRpcError(): JsonRpcErrorObject<TData> {
    const error: JsonRpcErrorObject<TData> = {
      code: this.code,
      message: this.message,
    };

    if (this.data !== undefined) {
      return { ...error, data: this.data };
    }

    return error;
  }

  /**
   * Create RpcError from a JSON-RPC error object
   */
  static fromJsonRpcError<T = unknown>(error: JsonRpcErrorObject<T>): RpcError<T> {
    return new RpcError(error.code, error.message, error.data);
  }

  /**
   * Convert to JSON for serialization
   */
  toJSON(): JsonRpcErrorObject<TData> {
    return this.toJsonRpcError();
  }
}

// ============================================================================
// JSON-RPC 2.0 Specification Errors
// ============================================================================

/**
 * Parse error (-32700)
 * Invalid JSON was received by the server.
 */
export class ParseError<TData = unknown> extends RpcError<TData> {
  constructor(message = "Parse error", data?: TData) {
    super(ErrorCodes.PARSE_ERROR, message, data);
    this.name = "ParseError";
  }
}

/**
 * Invalid Request (-32600)
 * The JSON sent is not a valid Request object.
 */
export class InvalidRequestError<TData = unknown> extends RpcError<TData> {
  constructor(message = "Invalid Request", data?: TData) {
    super(ErrorCodes.INVALID_REQUEST, message, data);
    this.name = "InvalidRequestError";
  }
}

/**
 * Method not found (-32601)
 * The method does not exist / is not available.
 */
export class MethodNotFoundError<TData = unknown> extends RpcError<TData> {
  public readonly method: string;

  constructor(method: string, data?: TData) {
    super(ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${method}`, data);
    this.name = "MethodNotFoundError";
    this.method = method;
  }
}

/**
 * Invalid params (-32602)
 * Invalid method parameter(s).
 */
export class InvalidParamsError<TData = unknown> extends RpcError<TData> {
  constructor(message = "Invalid params", data?: TData) {
    super(ErrorCodes.INVALID_PARAMS, message, data);
    this.name = "InvalidParamsError";
  }
}

/**
 * Internal error (-32603)
 * Internal JSON-RPC error.
 */
export class InternalError<TData = unknown> extends RpcError<TData> {
  public readonly cause: Error | undefined;

  constructor(message = "Internal error", data?: TData, cause?: Error) {
    super(ErrorCodes.INTERNAL_ERROR, message, data);
    this.name = "InternalError";
    this.cause = cause;
  }
}

/**
 * Server error (-32000 to -32099)
 * Reserved for implementation-defined server-errors.
 */
export class ServerError<TData = unknown> extends RpcError<TData> {
  constructor(code: number, message: string, data?: TData) {
    // Validate code is in server error range
    if (code < -32099 || code > -32000) {
      code = ErrorCodes.SERVER_ERROR;
    }
    super(code, message, data);
    this.name = "ServerError";
  }
}

// ============================================================================
// Transport Errors
// ============================================================================

/**
 * Base class for transport-level errors
 */
export class TransportError<TData = unknown> extends RpcError<TData> {
  constructor(code: number, message: string, data?: TData) {
    super(code, message, data);
    this.name = "TransportError";
  }
}

/**
 * Connection error
 * Failed to establish connection to the server.
 */
export class ConnectionError<TData = unknown> extends TransportError<TData> {
  public readonly address: string | undefined;
  public readonly cause: Error | undefined;

  constructor(message = "Connection failed", options?: { address?: string; cause?: Error; data?: TData }) {
    super(ErrorCodes.CONNECTION_ERROR, message, options?.data);
    this.name = "ConnectionError";
    this.address = options?.address;
    this.cause = options?.cause;
  }
}

/**
 * Timeout error
 * Request timed out waiting for response.
 */
export class TimeoutError<TData = unknown> extends TransportError<TData> {
  public readonly timeoutMs: number;
  public readonly requestId: JsonRpcId | undefined;

  constructor(timeoutMs: number, options?: { requestId?: JsonRpcId; data?: TData }) {
    super(
      ErrorCodes.TIMEOUT_ERROR,
      `Request timed out after ${timeoutMs}ms`,
      options?.data
    );
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.requestId = options?.requestId;
  }
}

/**
 * Transport closed error
 * Transport connection was closed unexpectedly.
 */
export class TransportClosedError<TData = unknown> extends TransportError<TData> {
  public readonly reason: string | undefined;

  constructor(reason?: string, data?: TData) {
    super(
      ErrorCodes.TRANSPORT_CLOSED,
      reason ? `Transport closed: ${reason}` : "Transport closed",
      data
    );
    this.name = "TransportClosedError";
    this.reason = reason;
  }
}

/**
 * Reconnect failed error
 * Failed to reconnect after connection loss.
 */
export class ReconnectFailedError<TData = unknown> extends TransportError<TData> {
  public readonly attempts: number;
  public readonly lastError: Error | undefined;

  constructor(attempts: number, options?: { lastError?: Error; data?: TData }) {
    super(
      ErrorCodes.RECONNECT_FAILED,
      `Reconnect failed after ${attempts} attempts`,
      options?.data
    );
    this.name = "ReconnectFailedError";
    this.attempts = attempts;
    this.lastError = options?.lastError;
  }
}

/**
 * Abort error
 * Request was aborted via AbortSignal.
 */
export class AbortError<TData = unknown> extends TransportError<TData> {
  constructor(message = "Request aborted", data?: TData) {
    super(ErrorCodes.ABORT_ERROR, message, data);
    this.name = "AbortError";
  }
}

// ============================================================================
// Error Utilities
// ============================================================================

/**
 * Check if an error is an RpcError
 */
export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError;
}

/**
 * Check if an error code is a JSON-RPC spec error
 */
export function isSpecError(code: number): boolean {
  return code >= -32700 && code <= -32600;
}

/**
 * Check if an error code is in the server error range
 */
export function isServerError(code: number): boolean {
  return code >= -32099 && code <= -32000;
}

/**
 * Wrap an unknown error as an InternalError
 */
export function wrapError(error: unknown): RpcError {
  if (error instanceof RpcError) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message, { originalError: error.name }, error);
  }

  return new InternalError(String(error));
}

/**
 * Create an RpcError from an error code
 */
export function createErrorFromCode(
  code: number,
  message?: string,
  data?: unknown
): RpcError {
  switch (code) {
    case ErrorCodes.PARSE_ERROR:
      return new ParseError(message, data);
    case ErrorCodes.INVALID_REQUEST:
      return new InvalidRequestError(message, data);
    case ErrorCodes.METHOD_NOT_FOUND:
      return new MethodNotFoundError(message ?? "unknown", data);
    case ErrorCodes.INVALID_PARAMS:
      return new InvalidParamsError(message, data);
    case ErrorCodes.INTERNAL_ERROR:
      return new InternalError(message, data);
    case ErrorCodes.CONNECTION_ERROR:
      return new ConnectionError(message, { data });
    case ErrorCodes.TIMEOUT_ERROR:
      return new TimeoutError(0, { data });
    case ErrorCodes.TRANSPORT_CLOSED:
      return new TransportClosedError(message, data);
    default:
      if (isServerError(code)) {
        return new ServerError(code, message ?? "Server error", data);
      }
      return new RpcError(code, message ?? "Unknown error", data);
  }
}
