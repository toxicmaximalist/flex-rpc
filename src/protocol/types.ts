/**
 * flex-rpc: JSON-RPC 2.0 Protocol Types
 *
 * Strict TypeScript definitions for JSON-RPC 2.0 specification.
 * @see https://www.jsonrpc.org/specification
 */

/** JSON-RPC protocol version - always "2.0" for this implementation */
export type JsonRpcVersion = "2.0";

/** Valid JSON-RPC request ID types per spec: string, number, or null */
export type JsonRpcId = string | number | null;

/** JSON-RPC params can be array (positional) or object (named) */
export type JsonRpcParams = unknown[] | Record<string, unknown>;

/**
 * JSON-RPC 2.0 Request object
 * A request requires an `id` field and expects a response
 */
export interface JsonRpcRequest<TParams extends JsonRpcParams = JsonRpcParams> {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly id: JsonRpcId;
  readonly params?: TParams;
}

/**
 * JSON-RPC 2.0 Notification object
 * A notification has NO `id` field and expects NO response
 */
export interface JsonRpcNotification<TParams extends JsonRpcParams = JsonRpcParams> {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly params?: TParams;
}

/** Union type for any incoming JSON-RPC message */
export type JsonRpcMessage<TParams extends JsonRpcParams = JsonRpcParams> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>;

/**
 * JSON-RPC 2.0 Error object
 * Included in error responses
 */
export interface JsonRpcErrorObject<TData = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: TData;
}

/**
 * JSON-RPC 2.0 Success Response
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly result: TResult;
  readonly id: JsonRpcId;
}

/**
 * JSON-RPC 2.0 Error Response
 */
export interface JsonRpcErrorResponse<TData = unknown> {
  readonly jsonrpc: JsonRpcVersion;
  readonly error: JsonRpcErrorObject<TData>;
  readonly id: JsonRpcId;
}

/** Union type for any JSON-RPC response */
export type JsonRpcResponse<TResult = unknown, TErrorData = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TErrorData>;

/**
 * Batch request: array of requests/notifications
 * Must contain at least one element per spec
 */
export type JsonRpcBatchRequest = JsonRpcMessage[];

/**
 * Batch response: array of responses
 * May be in different order than requests
 * Does not include responses for notifications
 */
export type JsonRpcBatchResponse = JsonRpcResponse[];

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a JSON-RPC request (has `id` field)
 */
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    isObject(message) &&
    "id" in message &&
    "method" in message &&
    "jsonrpc" in message &&
    message.jsonrpc === "2.0"
  );
}

/**
 * Check if a message is a JSON-RPC notification (no `id` field)
 */
export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return (
    isObject(message) &&
    !("id" in message) &&
    "method" in message &&
    "jsonrpc" in message &&
    message.jsonrpc === "2.0"
  );
}

/**
 * Check if a response is a success response (has `result` field)
 */
export function isJsonRpcSuccessResponse(response: unknown): response is JsonRpcSuccessResponse {
  return (
    isObject(response) &&
    "result" in response &&
    "id" in response &&
    "jsonrpc" in response &&
    response.jsonrpc === "2.0"
  );
}

/**
 * Check if a response is an error response (has `error` field)
 */
export function isJsonRpcErrorResponse(response: unknown): response is JsonRpcErrorResponse {
  return (
    isObject(response) &&
    "error" in response &&
    "id" in response &&
    "jsonrpc" in response &&
    response.jsonrpc === "2.0"
  );
}

/**
 * Check if a message is a batch request (non-empty array)
 */
export function isJsonRpcBatchRequest(message: unknown): message is JsonRpcBatchRequest {
  return Array.isArray(message) && message.length > 0;
}

/**
 * Check if a response is a batch response
 */
export function isJsonRpcBatchResponse(response: unknown): response is JsonRpcBatchResponse {
  return Array.isArray(response);
}

// ============================================================================
// Internal Helpers
// ============================================================================

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// Factory Functions
// ============================================================================

let requestIdCounter = 0;

/**
 * Generate a unique request ID
 * Uses monotonic counter + timestamp for uniqueness
 */
export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${(++requestIdCounter).toString(36)}`;
}

/**
 * Create a JSON-RPC request object
 */
export function createRequest<TParams extends JsonRpcParams = JsonRpcParams>(
  method: string,
  params?: TParams,
  id?: JsonRpcId
): JsonRpcRequest<TParams> {
  // Use provided id if defined (including null), otherwise generate
  const actualId = id !== undefined ? id : generateRequestId();
  
  const request: JsonRpcRequest<TParams> = {
    jsonrpc: "2.0",
    method,
    id: actualId,
  };

  if (params !== undefined) {
    return { ...request, params };
  }

  return request;
}

/**
 * Create a JSON-RPC notification object
 */
export function createNotification<TParams extends JsonRpcParams = JsonRpcParams>(
  method: string,
  params?: TParams
): JsonRpcNotification<TParams> {
  const notification: JsonRpcNotification<TParams> = {
    jsonrpc: "2.0",
    method,
  };

  if (params !== undefined) {
    return { ...notification, params };
  }

  return notification;
}

/**
 * Create a JSON-RPC success response
 */
export function createSuccessResponse<TResult = unknown>(
  id: JsonRpcId,
  result: TResult
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: "2.0",
    result,
    id,
  };
}

/**
 * Create a JSON-RPC error response
 */
export function createErrorResponse<TData = unknown>(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: TData
): JsonRpcErrorResponse<TData> {
  const error: JsonRpcErrorObject<TData> = { code, message };
  
  if (data !== undefined) {
    return {
      jsonrpc: "2.0",
      error: { ...error, data },
      id,
    };
  }

  return {
    jsonrpc: "2.0",
    error,
    id,
  };
}
