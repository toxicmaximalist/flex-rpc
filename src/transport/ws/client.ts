/**
 * flex-rpc: WebSocket Client Transport
 *
 * WebSocket client transport with:
 * - Native WebSocket in modern runtimes (Bun, Node 22+)
 * - ws package fallback for Node 20
 * - Automatic reconnection with exponential backoff
 * - Ping/pong keepalive
 */

import type { JsonRpcMessage, JsonRpcResponse } from "../../protocol/types.js";
import {
  type IClientTransport,
  type ClientTransportOptions,
  type TransportState,
  type TransportEvents,
  defaultTransportOptions,
} from "../interfaces.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage } from "../../protocol/parser.js";
import {
  ConnectionError,
  TransportClosedError,
  TimeoutError,
  ReconnectFailedError,
} from "../../errors/index.js";

// Import ws package for Node.js compatibility
import WebSocketImpl from "ws";

// Use native WebSocket if available, otherwise ws package
const WebSocketClass: typeof WebSocket =
  typeof globalThis.WebSocket !== "undefined" ? globalThis.WebSocket : (WebSocketImpl as unknown as typeof WebSocket);

// ============================================================================
// WebSocket Client Options
// ============================================================================

export interface WsClientOptions extends Omit<ClientTransportOptions, "host" | "port"> {
  /** WebSocket subprotocols */
  protocols?: string | string[];
  /** Additional headers for ws package (Node.js only, ignored in browser) */
  headers?: Record<string, string>;
  /** Ping interval in milliseconds (0 to disable) */
  pingInterval?: number;
  /** Pong timeout in milliseconds */
  pongTimeout?: number;
}

const defaultWsOptions: Required<WsClientOptions> = {
  ...defaultTransportOptions,
  protocols: [],
  headers: {},
  pingInterval: 30000,
  pongTimeout: 5000,
};

// ============================================================================
// WebSocket Client Transport
// ============================================================================

type WsClientEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

