/**
 * flex-rpc: HTTP Server Transport
 *
 * HTTP server transport with:
 * - Standalone HTTP server or adapter for existing servers
 * - Request validation and size limits
 * - Batch request support
 * - CORS support
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { JsonRpcMessage, JsonRpcResponse } from "../../protocol/types.js";
import {
  type IServerTransport,
  type IClientConnection,
  type TransportState,
  type TransportEvents,
  defaultTransportOptions,
} from "../interfaces.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage, ParsedMessage } from "../../protocol/parser.js";
import { ParseError, InvalidRequestError } from "../../errors/index.js";

// ============================================================================
// HTTP Server Options
// ============================================================================

export interface HttpServerOptions {
  /** Host to bind to */
  host?: string;
  /** Maximum request body size in bytes */
  maxMessageSize?: number;
  /** Request timeout in milliseconds */
  requestTimeout?: number;
  /** Path to handle RPC requests (default: "/") */
  path?: string;
  /** Enable CORS */
  cors?: boolean | CorsOptions;
  /** Allowed HTTP methods */
  allowedMethods?: string[];
}

export interface CorsOptions {
  /** Allowed origins (default: "*") */
  origin?: string | string[] | ((origin: string) => boolean);
  /** Allowed methods */
  methods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Exposed headers */
  exposedHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache */
  maxAge?: number;
}

const defaultHttpServerOptions: Required<Omit<HttpServerOptions, "cors">> & { cors: CorsOptions | false } = {
  host: "0.0.0.0",
  maxMessageSize: defaultTransportOptions.maxMessageSize,
  requestTimeout: defaultTransportOptions.requestTimeout,
  path: "/",
  cors: false,
  allowedMethods: ["POST", "OPTIONS"],
};

const defaultCorsOptions: Required<CorsOptions> = {
  origin: "*",
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400,
};

// ============================================================================
// HTTP Request Context (acts as IClientConnection)
// ============================================================================

class HttpRequestConnection implements IClientConnection {
  public readonly id: string;
  public readonly remoteAddress: string | undefined;
  private readonly res: ServerResponse;
  private responseSent = false;
  private pendingResponses: JsonRpcResponse[] = [];
  private isBatch = false;

  constructor(id: string, req: IncomingMessage, res: ServerResponse) {
    this.id = id;
    this.res = res;
    this.remoteAddress = req.socket.remoteAddress
      ? `${req.socket.remoteAddress}:${req.socket.remotePort}`
      : undefined;
  }

  setBatch(isBatch: boolean): void {
    this.isBatch = isBatch;
  }

  async send(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    // For HTTP, we collect responses and send them all at once
    if ("result" in message || "error" in message) {
      this.pendingResponses.push(message as JsonRpcResponse);
    }
  }

  async close(_reason?: string): Promise<void> {
    // HTTP connections are closed after response is sent
  }

  /**
   * Finalize and send the HTTP response
   */
  finalize(): void {
    if (this.responseSent) return;
    this.responseSent = true;

    if (this.pendingResponses.length === 0) {
      // No response needed (all notifications)
      this.res.statusCode = 204;
      this.res.end();
      return;
    }

    const body = this.isBatch || this.pendingResponses.length > 1
      ? JSON.stringify(this.pendingResponses)
      : JSON.stringify(this.pendingResponses[0]);

    this.res.setHeader("Content-Type", "application/json");
    this.res.setHeader("Content-Length", Buffer.byteLength(body));
    this.res.statusCode = 200;
    this.res.end(body);
  }

  /**
   * Send an error response immediately
   */
  sendError(code: number, message: string, id: unknown = null): void {
    if (this.responseSent) return;
    this.responseSent = true;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id,
    });

    this.res.setHeader("Content-Type", "application/json");
    this.res.setHeader("Content-Length", Buffer.byteLength(body));
    this.res.statusCode = 200; // JSON-RPC errors still use 200
    this.res.end(body);
  }

  get isFinalized(): boolean {
    return this.responseSent;
  }
}

// ============================================================================
// HTTP Server Transport
// ============================================================================

type HttpServerEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

