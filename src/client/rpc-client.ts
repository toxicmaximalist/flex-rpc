/**
 * flex-rpc: JSON-RPC Client
 *
 * High-level client with:
 * - Transport-agnostic design
 * - Request timeout with AbortSignal
 * - Pending request management
 * - Server notification handling
 * - Typed proxy for natural method calls
 */

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcParams,
  JsonRpcId,
} from "../protocol/types.js";
import {
  createRequest,
  createNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
} from "../protocol/types.js";
import type { IClientTransport } from "../transport/interfaces.js";
import {
  RpcError,
  TimeoutError,
  TransportClosedError,
  AbortError,
} from "../errors/index.js";

// ============================================================================
// Client Options
// ============================================================================

export interface RpcClientOptions {
  /** Default request timeout in milliseconds */
  requestTimeout?: number;
  /** Whether to auto-connect on first request */
  autoConnect?: boolean;
  /** Strict mode: throw on any error response */
  strictMode?: boolean;
}

const defaultOptions: Required<RpcClientOptions> = {
  requestTimeout: 30000,
  autoConnect: true,
  strictMode: true,
};

// ============================================================================
// Pending Request
// ============================================================================

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortHandler?: () => void;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
  private readonly transport: IClientTransport;
  private readonly options: Required<RpcClientOptions>;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params?: JsonRpcParams) => void>>();
  private connected = false;

  constructor(transport: IClientTransport, options: RpcClientOptions = {}) {
    this.transport = transport;
    this.options = { ...defaultOptions, ...options };

    this.setupTransportListeners();
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Connect to the server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    await this.transport.connect();
    this.connected = true;
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new TransportClosedError("Client closed"));
      this.pendingRequests.delete(id);
    }

    this.connected = false;
    await this.transport.close();
  }

  /**
   * Make an RPC call and wait for the response
   */
  async call<TParams extends JsonRpcParams = JsonRpcParams, TResult = unknown>(
    method: string,
    params?: TParams,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<TResult> {
    await this.ensureConnected();

    const request = createRequest(method, params);
    const response = await this.sendRequest(request, options);

    if (isJsonRpcSuccessResponse(response)) {
      return response.result as TResult;
    }

    if (isJsonRpcErrorResponse(response)) {
      throw RpcError.fromJsonRpcError(response.error);
    }

    throw new Error("Invalid response");
  }

  /**
   * Send a notification (no response expected)
   */
  async notify<TParams extends JsonRpcParams = JsonRpcParams>(
    method: string,
    params?: TParams
  ): Promise<void> {
    await this.ensureConnected();

    const notification = createNotification(method, params);
    await this.transport.send(notification);
  }

  /**
   * Register a handler for server-initiated notifications
   */
  onNotification(
    method: string,
    handler: (params?: JsonRpcParams) => void
  ): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }

    this.notificationHandlers.get(method)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.notificationHandlers.get(method)?.delete(handler);
    };
  }

  /**
   * Make a batch of RPC calls
   */
  async batch<T extends BatchCall[]>(
    calls: T
  ): Promise<BatchResults<T>> {
    await this.ensureConnected();

    const requests = calls.map((call, index) => ({
      request: createRequest(call.method, call.params),
      index,
      isNotification: call.notification ?? false,
    }));

    // Send all requests
    const responsePromises = requests.map(({ request, isNotification }) => {
      if (isNotification) {
        // Convert to notification (remove id)
        const notification = createNotification(request.method, request.params);
        this.transport.send(notification);
        return Promise.resolve(null);
      }
      return this.sendRequest(request, { timeout: this.options.requestTimeout });
    });

    const responses = await Promise.all(responsePromises);

    return responses.map((response, _index) => {
      if (response === null) {
        return { success: true, result: undefined };
      }

      if (isJsonRpcSuccessResponse(response)) {
        return { success: true, result: response.result };
      }

      if (isJsonRpcErrorResponse(response)) {
        return {
          success: false,
          error: RpcError.fromJsonRpcError(response.error),
        };
      }

      return { success: false, error: new Error("Invalid response") };
    }) as BatchResults<T>;
  }

  /**
   * Create a typed proxy for natural method calls
   *
   * @example
   * const api = client.proxy<MyApi>();
   * const result = await api.math.add(1, 2);
   */
  proxy<T extends object>(): TypedProxy<T> {
    return createProxy<T>(this, "");
  }

  /**
   * Built-in ping method
   */
  async ping(): Promise<string> {
    return this.call<[], string>("ping");
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.connected && this.transport.isConnected;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private setupTransportListeners(): void {
    this.transport.on("message", (message: unknown) => {
      this.handleMessage(message as JsonRpcNotification | JsonRpcResponse);
    });

    this.transport.on("close", () => {
      this.connected = false;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new TransportClosedError());
        this.pendingRequests.delete(id);
      }
    });

    this.transport.on("error", (error: unknown) => {
      // Errors are logged but don't reject pending requests
      // (specific responses will have their own errors)
      console.error("Transport error:", error);
    });
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification): void {
    // Check if it's a response to a pending request
    if ("id" in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.abortHandler) {
          // Clean up abort listener (not directly possible, but we mark it done)
        }
        this.pendingRequests.delete(message.id);
        pending.resolve(message as JsonRpcResponse);
        return;
      }
    }

    // Check if it's a server notification
    if ("method" in message && !("id" in message)) {
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch (err) {
            console.error(`Notification handler error for ${message.method}:`, err);
          }
        }
      }
    }
  }

  private async sendRequest(
    request: JsonRpcRequest,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<JsonRpcResponse> {
    const timeout = options?.timeout ?? this.options.requestTimeout;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
      };

      // Setup timeout
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(request.id);
          reject(new TimeoutError(timeout, { requestId: request.id }));
        }, timeout);
      }

      // Setup abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new AbortError());
          return;
        }

        pending.abortHandler = () => {
          if (pending.timer) clearTimeout(pending.timer);
          this.pendingRequests.delete(request.id);
          reject(new AbortError());
        };

        options.signal.addEventListener("abort", pending.abortHandler, { once: true });
      }

      this.pendingRequests.set(request.id, pending);

      // Send the request
      this.transport.send(request).catch((err) => {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingRequests.delete(request.id);
        reject(err);
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;

    if (this.options.autoConnect) {
      await this.connect();
    } else {
      throw new TransportClosedError("Not connected");
    }
  }
}