export class WsClientTransport
  extends EventEmitter<WsClientEvents>
  implements IClientTransport
{
  private ws: WebSocket | null = null;
  private _state: TransportState = "closed";
  private readonly url: string;
  private readonly options: Required<WsClientOptions>;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;

  /**
   * Create a new WebSocket client transport
   * @param url - WebSocket URL (ws:// or wss://)
   * @param options - Connection options
   */
  constructor(url: string, options: WsClientOptions = {}) {
    super();
    this.url = url;
    this.options = { ...defaultWsOptions, ...options };
  }

  /**
   * Create from host and port
   */
  static fromAddress(
    host: string,
    port: number,
    options: WsClientOptions & { secure?: boolean; path?: string } = {}
  ): WsClientTransport {
    const protocol = options.secure ? "wss" : "ws";
    const path = options.path ?? "/";
    const url = `${protocol}://${host}:${port}${path}`;
    return new WsClientTransport(url, options);
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

  async send(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    if (!this.ws || this._state !== "connected") {
      throw new TransportClosedError("Transport is not connected");
    }

    const data = JSON.stringify(message);

    // Check message size
    const size = Buffer.byteLength(data, "utf8");
    if (size > this.options.maxMessageSize) {
      throw new Error(`Message size ${size} exceeds maximum ${this.options.maxMessageSize}`);
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws!.send(data);
        resolve();
      } catch (err) {
        const errorCause = err instanceof Error ? err : undefined;
        reject(new ConnectionError(
          err instanceof Error ? err.message : "Send failed",
          errorCause ? { cause: errorCause } : undefined
        ));
      }
    });
  }

  async close(reason?: string): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }

    this._state = "closing";
    this.clearTimers();

    if (this.ws) {
      this.ws.close(1000, reason ?? "Normal closure");
      this.ws = null;
    }

    this._state = "closed";
    this.emit("close", reason);
  }

  // ============================================================================
  // IClientTransport Implementation
  // ============================================================================

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") {
      return;
    }

    this._state = "connecting";
    this.reconnectAttempts = 0;

    return this.doConnect();
  }

  async reconnect(): Promise<void> {
    if (this._state === "connecting") {
      return;
    }

    await this.close("reconnecting");
    this._state = "connecting";

    return this.doConnect();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket with optional protocols
        // Note: ws package supports headers, native WebSocket doesn't
        if (this.options.headers && Object.keys(this.options.headers).length > 0) {
          // Using ws package which supports headers
          this.ws = new WebSocketImpl(this.url, this.options.protocols, {
            headers: this.options.headers,
          }) as unknown as WebSocket;
        } else {
          this.ws = new WebSocketClass(
            this.url,
            this.options.protocols.length > 0 ? this.options.protocols : undefined
          );
        }
      } catch (err) {
        this._state = "closed";
        const errorCause = err instanceof Error ? err : undefined;
        reject(new ConnectionError(
          err instanceof Error ? err.message : "Failed to create WebSocket",
          errorCause ? { cause: errorCause } : undefined
        ));
        return;
      }

      // Setup connection timeout
      this.connectionTimer = setTimeout(() => {
        if (this._state === "connecting") {
          const error = new TimeoutError(this.options.connectionTimeout);
          this.ws?.close();
          this.ws = null;
          this._state = "closed";
          reject(error);
        }
      }, this.options.connectionTimeout);

      // Handle open
      this.ws.onopen = () => {
        this.clearConnectionTimer();
        this._state = "connected";
        this.reconnectAttempts = 0;
        this.startPingInterval();
        this.emit("connect");
        resolve();
      };

      // Handle errors
      this.ws.onerror = (_event) => {
        const errorMessage = "WebSocket error";

        if (this._state === "connecting") {
          this.clearConnectionTimer();
          this._state = "closed";
          reject(new ConnectionError(errorMessage));
        } else {
          this.emit("error", new Error(errorMessage));
        }
      };

      // Handle messages
      this.ws.onmessage = (event) => {
        // Handle pong response
        if (event.data === "__pong__") {
          this.handlePong();
          return;
        }

        try {
          const result = parseMessage(event.data as string);
          if (result.success) {
            const parsed = result.value;
            if (parsed.type === "response") {
              this.emit("message", parsed.message);
            } else if (parsed.type === "request" || parsed.type === "notification") {
              this.emit("message", parsed.message);
            }
          } else {
            this.emit("error", result.error);
          }
        } catch (err) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      };

      // Handle close
      this.ws.onclose = (event) => {
        this.stopPingInterval();

        if (this._state === "closing" || this._state === "closed") {
          return;
        }

        const wasConnected = this._state === "connected";
        this._state = "closed";

        if (wasConnected && this.options.autoReconnect) {
          this.scheduleReconnect();
        } else {
          this.emit("close", event.reason || undefined);
        }
      };
    });
  }

  private startPingInterval(): void {
    if (this.options.pingInterval <= 0) return;

    this.pingTimer = setInterval(() => {
      if (this.ws && this._state === "connected" && !this.awaitingPong) {
        this.sendPing();
      }
    }, this.options.pingInterval);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.awaitingPong = false;
  }

  private sendPing(): void {
    if (!this.ws || this._state !== "connected") return;

    try {
      // Use WebSocket ping frame if available (ws package)
      const wsWithPing = this.ws as unknown as { ping?: (data?: string) => void };
      if (typeof wsWithPing.ping === "function") {
        wsWithPing.ping();
      } else {
        // Fallback to application-level ping
        this.ws.send("__ping__");
      }

      this.awaitingPong = true;

      this.pongTimer = setTimeout(() => {
        if (this.awaitingPong) {
          // Pong timeout - connection may be dead
          this.emit("error", new TimeoutError(this.options.pongTimeout));
          this.ws?.close(4000, "Pong timeout");
        }
      }, this.options.pongTimeout);
    } catch {
      // Ignore ping errors
    }
  }

  private handlePong(): void {
    this.awaitingPong = false;
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit("error", new ReconnectFailedError(this.reconnectAttempts));
      this.emit("close", "reconnect_failed");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.options.reconnectDelay *
        Math.pow(this.options.reconnectBackoffMultiplier, this.reconnectAttempts - 1),
      this.options.maxReconnectDelay
    );

    this.emit("reconnecting", this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        this._state = "connecting";
        await this.doConnect();
        this.emit("reconnected");
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearTimers(): void {
    this.clearConnectionTimer();
    this.stopPingInterval();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }
}