export class HttpServerTransport
  extends EventEmitter<HttpServerEvents>
  implements IServerTransport
{
  private server: Server | null = null;
  private _state: TransportState = "closed";
  private readonly _clients = new Map<string, HttpRequestConnection>();
  private readonly host: string;
  private readonly port: number;
  private readonly options: Required<Omit<HttpServerOptions, "cors">> & { cors: CorsOptions | false };
  private readonly corsOptions: Required<CorsOptions> | null;

  private messageHandler?: (message: JsonRpcMessage, client: IClientConnection) => void;
  private clientConnectHandler?: (client: IClientConnection) => void;
  private clientDisconnectHandler?: (client: IClientConnection, reason?: string) => void;

  constructor(port: number, options: HttpServerOptions = {}) {
    super();
    this.port = port;
    this.host = options.host ?? defaultHttpServerOptions.host;
    this.options = {
      ...defaultHttpServerOptions,
      ...options,
      cors: options.cors === true ? defaultCorsOptions : options.cors ?? false,
    };
    this.corsOptions = this.options.cors
      ? { ...defaultCorsOptions, ...(typeof this.options.cors === "object" ? this.options.cors : {}) }
      : null;
  }

  // ============================================================================
  // ITransport Implementation
  // ============================================================================

  get state(): TransportState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === "connected";
  }

  get clients(): ReadonlyMap<string, IClientConnection> {
    return this._clients;
  }

  async send(_message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    // HTTP server cannot push to clients
    throw new Error("HTTP transport does not support server-initiated messages");
  }

  async close(reason?: string): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }

    this._state = "closing";

    return new Promise((resolve) => {
      if (!this.server) {
        this._state = "closed";
        this.emit("close", reason);
        resolve();
        return;
      }

      this.server.close((_err) => {
        this.server = null;
        this._state = "closed";
        this._clients.clear();
        this.emit("close", reason);
        resolve();
      });
    });
  }

  // ============================================================================
  // IServerTransport Implementation
  // ============================================================================

  async listen(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") {
      return;
    }

    this._state = "connecting";

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (err) => {
        if (this._state === "connecting") {
          this._state = "closed";
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this._state = "connected";
        console.log(`HTTP server listening on ${this.host}:${this.port}`);
        this.emit("connect");
        resolve();
      });
    });
  }

  onMessage(handler: (message: JsonRpcMessage, client: IClientConnection) => void): void {
    this.messageHandler = handler;
  }

  onClientConnect(handler: (client: IClientConnection) => void): void {
    this.clientConnectHandler = handler;
  }

  onClientDisconnect(handler: (client: IClientConnection, reason?: string) => void): void {
    this.clientDisconnectHandler = handler;
  }

  async sendTo(_clientId: string, _message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    throw new Error("HTTP transport does not support server-initiated messages");
  }

  async broadcast(_message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    throw new Error("HTTP transport does not support server-initiated messages");
  }

  // ============================================================================
  // Request Handler Adapter
  // ============================================================================

  /**
   * Create a request handler function for use with existing HTTP servers
   * (Express, Koa, Fastify, etc.)
   */
  createHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => this.handleRequest(req, res);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Handle CORS preflight
    if (req.method === "OPTIONS" && this.corsOptions) {
      this.handleCors(req, res);
      res.statusCode = 204;
      res.end();
      return;
    }

    // Add CORS headers
    if (this.corsOptions) {
      this.handleCors(req, res);
    }

    // Check path
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== this.options.path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Check method
    if (!this.options.allowedMethods.includes(req.method ?? "")) {
      res.statusCode = 405;
      res.setHeader("Allow", this.options.allowedMethods.join(", "));
      res.end("Method Not Allowed");
      return;
    }

    // Check content type
    const contentType = req.headers["content-type"];
    if (!contentType?.includes("application/json")) {
      res.statusCode = 415;
      res.end("Unsupported Media Type");
      return;
    }

    // Create connection context
    const connectionId = randomUUID();
    const connection = new HttpRequestConnection(connectionId, req, res);
    this._clients.set(connectionId, connection);
    this.clientConnectHandler?.(connection);

    // Set request timeout
    const timeout = setTimeout(() => {
      if (!connection.isFinalized) {
        connection.sendError(-32603, "Request timeout");
        this.cleanupConnection(connectionId, connection, "timeout");
      }
    }, this.options.requestTimeout);

    try {
      // Read request body
      const body = await this.readBody(req);

      // Parse message
      const result = parseMessage(body, { maxMessageSize: this.options.maxMessageSize });

      if (!result.success) {
        connection.sendError(result.error.code, result.error.message);
        return;
      }

      // Process messages
      await this.processMessage(result.value, connection);

      // Finalize response
      connection.finalize();
    } catch (error) {
      if (!connection.isFinalized) {
        if (error instanceof ParseError) {
          connection.sendError(error.code, error.message);
        } else if (error instanceof InvalidRequestError) {
          connection.sendError(error.code, error.message);
        } else {
          connection.sendError(-32603, "Internal error");
        }
      }
    } finally {
      clearTimeout(timeout);
      this.cleanupConnection(connectionId, connection);
    }
  }

  private async processMessage(
    parsed: ParsedMessage,
    connection: HttpRequestConnection
  ): Promise<void> {
    if (parsed.type === "request") {
      this.messageHandler?.(parsed.message, connection);
    } else if (parsed.type === "notification") {
      this.messageHandler?.(parsed.message, connection);
    } else if (parsed.type === "batch") {
      connection.setBatch(true);

      // Process batch messages
      const promises = parsed.messages.map(async (item) => {
        if (item.type === "request" || item.type === "notification") {
          this.messageHandler?.(item.message, connection);
        } else if (item.type === "response") {
          // Error response from parsing
          await connection.send(item.message);
        }
      });

      await Promise.all(promises);
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.options.maxMessageSize) {
          reject(new ParseError("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });

      req.on("error", reject);
    });
  }

  private handleCors(req: IncomingMessage, res: ServerResponse): void {
    if (!this.corsOptions) return;

    const origin = req.headers.origin;

    // Check origin
    let allowedOrigin = "*";
    if (typeof this.corsOptions.origin === "string") {
      allowedOrigin = this.corsOptions.origin;
    } else if (Array.isArray(this.corsOptions.origin)) {
      if (origin && this.corsOptions.origin.includes(origin)) {
        allowedOrigin = origin;
      }
    } else if (typeof this.corsOptions.origin === "function") {
      if (origin && this.corsOptions.origin(origin)) {
        allowedOrigin = origin;
      }
    }

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", this.corsOptions.methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", this.corsOptions.allowedHeaders.join(", "));

    if (this.corsOptions.exposedHeaders.length > 0) {
      res.setHeader("Access-Control-Expose-Headers", this.corsOptions.exposedHeaders.join(", "));
    }

    if (this.corsOptions.credentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (this.corsOptions.maxAge) {
      res.setHeader("Access-Control-Max-Age", String(this.corsOptions.maxAge));
    }
  }

  private cleanupConnection(
    id: string,
    connection: HttpRequestConnection,
    reason?: string
  ): void {
    this._clients.delete(id);
    this.clientDisconnectHandler?.(connection, reason);
  }

  /**
   * Get the actual port the server is listening on
   */
  get actualPort(): number | null {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return null;
  }
}
