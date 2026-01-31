/**
 * flex-rpc: JSON-RPC Server
 *
 * High-level server with:
 * - Transport-agnostic design
 * - Multiple simultaneous transports
 * - Method registration with metadata
 * - Middleware/interceptor chain
 * - Server-to-client notifications
 * - Per-method concurrency limits
 */

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcId,
} from "../protocol/types.js";
import {
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  isJsonRpcRequest,
} from "../protocol/types.js";
import type { IServerTransport, IClientConnection } from "../transport/interfaces.js";
import {
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  wrapError,
} from "../errors/index.js";

// ============================================================================
// Server Options
// ============================================================================

export interface RpcServerOptions {
  /** Enable built-in ping handler */
  enablePing?: boolean;
  /** Global concurrency limit (0 = unlimited) */
  maxConcurrency?: number;
  /** Enable strict mode (reject invalid requests immediately) */
  strictMode?: boolean;
}

const defaultOptions: Required<RpcServerOptions> = {
  enablePing: true,
  maxConcurrency: 0,
  strictMode: true,
};

// ============================================================================
// Method Handler Types
// ============================================================================

export type MethodHandler<TParams extends JsonRpcParams = JsonRpcParams, TResult = unknown> = (
  params: TParams | undefined,
  context: RequestContext
) => TResult | Promise<TResult>;

export interface MethodOptions {
  /** Method description */
  description?: string;
  /** Per-method concurrency limit */
  maxConcurrency?: number;
  /** Parameter validation function */
  validateParams?: (params: unknown) => boolean;
}

interface RegisteredMethod {
  handler: MethodHandler;
  options: MethodOptions;
  currentConcurrency: number;
}

// ============================================================================
// Request Context
// ============================================================================

export interface RequestContext {
  /** The client that sent the request */
  client: IClientConnection;
  /** The original request */
  request: JsonRpcRequest | JsonRpcNotification;
  /** Request ID (null for notifications) */
  id: JsonRpcId | null;
  /** Request metadata */
  meta: Map<string, unknown>;
}

// ============================================================================
// Middleware Types
// ============================================================================

export type NextFunction = () => Promise<unknown>;

export type Middleware = (
  context: RequestContext,
  next: NextFunction
) => Promise<unknown>;

// ============================================================================
// RPC Server
// ============================================================================

export class RpcServer {
  private readonly transports: IServerTransport[] = [];
  private readonly methods = new Map<string, RegisteredMethod>();
  private readonly middleware: Middleware[] = [];
  private readonly options: Required<RpcServerOptions>;
  private readonly connectedClients = new Map<string, IClientConnection>();
  private globalConcurrency = 0;