// ============================================================================
// Batch Types
// ============================================================================

export interface BatchCall {
  method: string;
  params?: JsonRpcParams;
  notification?: boolean;
}

export type BatchResult<T = unknown> =
  | { success: true; result: T }
  | { success: false; error: RpcError | Error };

export type BatchResults<T extends BatchCall[]> = {
  [K in keyof T]: BatchResult;
};

// ============================================================================
// Typed Proxy
// ============================================================================

type TypedProxy<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K] extends object
    ? TypedProxy<T[K]>
    : never;
};

function createProxy<T>(client: RpcClient, prefix: string): TypedProxy<T> {
  return new Proxy({} as TypedProxy<T>, {
    get(_target, prop: string) {
      const method = prefix ? `${prefix}.${prop}` : prop;

      // Return a function that makes the RPC call
      const fn = (...args: unknown[]) => {
        // If args is a single object, use named params; otherwise positional
        const params = args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0])
          ? args[0] as JsonRpcParams
          : args as JsonRpcParams;

        return client.call(method, params);
      };

      // Also allow nested property access
      return new Proxy(fn, {
        get(_target, nestedProp: string) {
          return (createProxy<Record<string, unknown>>(client, method) as Record<string, unknown>)[nestedProp];
        },
      });
    },
  });
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new RPC client
 */
export function createClient(
  transport: IClientTransport,
  options?: RpcClientOptions
): RpcClient {
  return new RpcClient(transport, options);
}
