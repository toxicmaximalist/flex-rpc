/**
 * flex-rpc: TCP Client Transport
 *
 * TCP client transport implementation with:
 * - Connection management with timeouts
 * - Automatic reconnection with exponential backoff
 * - Proper backpressure handling
 * - Keepalive support
 */

import net from "node:net";
import type { JsonRpcMessage, JsonRpcResponse } from "../../protocol/types.js";
import {
  type IClientTransport,
  type ClientTransportOptions,
  type TransportState,
  type TransportEvents,
  defaultTransportOptions,
} from "../interfaces.js";
import { FrameCodec } from "../frame-codec.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage } from "../../protocol/parser.js";
import {
  ConnectionError,
  TransportClosedError,
  TimeoutError,
  ReconnectFailedError,
} from "../../errors/index.js";

// ============================================================================
// TCP Client Options
// ============================================================================

export interface TcpClientOptions extends Omit<ClientTransportOptions, "host" | "port"> {
  /** Enable TCP keepalive */
  keepAlive?: boolean;
  /** Keepalive initial delay in milliseconds */
  keepAliveInitialDelay?: number;
  /** Disable Nagle's algorithm */
  noDelay?: boolean;
}

const defaultTcpOptions: Required<TcpClientOptions> = {
  ...defaultTransportOptions,
  keepAlive: true,
  keepAliveInitialDelay: 60000,
  noDelay: true,
};

// ============================================================================
// TCP Client Transport
// ============================================================================

type TcpClientEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

export class TcpClientTransport
  extends EventEmitter<TcpClientEvents>
  implements IClientTransport
{
  private socket: net.Socket | null = null;
  private _state: TransportState = "closed";
  private readonly host: string;
  private readonly port: number;
  private readonly options: Required<TcpClientOptions>;
  private readonly codec: FrameCodec;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(host: string, port: number, options: TcpClientOptions = {}) {
    super();
    this.host = host;
    this.port = port;
    this.options = { ...defaultTcpOptions, ...options };
    this.codec = new FrameCodec({ maxMessageSize: this.options.maxMessageSize });
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
    if (!this.socket || this._state !== "connected") {
      throw new TransportClosedError("Transport is not connected");
    }

    const data = this.codec.encode(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const canContinue = this.socket!.write(data, (err) => {
        if (err) {
          reject(new ConnectionError(err.message, { cause: err }));
        } else {
          resolve();
        }
      });

      // Handle backpressure
      if (!canContinue) {
        if (!this.drainPromise) {
          this.drainPromise = new Promise((res) => {
            this.drainResolve = res;
          });
        }
      }
    });
  }

  async close(reason?: string): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }

    this._state = "closing";
    this.clearTimers();

    return new Promise((resolve) => {
      if (!this.socket) {
        this._state = "closed";
        this.emit("close", reason);
        resolve();
        return;
      }

      // Give pending writes a chance to complete
      this.socket.end(() => {
        this.socket?.destroy();
        this.socket = null;
        this._state = "closed";
        this.codec.reset();
        this.emit("close", reason);
        resolve();
      });

      // Force close after timeout
      setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          this.socket = null;
          this._state = "closed";
          this.codec.reset();
          this.emit("close", reason);
          resolve();
        }
      }, 5000);
    });
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
      this.socket = new net.Socket();

      // Set socket options
      this.socket.setEncoding("utf8");
      if (this.options.noDelay) {
        this.socket.setNoDelay(true);
      }

      // Setup connection timeout
      this.connectionTimer = setTimeout(() => {
        if (this._state === "connecting") {
          const error = new TimeoutError(this.options.connectionTimeout, {
            data: { host: this.host, port: this.port },
          });
          this.socket?.destroy();
          this.socket = null;
          this._state = "closed";
          reject(error);
        }
      }, this.options.connectionTimeout);

      // Handle connect
      this.socket.once("connect", () => {
        this.clearConnectionTimer();
        this._state = "connected";
        this.reconnectAttempts = 0;

        // Enable keepalive after connect
        if (this.options.keepAlive) {
          this.socket!.setKeepAlive(true, this.options.keepAliveInitialDelay);
        }

        this.emit("connect");
        resolve();
      });

      // Handle errors during connect
      this.socket.once("error", (err) => {
        this.clearConnectionTimer();

        if (this._state === "connecting") {
          this.socket?.destroy();
          this.socket = null;
          this._state = "closed";
          reject(new ConnectionError(err.message, {
            address: `${this.host}:${this.port}`,
            cause: err,
          }));
        }
      });

      // Setup event handlers
      this.setupEventHandlers();

      // Initiate connection
      this.socket.connect(this.port, this.host);
    });
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on("data", (data: string) => {
      try {
        const messages = this.codec.decode(data);
        for (const raw of messages) {
          const result = parseMessage(raw);
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
        }
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.socket.on("close", (hadError) => {
      if (this._state === "closing" || this._state === "closed") {
        return;
      }

      const wasConnected = this._state === "connected";
      this._state = "closed";
      this.codec.reset();

      if (wasConnected && this.options.autoReconnect) {
        this.scheduleReconnect();
      } else {
        this.emit("close", hadError ? "error" : undefined);
      }
    });

    this.socket.on("error", (err) => {
      if (this._state !== "connecting") {
        this.emit("error", err);
      }
    });

    this.socket.on("drain", () => {
      if (this.drainResolve) {
        this.drainResolve();
        this.drainPromise = null;
        this.drainResolve = null;
      }
      this.emit("drain");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit(
        "error",
        new ReconnectFailedError(this.reconnectAttempts)
      );
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