  constructor(options: RpcServerOptions = {}) {
    this.options = { ...defaultOptions, ...options };

    if (this.options.enablePing) {
      this.expose("ping", () => "pong!");
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Add a transport to the server
   */
  addTransport(transport: IServerTransport): this {
    this.transports.push(transport);
    this.setupTransportListeners(transport);
    return this;
  }

  /**
   * Start listening on all transports
   */
  async listen(): Promise<void> {
    await Promise.all(this.transports.map((t) => t.listen()));
  }

  /**
   * Stop all transports
   */
  async close(): Promise<void> {
    await Promise.all(this.transports.map((t) => t.close()));
    this.connectedClients.clear();
  }

  /**
   * Register an RPC method
   */
  expose<TParams extends JsonRpcParams = JsonRpcParams, TResult = unknown>(
    method: string,
    handler: MethodHandler<TParams, TResult>,
    options: MethodOptions = {}
  ): this {
    this.methods.set(method, {
      handler: handler as MethodHandler,
      options,
      currentConcurrency: 0,
    });
    return this;
  }

  /**
   * Unregister an RPC method
   */
  unexpose(method: string): boolean {
    return this.methods.delete(method);
  }

  /**
   * Add middleware to the processing chain
   */
  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Send a notification to a specific client
   */
  async notify(
    clientId: string,
    method: string,
    params?: JsonRpcParams
  ): Promise<void> {
    const client = this.connectedClients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }

    const notification = createNotification(method, params);
    await client.send(notification);
  }

  /**
   * Broadcast a notification to all connected clients
   */
  async broadcast(method: string, params?: JsonRpcParams): Promise<void> {
    const notification = createNotification(method, params);
    const promises = Array.from(this.connectedClients.values()).map((client) =>
      client.send(notification).catch(() => {})
    );
    await Promise.all(promises);
  }

  /**
   * Get list of registered methods
   */
  getMethods(): string[] {
    return Array.from(this.methods.keys());
  }

  /**
   * Get method metadata
   */
  getMethodInfo(method: string): MethodOptions | undefined {
    return this.methods.get(method)?.options;
  }

  /**
   * Get connected client count
   */
  get clientCount(): number {
    return this.connectedClients.size;
  }

  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.connectedClients.keys());
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private setupTransportListeners(transport: IServerTransport): void {
    transport.onMessage((message, client) => {
      this.handleMessage(message, client);
    });

    transport.onClientConnect((client) => {
      this.connectedClients.set(client.id, client);
    });

    transport.onClientDisconnect((client) => {
      this.connectedClients.delete(client.id);
    });
  }

  private async handleMessage(
    message: JsonRpcRequest | JsonRpcNotification,
    client: IClientConnection
  ): Promise<void> {
    const isRequest = isJsonRpcRequest(message);
    const id = isRequest ? message.id : null;

    const context: RequestContext = {
      client,
      request: message,
      id,
      meta: new Map(),
    };

    try {
      const result = await this.processRequest(context);

      // Only send response for requests (not notifications)
      if (isRequest && id !== undefined) {
        const response = createSuccessResponse(id, result);
        await client.send(response).catch(() => {
          // Client disconnected before response was sent - this is normal
        });
      }
    } catch (error) {
      // Only send error response for requests
      if (isRequest && id !== undefined) {
        const rpcError = wrapError(error);
        const response = createErrorResponse(id, rpcError.code, rpcError.message, rpcError.data);
        await client.send(response).catch(() => {
          // Client disconnected before error response was sent - this is normal
        });
      }
    }
  }

  private async processRequest(context: RequestContext): Promise<unknown> {
    // Build middleware chain
    const chain = this.buildMiddlewareChain(context);
    return chain();
  }

  private buildMiddlewareChain(context: RequestContext): NextFunction {
    let index = 0;

    const next: NextFunction = async () => {
      if (index < this.middleware.length) {
        const middleware = this.middleware[index++];
        return middleware!(context, next);
      }

      // End of middleware chain - execute the actual handler
      return this.executeHandler(context);
    };

    return next;
  }

  private async executeHandler(context: RequestContext): Promise<unknown> {
    const { request } = context;
    const method = this.methods.get(request.method);

    if (!method) {
      throw new MethodNotFoundError(request.method);
    }

    // Check global concurrency
    if (this.options.maxConcurrency > 0 && this.globalConcurrency >= this.options.maxConcurrency) {
      throw new InternalError("Server at capacity");
    }

    // Check per-method concurrency
    if (
      method.options.maxConcurrency &&
      method.currentConcurrency >= method.options.maxConcurrency
    ) {
      throw new InternalError(`Method ${request.method} at capacity`);
    }

    // Validate params
    if (method.options.validateParams && request.params !== undefined) {
      if (!method.options.validateParams(request.params)) {
        throw new InvalidParamsError();
      }
    }

    // Execute handler
    this.globalConcurrency++;
    method.currentConcurrency++;

    try {
      const result = await method.handler(request.params, context);
      return result;
    } finally {
      this.globalConcurrency--;
      method.currentConcurrency--;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new RPC server
 */
export function createServer(options?: RpcServerOptions): RpcServer {
  return new RpcServer(options);
}
