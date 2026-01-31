/**
 * flex-rpc: WebSocket Server Transport
 *
 * WebSocket server transport using ws package with:
 * - Multi-client connection management
 * - Ping/pong keepalive
 * - Per-connection message handlers
 * - Graceful shutdown
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import type { JsonRpcMessage, JsonRpcResponse } from "../../protocol/types.js";
import {
  type IServerTransport,
  type IClientConnection,
  type ServerTransportOptions,
  type TransportState,
  type TransportEvents,
  defaultTransportOptions,
} from "../interfaces.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage } from "../../protocol/parser.js";
import { TransportClosedError } from "../../errors/index.js";

// ============================================================================
// WebSocket Server Options
// ============================================================================

export interface WsServerOptions extends Omit<ServerTransportOptions, "port"> {
  /** Existing HTTP(S) server to attach to */
  server?: HttpServer | HttpsServer;
  /** WebSocket path (default: "/") */
  path?: string;
  /** Ping interval in milliseconds (0 to disable) */
  pingInterval?: number;
  /** Client pong timeout in milliseconds */
  pongTimeout?: number;
  /** Enable per-message deflate compression */
  perMessageDeflate?: boolean;
}

const defaultWsServerOptions: Required<Omit<WsServerOptions, "server" | "port">> & { server?: HttpServer | HttpsServer } = {
  ...defaultTransportOptions,
  host: "0.0.0.0",
  maxConnections: 1000,
  path: "/",
  pingInterval: 30000,
  pongTimeout: 5000,
  perMessageDeflate: false,
};

// ============================================================================
// Client Connection Implementation
// ============================================================================

class WsClientConnection implements IClientConnection {
  public readonly id: string;
  public readonly remoteAddress: string | undefined;
  private readonly ws: WebSocket;
  private closed = false;
  private alive = true;

  constructor(id: string, ws: WebSocket, remoteAddress: string | undefined) {
    this.id = id;
    this.ws = ws;
    this.remoteAddress = remoteAddress;

    // Handle pong
    ws.on("pong", () => {
      this.alive = true;
    });
  }

  async send(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new TransportClosedError("Client connection is closed");
    }

    const data = JSON.stringify(message);

