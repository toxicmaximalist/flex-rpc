/**
 * flex-rpc: Production-ready JSON-RPC 2.0 library
 *
 * Supports Node.js 20+ and Bun with TCP, WebSocket, and HTTP transports.
 *
 * @example
 * ```typescript
 * import { createClient, createServer, TcpClientTransport, TcpServerTransport } from 'flex-rpc';
 *
 * // Server
 * const server = createServer();
 * server.addTransport(new TcpServerTransport(3000));
 * server.expose('add', (params) => params[0] + params[1]);
 * await server.listen();
 *
 * // Client
 * const client = createClient(new TcpClientTransport('localhost', 3000));
 * const result = await client.call('add', [1, 2]);
 * console.log(result); // 3
 * ```
 */

// Client
export { RpcClient, createClient, type RpcClientOptions, type BatchCall, type BatchResult } from "./client/index.js";

// Server
export {
  RpcServer,
  createServer,
  type RpcServerOptions,
  type MethodHandler,
  type MethodOptions,
  type RequestContext,
  type Middleware,
  type NextFunction,
} from "./server/index.js";

// Protocol types
export {
  type JsonRpcVersion,
  type JsonRpcId,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcMessage,
  type JsonRpcErrorObject,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
  type JsonRpcBatchRequest,
  type JsonRpcBatchResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  isJsonRpcBatchRequest,
  isJsonRpcBatchResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  generateRequestId,
} from "./protocol/index.js";

// Parser
export { parseMessage, serializeMessage, serializeBatch, type ParseOptions, type ParseResult } from "./protocol/index.js";

// Errors
export {
  ErrorCodes,
  type ErrorCode,
  RpcError,
  ParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  ServerError,
  TransportError,
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
} from "./errors/index.js";

// Transport interfaces
export {
  type TransportState,
  type TransportOptions,
  type TransportEvents,
  type ITransport,
  type IClientTransport,
  type IServerTransport,
  type IClientConnection,
  type ClientTransportOptions,
  type ServerTransportOptions,
  type Address,
  defaultTransportOptions,
} from "./transport/index.js";

// TCP Transport
export { TcpClientTransport, TcpServerTransport, type TcpClientOptions, type TcpServerOptions } from "./transport/tcp/index.js";

// WebSocket Transport
export { WsClientTransport, WsServerTransport, type WsClientOptions, type WsServerOptions } from "./transport/ws/index.js";

// HTTP Transport
export { HttpClientTransport, HttpServerTransport, type HttpClientOptions, type HttpServerOptions, type CorsOptions } from "./transport/http/index.js";

// Utilities
export { FrameCodec, type FramingType, type FrameCodecOptions } from "./transport/frame-codec.js";
export { EventEmitter } from "./transport/event-emitter.js";
