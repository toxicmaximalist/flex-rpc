/**
 * flex-rpc: Transport Interfaces
 *
 * Abstract interfaces for all transport implementations.
 * Supports both client and server transports with bidirectional messaging.
 */

import type { JsonRpcMessage, JsonRpcResponse } from "../protocol/types.js";

// ============================================================================
// Transport States
// ============================================================================

export type TransportState = "connecting" | "connected" | "closing" | "closed";

// ============================================================================
// Transport Options
// ============================================================================

export interface TransportOptions {
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Maximum message size in bytes (default: 1MB) */
  maxMessageSize?: number;
  /** Enable automatic reconnection (client only) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
  /** Reconnection delay in milliseconds */
  reconnectDelay?: number;
  /** Reconnection backoff multiplier */
  reconnectBackoffMultiplier?: number;
  /** Maximum reconnection delay in milliseconds */
  maxReconnectDelay?: number;
}

export const defaultTransportOptions: Required<TransportOptions> = {
  connectionTimeout: 10000,
  requestTimeout: 30000,
  maxMessageSize: 1024 * 1024, // 1MB
  autoReconnect: false,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  reconnectBackoffMultiplier: 2,
  maxReconnectDelay: 30000,
};

// ============================================================================
// Event Types
// ============================================================================

export interface TransportEvents {
  /** Emitted when connection is established */
  connect: () => void;
  /** Emitted when connection is closed */
  close: (reason?: string) => void;
  /** Emitted on transport error */
  error: (error: Error) => void;
  /** Emitted when a message is received */
  message: (message: JsonRpcMessage | JsonRpcResponse) => void;
  /** Emitted when transport is ready to send (after backpressure relief) */
  drain: () => void;
  /** Emitted on reconnection attempt (client only) */
  reconnecting: (attempt: number) => void;
  /** Emitted when reconnection succeeds (client only) */
  reconnected: () => void;
}

// ============================================================================
// Base Transport Interface
// ============================================================================

/**
 * Base interface for all transports
 */
export interface ITransport {
  /** Current transport state */
  readonly state: TransportState;

  /** Whether the transport is currently connected */
  readonly isConnected: boolean;

  /**
   * Send a message through the transport
   * @returns Promise that resolves when the message is sent (not when response is received)
   */
  send(message: JsonRpcMessage | JsonRpcResponse): Promise<void>;

  /**
   * Close the transport connection
   * @param reason - Optional reason for closing
   */
  close(reason?: string): Promise<void>;

  /**
   * Register an event listener
   */
  on<K extends keyof TransportEvents>(event: K, listener: (...args: unknown[]) => void): void;

  /**
   * Remove an event listener
   */
  off<K extends keyof TransportEvents>(event: K, listener: (...args: unknown[]) => void): void;

  /**
   * Register a one-time event listener
   */
  once<K extends keyof TransportEvents>(event: K, listener: (...args: unknown[]) => void): void;
}

// ============================================================================
// Client Transport Interface
// ============================================================================

export interface ClientTransportOptions extends TransportOptions {
  /** Target host */
  host: string;
  /** Target port */
  port: number;
}

/**
 * Interface for client-side transports
 */
export interface IClientTransport extends ITransport {
  /**
   * Connect to the server
   */
  connect(): Promise<void>;

  /**
   * Reconnect to the server (if disconnected)
   */
  reconnect(): Promise<void>;
}

// ============================================================================
// Server Transport Interface
// ============================================================================

export interface ServerTransportOptions extends TransportOptions {
  /** Host to bind to */
  host?: string;
  /** Port to listen on */
  port: number;
  /** Maximum concurrent connections */
  maxConnections?: number;
}

/**
 * Represents a connected client on the server side
 */
export interface IClientConnection {
  /** Unique connection ID */
  readonly id: string;

  /** Remote address info */
  readonly remoteAddress: string | undefined;

  /** Send a message to this client */
  send(message: JsonRpcMessage | JsonRpcResponse): Promise<void>;

  /** Close this client connection */
  close(reason?: string): Promise<void>;
}

/**
 * Interface for server-side transports
 */
export interface IServerTransport extends ITransport {
  /** Currently connected clients */
  readonly clients: ReadonlyMap<string, IClientConnection>;

  /**
   * Start listening for connections
   */
  listen(): Promise<void>;

  /**
   * Register handler for incoming messages from clients
   */
  onMessage(
    handler: (message: JsonRpcMessage, client: IClientConnection) => void
  ): void;

  /**
   * Register handler for client connections
   */
  onClientConnect(handler: (client: IClientConnection) => void): void;

  /**
   * Register handler for client disconnections
   */
  onClientDisconnect(handler: (client: IClientConnection, reason?: string) => void): void;

  /**
   * Send a message to a specific client
   */
  sendTo(clientId: string, message: JsonRpcMessage | JsonRpcResponse): Promise<void>;

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: JsonRpcMessage | JsonRpcResponse): Promise<void>;
}

// ============================================================================
// Address Type
// ============================================================================

export interface Address {
  host: string;
  port: number;
}