    return new Promise((resolve, reject) => {
      this.ws.send(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.ws.close(1000, reason ?? "Server closing connection");
  }

  get isClosed(): boolean {
    return this.closed || this.ws.readyState !== WebSocket.OPEN;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  markDead(): void {
    this.alive = false;
  }

  ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
  }
}

// ============================================================================
// WebSocket Server Transport
// ============================================================================

type WsServerEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

export class WsServerTransport
  extends EventEmitter<WsServerEvents>
  implements IServerTransport
{
  private wss: WebSocketServer | null = null;
  private _state: TransportState = "closed";
  private readonly _clients = new Map<string, WsClientConnection>();
  private readonly host: string;
  private readonly port: number;
  private readonly options: Required<Omit<WsServerOptions, "server">> & { server?: HttpServer | HttpsServer };
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private messageHandler?: (message: JsonRpcMessage, client: IClientConnection) => void;
  private clientConnectHandler?: (client: IClientConnection) => void;
  private clientDisconnectHandler?: (client: IClientConnection, reason?: string) => void;

  constructor(port: number, options: WsServerOptions = {}) {
    super();
    this.port = port;
    this.host = options.host ?? defaultWsServerOptions.host;
    this.options = { ...defaultWsServerOptions, ...options };
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

  async send(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    await this.broadcast(message);
  }

  async close(reason?: string): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }

    this._state = "closing";
    this.stopPingInterval();

    // Close all client connections
    const closePromises = Array.from(this._clients.values()).map((client) =>
      client.close(reason)
    );
    await Promise.all(closePromises);

    // Close server
    return new Promise((resolve) => {
      if (!this.wss) {
        this._state = "closed";
        this.emit("close", reason);
        resolve();
        return;
      }

      this.wss.close((_err) => {
        this.wss = null;
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
      try {
        const wssOptions: Record<string, unknown> = {
          path: this.options.path,
          maxPayload: this.options.maxMessageSize,
          perMessageDeflate: this.options.perMessageDeflate,
        };

        if (this.options.server) {
          // Attach to existing HTTP(S) server
          wssOptions.server = this.options.server;
        } else {
          // Create standalone server
          wssOptions.host = this.host;
          wssOptions.port = this.port;
        }

        this.wss = new WebSocketServer(wssOptions as ConstructorParameters<typeof WebSocketServer>[0]);

        this.wss.on("error", (err) => {
          if (this._state === "connecting") {
            this._state = "closed";
            reject(err);
          } else {
            this.emit("error", err);
          }
        });

        this.wss.on("listening", () => {
          this._state = "connected";
          this.startPingInterval();
          const addr = this.wss!.address();
          if (addr && typeof addr === "object") {
            console.log(`WebSocket server listening on ${addr.address}:${addr.port}`);
          }
          this.emit("connect");
          resolve();
        });

        this.wss.on("connection", (ws, req) => {
          this.handleNewConnection(ws, req);
        });

        // If attached to existing server, it's already listening
        if (this.options.server) {
          this._state = "connected";
          this.startPingInterval();
          this.emit("connect");
          resolve();
        }
      } catch (err) {
        this._state = "closed";
        reject(err);
      }
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

  async sendTo(clientId: string, message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    const client = this._clients.get(clientId);
    if (!client) {
      throw new TransportClosedError(`Client ${clientId} not found`);
    }
    await client.send(message);
  }

  async broadcast(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    const promises = Array.from(this._clients.values())
      .filter((client) => !client.isClosed)
      .map((client) => client.send(message).catch(() => {}));

    await Promise.all(promises);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private handleNewConnection(ws: WebSocket, req: IncomingMessage): void {
    // Check connection limit
    if (this._clients.size >= (this.options.maxConnections ?? Infinity)) {
      ws.close(1013, "Server at capacity");
      return;
    }

    const clientId = randomUUID();
    const remoteAddress = req.socket.remoteAddress
      ? `${req.socket.remoteAddress}:${req.socket.remotePort}`
      : undefined;
    const client = new WsClientConnection(clientId, ws, remoteAddress);

    this._clients.set(clientId, client);
    this.clientConnectHandler?.(client);

    // Handle incoming messages
    ws.on("message", (data: RawData) => {
      try {
        const message = data.toString("utf8");

        // Handle application-level ping
        if (message === "__ping__") {
          ws.send("__pong__");
          return;
        }

        const result = parseMessage(message);
        if (result.success) {
          const parsed = result.value;
          if (parsed.type === "request" || parsed.type === "notification") {
            this.messageHandler?.(parsed.message, client);
          } else if (parsed.type === "batch") {
            for (const item of parsed.messages) {
              if (item.type === "request" || item.type === "notification") {
                this.messageHandler?.(item.message, client);
              }
            }
          }
        } else {
          // Send error response for parse errors
          client.send({
            jsonrpc: "2.0",
            error: { code: result.error.code, message: result.error.message },
            id: null,
          }).catch(() => {});
        }
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Handle client disconnect
    ws.on("close", (_code, reason) => {
      this._clients.delete(clientId);
      this.clientDisconnectHandler?.(client, reason.toString() || undefined);
    });

    ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  private startPingInterval(): void {
    if (this.options.pingInterval <= 0) return;

    this.pingTimer = setInterval(() => {
      for (const client of this._clients.values()) {
        if (!client.isAlive) {
          // Client didn't respond to previous ping
          client.close("Ping timeout");
          continue;
        }

        client.markDead();
        client.ping();
      }
    }, this.options.pingInterval);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Get the actual port the server is listening on
   */
  get actualPort(): number | null {
    const addr = this.wss?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return null;
  }
}
