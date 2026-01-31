/**
 * flex-rpc: TCP Server Transport
 *
 * TCP server transport implementation with:
 * - Multi-client connection management
 * - Per-connection message handlers
 * - Graceful shutdown
 * - Connection limits
 */

import net, { Socket } from "node:net";
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
import { FrameCodec } from "../frame-codec.js";
import { EventEmitter } from "../event-emitter.js";
import { parseMessage } from "../../protocol/parser.js";
import { TransportClosedError } from "../../errors/index.js";

// ============================================================================
// TCP Server Options
// ============================================================================

export interface TcpServerOptions extends Omit<ServerTransportOptions, "port"> {
  /** Enable TCP keepalive for client connections */
  keepAlive?: boolean;
  /** Keepalive initial delay in milliseconds */
  keepAliveInitialDelay?: number;
  /** Disable Nagle's algorithm */
  noDelay?: boolean;
}

const defaultTcpServerOptions: Required<Omit<TcpServerOptions, "port">> & { host: string; maxConnections: number } = {
  ...defaultTransportOptions,
  host: "0.0.0.0",
  maxConnections: 1000,
  keepAlive: true,
  keepAliveInitialDelay: 60000,
  noDelay: true,
};

// ============================================================================
// Client Connection Implementation
// ============================================================================

class TcpClientConnection implements IClientConnection {
  public readonly id: string;
  public readonly remoteAddress: string | undefined;
  private readonly socket: Socket;
  private readonly codec: FrameCodec;
  private closed = false;

  constructor(id: string, socket: Socket, codec: FrameCodec) {
    this.id = id;
    this.socket = socket;
    this.codec = codec;
    this.remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
  }

  async send(message: JsonRpcMessage | JsonRpcResponse): Promise<void> {
    if (this.closed || this.socket.destroyed) {
      throw new TransportClosedError("Client connection is closed");
    }

    const data = this.codec.encode(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async close(_reason?: string): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    return new Promise((resolve) => {
      this.socket.end(() => {
        this.socket.destroy();
        resolve();
      });

      // Force close after timeout
      setTimeout(() => {
        if (!this.socket.destroyed) {
          this.socket.destroy();
          resolve();
        }
      }, 5000);
    });
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }
}

// ============================================================================
// TCP Server Transport
// ============================================================================

type TcpServerEvents = {
  [K in keyof TransportEvents]: Parameters<TransportEvents[K]>;
};

export class TcpServerTransport
  extends EventEmitter<TcpServerEvents>
  implements IServerTransport
{
  private server: net.Server | null = null;
  private _state: TransportState = "closed";
  private readonly _clients = new Map<string, TcpClientConnection>();
  private readonly host: string;
  private readonly port: number;
  private readonly options: TcpServerOptions;

  private messageHandler?: (message: JsonRpcMessage, client: IClientConnection) => void;
  private clientConnectHandler?: (client: IClientConnection) => void;
  private clientDisconnectHandler?: (client: IClientConnection, reason?: string) => void;

  constructor(port: number, options: TcpServerOptions = {}) {
    super();
    this.port = port;
    this.host = options.host ?? defaultTcpServerOptions.host;
    this.options = { ...defaultTcpServerOptions, ...options };
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
    // Server sends to all clients by default
    await this.broadcast(message);
  }

  async close(reason?: string): Promise<void> {
    if (this._state === "closed" || this._state === "closing") {
      return;
    }

    this._state = "closing";

    // Close all client connections
    const closePromises = Array.from(this._clients.values()).map((client) =>
      client.close(reason)
    );
    await Promise.all(closePromises);

    // Close server
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
      this.server = net.createServer((socket) => {
        this.handleNewConnection(socket);
      });

      this.server.maxConnections = this.options.maxConnections ?? defaultTcpServerOptions.maxConnections;

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
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          console.log(`TCP server listening on ${addr.address}:${addr.port}`);
        }
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
      .map((client) => client.send(message).catch(() => {})); // Ignore individual send failures

    await Promise.all(promises);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private handleNewConnection(socket: Socket): void {
    const clientId = randomUUID();
    const codec = new FrameCodec({ maxMessageSize: this.options.maxMessageSize ?? defaultTcpServerOptions.maxMessageSize });
    const client = new TcpClientConnection(clientId, socket, codec);

    // Configure socket
    socket.setEncoding("utf8");
    if (this.options.noDelay ?? defaultTcpServerOptions.noDelay) {
      socket.setNoDelay(true);
    }
    if (this.options.keepAlive ?? defaultTcpServerOptions.keepAlive) {
      socket.setKeepAlive(true, this.options.keepAliveInitialDelay ?? defaultTcpServerOptions.keepAliveInitialDelay);
    }

    this._clients.set(clientId, client);
    this.clientConnectHandler?.(client);

    // Handle incoming data
    socket.on("data", (data: string) => {
      try {
        const messages = codec.decode(data);
        for (const raw of messages) {
          const result = parseMessage(raw);
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
        }
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Handle client disconnect
    socket.on("close", (hadError) => {
      this._clients.delete(clientId);
      this.clientDisconnectHandler?.(client, hadError ? "error" : undefined);
    });

    socket.on("error", (err) => {
      // Errors are typically followed by close event
      this.emit("error", err);
    });
  }

  /**
   * Get the actual port the server is listening on
   * (useful when port 0 was specified)
   */
  get actualPort(): number | null {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return null;
  }
}
