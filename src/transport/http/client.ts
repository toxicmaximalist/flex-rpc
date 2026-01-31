/**
 * flex-rpc: HTTP Client Transport
 *
 * HTTP client transport using native fetch() with:
 * - Request timeout via AbortController
 * - Batch request support
 * - Custom headers and authentication
 * - Retry with backoff
 */

import type { JsonRpcMessage, JsonRpcResponse, JsonRpcBatchResponse } from "../../protocol/types.js";
import {
  type IClientTransport,
  type TransportState,
  type TransportEvents,
  defaultTransportOptions,
} from "../interfaces.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage } from "../../protocol/parser.js";
import {
  ConnectionError,
  TimeoutError,
  AbortError,
  TransportClosedError,
} from "../../errors/index.js";

// ============================================================================
// HTTP Client Options
// ============================================================================

export interface HttpClientOptions {
  /** Request timeout in milliseconds */
  requestTimeout?: number;
  /** Maximum message size in bytes */
  maxMessageSize?: number;
  /** Custom headers */
  headers?: Record<string, string>;
  /** HTTP method (default: POST) */
  method?: "POST" | "GET";
  /** Enable credentials (cookies) */
  credentials?: "omit" | "same-origin" | "include";
  /** Retry failed requests */
  retry?: boolean;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Retry delay in milliseconds */
  retryDelay?: number;
}

const defaultHttpOptions: Required<HttpClientOptions> = {
  requestTimeout: defaultTransportOptions.requestTimeout,
  maxMessageSize: defaultTransportOptions.maxMessageSize,
  headers: {},
  method: "POST",
  credentials: "omit",
  retry: false,
  maxRetries: 3,
  retryDelay: 1000,
};

// ============================================================================
// HTTP Client Transport
// ============================================================================

type HttpClientEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

/**
 * HTTP Client Transport
 *
 * Note: HTTP is stateless, so this transport doesn't maintain a persistent connection.
 * The `connect()` method is a no-op, and `state` reflects readiness to make requests.
 *
 * Server → Client notifications are NOT supported over HTTP (use WebSocket for that).
 */
