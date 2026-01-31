/**
 * flex-rpc: JSON-RPC 2.0 Protocol Parser & Validator
 *
 * Implements strict parsing and validation per JSON-RPC 2.0 specification.
 */

import {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcResponse,
  JsonRpcId,
  JsonRpcParams,
  createErrorResponse,
} from "./types.js";

import {
  ParseError,
  InvalidRequestError,
  RpcError,
} from "../errors/index.js";

// ============================================================================
// Validation Constants
// ============================================================================

/** Maximum allowed message size in bytes (default: 1MB) */
export const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

/** Method name validation regex: alphanumeric, dots, underscores, hyphens */
const METHOD_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

/** Reserved method prefix per spec */
const RESERVED_METHOD_PREFIX = "rpc.";

// ============================================================================
// Parse Options
// ============================================================================

export interface ParseOptions {
  /** Maximum message size in bytes */
  maxMessageSize?: number;
  /** Allow methods starting with "rpc." (reserved per spec) */
  allowReservedMethods?: boolean;
  /** Strict method name validation */
  strictMethodNames?: boolean;
}

const defaultParseOptions: Required<ParseOptions> = {
  maxMessageSize: DEFAULT_MAX_MESSAGE_SIZE,
  allowReservedMethods: false,
  strictMethodNames: true,
};

// ============================================================================
// Parse Result Types
// ============================================================================

export type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; error: RpcError };

export type ParsedMessage =
  | { type: "request"; message: JsonRpcRequest }
  | { type: "notification"; message: JsonRpcNotification }
  | { type: "batch"; messages: ParsedMessage[] }
  | { type: "response"; message: JsonRpcResponse };

// ============================================================================
// Main Parse Function
// ============================================================================

/**
 * Parse a raw JSON string into a validated JSON-RPC message
 *
 * @param raw - Raw JSON string to parse
 * @param options - Parse options
 * @returns ParseResult with either the parsed message or an error
 */
