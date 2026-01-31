# flex-rpc

[![npm version](https://badge.fury.io/js/flex-rpc.svg)](https://www.npmjs.com/package/flex-rpc)
[![CI](https://github.com/your-username/flex-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/flex-rpc/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready JSON-RPC 2.0 library for Node.js and Bun with TCP, WebSocket, and HTTP transports.

## Features


## Installation

```bash
npm install flex-rpc
# or
bun add flex-rpc
```

## Quick Start

### Server

```typescript
import { createServer, TcpServerTransport } from "flex-rpc";

const server = createServer();
server.addTransport(new TcpServerTransport(3000));

// Expose methods
server.expose("add", (params) => params[0] + params[1]);
server.expose("greet", (params) => `Hello, ${params.name}!`);

await server.listen();
console.log("Server listening on port 3000");
```

### Client

```typescript
import { createClient, TcpClientTransport } from "flex-rpc";

const client = createClient(new TcpClientTransport("localhost", 3000));

// Make calls
const sum = await client.call("add", [1, 2]);
console.log(sum); // 3

const greeting = await client.call("greet", { name: "World" });
console.log(greeting); // "Hello, World!"

await client.close();
```

## Transports

### TCP

Best for: High-performance internal services, persistent connections

```typescript
import { TcpClientTransport, TcpServerTransport } from "flex-rpc";

// Server
const serverTransport = new TcpServerTransport(3000, {
  host: "0.0.0.0",
  keepAlive: true,
});

// Client
const clientTransport = new TcpClientTransport("localhost", 3000, {
  autoReconnect: true,
  connectionTimeout: 5000,
});
```

### WebSocket

Best for: Browser clients, bidirectional communication, real-time apps

```typescript
import { WsClientTransport, WsServerTransport } from "flex-rpc";

// Server
const serverTransport = new WsServerTransport(3001, {
  path: "/rpc",
  pingInterval: 30000,
});

// Client
const clientTransport = new WsClientTransport("ws://localhost:3001/rpc", {
  autoReconnect: true,
  protocols: ["json-rpc"],
});
```

### HTTP

Best for: REST-like APIs, stateless services, serverless

```typescript
import { HttpClientTransport, HttpServerTransport } from "flex-rpc";

// Server
const serverTransport = new HttpServerTransport(3002, {
  cors: true,
  path: "/api/rpc",
});

// Client
const clientTransport = new HttpClientTransport("http://localhost:3002/api/rpc", {
  retry: true,
  maxRetries: 3,
});
```

## Typed Proxy

Get full TypeScript support with the typed proxy:

```typescript
// Define your API interface
interface MyApi {
  math: {
    add(a: number, b: number): number;
    multiply(a: number, b: number): number;
  };
  users: {
    create(user: { name: string }): { id: string };
    get(id: string): { id: string; name: string };
  };
}

// Server: expose namespaced methods
server.expose("math.add", ([a, b]) => a + b);
server.expose("math.multiply", ([a, b]) => a * b);
server.expose("users.create", (params) => ({ id: "123", ...params }));
server.expose("users.get", ([id]) => ({ id, name: "Alice" }));

// Client: use typed proxy
const api = client.proxy<MyApi>();

const sum = await api.math.add(1, 2);        // TypeScript knows this returns number
const user = await api.users.get("123");     // TypeScript knows the return type
```

## Server Notifications

Send notifications from server to clients (TCP & WebSocket only):

```typescript
// Server
server.expose("subscribe", (params, ctx) => {
  // ctx.client contains the client connection
  console.log(`Client ${ctx.client.id} subscribed`);
  return { subscribed: true };
});

// Notify specific client
await server.notify(clientId, "update", { data: "new value" });

// Broadcast to all clients
await server.broadcast("announcement", { message: "Server restarting" });

// Client: handle notifications
client.onNotification("update", (params) => {
  console.log("Received update:", params);
});
```

## Middleware

Add cross-cutting concerns:

```typescript
// Logging middleware
server.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`→ ${ctx.request.method}`);
  
  try {
    const result = await next();
    console.log(`← ${ctx.request.method} (${Date.now() - start}ms)`);
    return result;
  } catch (error) {
    console.log(`✗ ${ctx.request.method} (${Date.now() - start}ms)`);
    throw error;
  }
});

// Auth middleware
server.use(async (ctx, next) => {
  const token = ctx.meta.get("authToken");
  if (!token && ctx.request.method !== "auth.login") {
    throw new Error("Unauthorized");
  }
  return next();
});
```

## Error Handling

Typed errors with JSON-RPC error codes:

```typescript
import {
  RpcError,
  MethodNotFoundError,
  InvalidParamsError,
  TimeoutError,
} from "flex-rpc";

// Server-side
server.expose("validate", (params) => {
  if (!params.name) {
    throw new InvalidParamsError("name is required");
  }
  return { valid: true };
});

// Client-side
try {
  await client.call("unknown-method");
} catch (error) {
  if (error instanceof MethodNotFoundError) {
    console.log("Method not found:", error.method);
  } else if (error instanceof TimeoutError) {
    console.log("Request timed out after", error.timeoutMs, "ms");
  }
}
```

## Configuration

### Client Options

```typescript
const client = createClient(transport, {
  requestTimeout: 30000,    // Default timeout for requests
  autoConnect: true,        // Connect on first request
  strictMode: true,         // Throw on error responses
});
```

### Transport Options

```typescript
// TCP
new TcpClientTransport(host, port, {
  connectionTimeout: 10000,
  requestTimeout: 30000,
  keepAlive: true,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
});

// WebSocket
new WsClientTransport(url, {
  protocols: ["json-rpc"],
  pingInterval: 30000,
  pongTimeout: 5000,
});

// HTTP
new HttpClientTransport(url, {
  headers: { Authorization: "Bearer token" },
  retry: true,
  maxRetries: 3,
});
```

## Batch Requests

```typescript
const results = await client.batch([
  { method: "add", params: [1, 2] },
  { method: "multiply", params: [3, 4] },
  { method: "greet", params: { name: "World" } },
]);

results.forEach((result, i) => {
  if (result.success) {
    console.log(`Call ${i}: ${result.result}`);
  } else {
    console.log(`Call ${i} failed: ${result.error.message}`);
  }
});
```

## Request Cancellation

```typescript
const controller = new AbortController();

// Cancel after 1 second
setTimeout(() => controller.abort(), 1000);

try {
  await client.call("slow-operation", params, { signal: controller.signal });
} catch (error) {
  if (error instanceof AbortError) {
    console.log("Request was cancelled");
  }
}
```

## Runtime Support


## API Reference

See the [full API documentation](./docs/api.md) for complete details.

## Examples

Check out the [examples](./examples) directory:


## License

MIT