export class HttpClientTransport
  extends EventEmitter<HttpClientEvents>
  implements IClientTransport
{
  private _state: TransportState = "closed";
  private readonly url: string;
  private readonly options: Required<HttpClientOptions>;
  private abortController: AbortController | null = null;

  constructor(url: string, options: HttpClientOptions = {}) {
    super();
    this.url = url;
    this.options = { ...defaultHttpOptions, ...options };
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

  /**
   * Send a message and return the response
   *
   * For HTTP transport, this actually performs the request and returns
   * when the response is received (unlike streaming transports).
   */
  async send(message: JsonRpcMessage): Promise<void> {
    if (this._state !== "connected") {
      throw new TransportClosedError("Transport is not connected");
    }

    // For HTTP, we typically want request-response, but the interface
    // expects fire-and-forget. The response comes via the 'message' event.
    await this.doRequest(message);
  }

  async close(_reason?: string): Promise<void> {
    if (this._state === "closed") return;

    // Abort any pending request
    this.abortController?.abort();
    this.abortController = null;

    this._state = "closed";
    this.emit("close", _reason);
  }

  // ============================================================================
  // IClientTransport Implementation
  // ============================================================================

  async connect(): Promise<void> {
    if (this._state === "connected") return;

    // HTTP is stateless - "connecting" just means we're ready to make requests
    this._state = "connected";
    this.emit("connect");
  }

  async reconnect(): Promise<void> {
    await this.close("reconnecting");
    await this.connect();
  }

  // ============================================================================
  // HTTP-Specific Methods
  // ============================================================================

  /**
   * Make a JSON-RPC request and return the response
   *
   * This is the primary method for HTTP transport, providing a more natural
   * request-response pattern.
   */
  async request<TResult = unknown>(
    message: JsonRpcMessage,
    signal?: AbortSignal
  ): Promise<JsonRpcResponse<TResult>> {
    if (this._state !== "connected") {
      throw new TransportClosedError("Transport is not connected");
    }

    return this.doRequest(message, signal) as Promise<JsonRpcResponse<TResult>>;
  }

  /**
   * Make a batch request and return all responses
   */
  async batchRequest(
    messages: JsonRpcMessage[],
    signal?: AbortSignal
  ): Promise<JsonRpcBatchResponse> {
    if (this._state !== "connected") {
      throw new TransportClosedError("Transport is not connected");
    }

    const response = await this.doFetch(messages, signal);
    return response as JsonRpcBatchResponse;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async doRequest(
    message: JsonRpcMessage | JsonRpcMessage[],
    externalSignal?: AbortSignal
  ): Promise<JsonRpcResponse | JsonRpcBatchResponse> {
    const response = await this.doFetch(message, externalSignal);

    // Emit the response via the message event for interface compatibility
    if (Array.isArray(response)) {
      for (const r of response) {
        this.emit("message", r);
      }
    } else {
      this.emit("message", response);
    }

    return response;
  }

  private async doFetch(
    message: JsonRpcMessage | JsonRpcMessage[],
    externalSignal?: AbortSignal,
    attempt = 1
  ): Promise<JsonRpcResponse | JsonRpcBatchResponse> {
    // Create abort controller for timeout
    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, this.options.requestTimeout);

    // Combine with external signal if provided
    const signal = externalSignal
      ? this.combineAbortSignals(this.abortController.signal, externalSignal)
      : this.abortController.signal;

    const body = JSON.stringify(message);

    // Check message size
    const size = Buffer.byteLength(body, "utf8");
    if (size > this.options.maxMessageSize) {
      clearTimeout(timeoutId);
      throw new Error(`Message size ${size} exceeds maximum ${this.options.maxMessageSize}`);
    }

    try {
      const response = await fetch(this.url, {
        method: this.options.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.options.headers,
        },
        body,
        credentials: this.options.credentials,
        signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new ConnectionError(`HTTP ${response.status}: ${errorText}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType?.includes("application/json")) {
        throw new ConnectionError(
          `Unexpected content-type: ${contentType}, expected application/json`
        );
      }

      const text = await response.text();

      // Check response size
      if (Buffer.byteLength(text, "utf8") > this.options.maxMessageSize) {
        throw new Error("Response size exceeds maximum");
      }

      const result = parseMessage(text);
      if (!result.success) {
        throw result.error;
      }

      if (result.value.type === "response") {
        return result.value.message;
      } else if (result.value.type === "batch") {
        // Extract responses from batch
        return result.value.messages
          .filter((m): m is { type: "response"; message: JsonRpcResponse } => m.type === "response")
          .map((m) => m.message);
      }

      throw new ConnectionError("Unexpected response type");
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort
      if (error instanceof Error && error.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new AbortError("Request aborted");
        }
        throw new TimeoutError(this.options.requestTimeout);
      }

      // Retry logic
      if (
        this.options.retry &&
        attempt < this.options.maxRetries &&
        this.isRetryableError(error)
      ) {
        await this.sleep(this.options.retryDelay * attempt);
        return this.doFetch(message, externalSignal, attempt + 1);
      }

      // Re-throw known errors
      if (error instanceof ConnectionError || error instanceof TimeoutError) {
        throw error;
      }

      // Wrap unknown errors
      const errorCause = error instanceof Error ? error : undefined;
      throw new ConnectionError(
        error instanceof Error ? error.message : "Request failed",
        errorCause ? { cause: errorCause } : undefined
      );
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof TimeoutError) return true;
    if (error instanceof ConnectionError) {
      // Retry on network errors, not on 4xx
      return !error.message.includes("HTTP 4");
    }
    return false;
  }

  private combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }

      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    return controller.signal;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