export function parseMessage(
  raw: string | Buffer | Uint8Array,
  options: ParseOptions = {}
): ParseResult<ParsedMessage> {
  const opts = { ...defaultParseOptions, ...options };

  // Convert Buffer/Uint8Array to string
  const str = typeof raw === "string" ? raw : raw.toString("utf8");

  // Check message size
  const byteLength = Buffer.byteLength(str, "utf8");
  if (byteLength > opts.maxMessageSize) {
    return {
      success: false,
      error: new ParseError(`Message size ${byteLength} exceeds maximum ${opts.maxMessageSize}`),
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    return {
      success: false,
      error: new ParseError(
        e instanceof Error ? `Invalid JSON: ${e.message}` : "Invalid JSON"
      ),
    };
  }

  // Handle batch requests
  if (Array.isArray(parsed)) {
    return parseBatchMessage(parsed, opts);
  }

  // Handle single message
  return parseSingleMessage(parsed, opts);
}

/**
 * Parse a single JSON-RPC message (not a batch)
 */
function parseSingleMessage(
  parsed: unknown,
  opts: Required<ParseOptions>
): ParseResult<ParsedMessage> {
  // Must be an object
  if (typeof parsed !== "object" || parsed === null) {
    return {
      success: false,
      error: new InvalidRequestError("Message must be an object"),
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Check jsonrpc field
  if (obj.jsonrpc !== "2.0") {
    return {
      success: false,
      error: new InvalidRequestError('Missing or invalid "jsonrpc" field, must be "2.0"'),
    };
  }

  // Check if this is a response (has result or error)
  if ("result" in obj || "error" in obj) {
    return parseResponse(obj);
  }

  // Must have method field for request/notification
  if (typeof obj.method !== "string") {
    return {
      success: false,
      error: new InvalidRequestError('"method" must be a string'),
    };
  }

  // Validate method name
  const methodValidation = validateMethodName(obj.method, opts);
  if (!methodValidation.success) {
    return methodValidation;
  }

  // Validate params if present
  if ("params" in obj && obj.params !== undefined) {
    if (!isValidParams(obj.params)) {
      return {
        success: false,
        error: new InvalidRequestError('"params" must be an array or object'),
      };
    }
  }

  // Determine if request or notification based on id presence
  if ("id" in obj) {
    // Request - validate id
    if (!isValidId(obj.id)) {
      return {
        success: false,
        error: new InvalidRequestError('"id" must be a string, number, or null'),
      };
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: obj.method,
      id: obj.id as JsonRpcId,
      ...(obj.params !== undefined && { params: obj.params as JsonRpcParams }),
    };

    return { success: true, value: { type: "request", message: request } };
  } else {
    // Notification
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: obj.method,
      ...(obj.params !== undefined && { params: obj.params as JsonRpcParams }),
    };

    return { success: true, value: { type: "notification", message: notification } };
  }
}

/**
 * Parse a JSON-RPC response
 */
function parseResponse(obj: Record<string, unknown>): ParseResult<ParsedMessage> {
  // Must have id
  if (!("id" in obj)) {
    return {
      success: false,
      error: new InvalidRequestError("Response must have an id"),
    };
  }

  if (!isValidId(obj.id)) {
    return {
      success: false,
      error: new InvalidRequestError('"id" must be a string, number, or null'),
    };
  }

  // Must have exactly one of result or error
  const hasResult = "result" in obj;
  const hasError = "error" in obj;

  if (hasResult && hasError) {
    return {
      success: false,
      error: new InvalidRequestError("Response cannot have both result and error"),
    };
  }

  if (!hasResult && !hasError) {
    return {
      success: false,
      error: new InvalidRequestError("Response must have either result or error"),
    };
  }

  if (hasError) {
    // Validate error object
    const errorValidation = validateErrorObject(obj.error);
    if (!errorValidation.success) {
      return errorValidation;
    }
  }

  const response = {
    jsonrpc: "2.0" as const,
    id: obj.id as JsonRpcId,
    ...(hasResult && { result: obj.result }),
    ...(hasError && { error: obj.error as { code: number; message: string; data?: unknown } }),
  };

  return { success: true, value: { type: "response", message: response as JsonRpcResponse } };
}

/**
 * Parse a batch of JSON-RPC messages
 */
function parseBatchMessage(
  arr: unknown[],
  opts: Required<ParseOptions>
): ParseResult<ParsedMessage> {
  // Empty batch is invalid
  if (arr.length === 0) {
    return {
      success: false,
      error: new InvalidRequestError("Batch request must not be empty"),
    };
  }

  const messages: ParsedMessage[] = [];

  for (const item of arr) {
    const result = parseSingleMessage(item, opts);
    if (result.success) {
      messages.push(result.value);
    } else {
      // For batches, we include error responses in the result
      // per spec: "If the batch rpc call itself fails to be recognized as an
      // array of JSON-RPC objects, the response from the Server MUST be a
      // single Response object"
      // But individual failures should still be included
      messages.push({
        type: "response",
        message: createErrorResponse(null, result.error.code, result.error.message),
      });
    }
  }

  return { success: true, value: { type: "batch", messages } };
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateMethodName(
  method: string,
  opts: Required<ParseOptions>
): ParseResult<void> {
  // Check reserved prefix
  if (!opts.allowReservedMethods && method.startsWith(RESERVED_METHOD_PREFIX)) {
    return {
      success: false,
      error: new InvalidRequestError(
        `Method names starting with "${RESERVED_METHOD_PREFIX}" are reserved`
      ),
    };
  }

  // Check method name format
  if (opts.strictMethodNames && !METHOD_NAME_REGEX.test(method)) {
    return {
      success: false,
      error: new InvalidRequestError(
        `Invalid method name "${method}". Must start with a letter or underscore and contain only alphanumeric characters, dots, underscores, and hyphens.`
      ),
    };
  }

  return { success: true, value: undefined };
}

function validateErrorObject(error: unknown): ParseResult<void> {
  if (typeof error !== "object" || error === null) {
    return {
      success: false,
      error: new InvalidRequestError("Error must be an object"),
    };
  }

  const errorObj = error as Record<string, unknown>;

  if (typeof errorObj.code !== "number" || !Number.isInteger(errorObj.code)) {
    return {
      success: false,
      error: new InvalidRequestError("Error code must be an integer"),
    };
  }

  if (typeof errorObj.message !== "string") {
    return {
      success: false,
      error: new InvalidRequestError("Error message must be a string"),
    };
  }

  return { success: true, value: undefined };
}

function isValidId(id: unknown): id is JsonRpcId {
  return id === null || typeof id === "string" || typeof id === "number";
}

function isValidParams(params: unknown): params is JsonRpcParams {
  return Array.isArray(params) || (typeof params === "object" && params !== null);
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize a JSON-RPC message to a string
 */
export function serializeMessage(message: JsonRpcMessage | JsonRpcResponse): string {
  return JSON.stringify(message);
}

/**
 * Serialize a batch of messages
 */
export function serializeBatch(messages: (JsonRpcMessage | JsonRpcResponse)[]): string {
  return JSON.stringify(messages);
}
