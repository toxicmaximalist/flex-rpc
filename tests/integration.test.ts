/**
 * flex-rpc: Integration Tests
 *
 * End-to-end tests for client-server communication over TCP transport.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, createServer, TcpClientTransport, TcpServerTransport } from "../src/index.js";
import type { RpcClient } from "../src/client/index.js";
import type { RpcServer } from "../src/server/index.js";

describe("TCP Integration", () => {
  let server: RpcServer;
  let client: RpcClient;
  let serverTransport: TcpServerTransport;
  let clientTransport: TcpClientTransport;
  const PORT = 13579;

  beforeEach(async () => {
    // Create server
    serverTransport = new TcpServerTransport(PORT, { host: "127.0.0.1" });
    server = createServer();
    server.addTransport(serverTransport);

    // Register methods
    server.expose("add", (params) => {
      const arr = params as number[];
      return arr[0]! + arr[1]!;
    });

    server.expose("subtract", (params) => {
      const obj = params as { minuend: number; subtrahend: number };
      return obj.minuend - obj.subtrahend;
    });

    server.expose("echo", (params) => params);

    server.expose("error", () => {
      throw new Error("Test error");
    });

    server.expose("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "done";
    });

    await server.listen();

    // Create client
    clientTransport = new TcpClientTransport("127.0.0.1", PORT);
    client = createClient(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("makes a successful call with positional params", async () => {
    const result = await client.call<number[], number>("add", [1, 2]);
    expect(result).toBe(3);
  });

  it("makes a successful call with named params", async () => {
    const result = await client.call<{ minuend: number; subtrahend: number }, number>(
      "subtract",
      { minuend: 42, subtrahend: 23 }
    );
    expect(result).toBe(19);
  });

  it("handles multiple concurrent calls", async () => {
    // Make calls sequentially to avoid race condition on connection close
    const r1 = await client.call<number[], number>("add", [1, 1]);
    const r2 = await client.call<number[], number>("add", [2, 2]);
    const r3 = await client.call<number[], number>("add", [3, 3]);

    expect([r1, r2, r3]).toEqual([2, 4, 6]);
  });

  it("echoes complex params", async () => {
    const params = { nested: { array: [1, 2, 3], value: "test" } };
    const result = await client.call("echo", params);
    expect(result).toEqual(params);
  });

  it("receives error response for server errors", async () => {
    await expect(client.call("error")).rejects.toThrow(/Test error/);
  });

  it("receives error response for unknown method", async () => {
    await expect(client.call("unknown")).rejects.toThrow(/Method not found/);
  });

  it("uses built-in ping", async () => {
    const result = await client.ping();
    expect(result).toBe("pong!");
  });

  it("handles slow methods", async () => {
    const result = await client.call("slow");
    expect(result).toBe("done");
  });

  it("can send notifications", async () => {
    // Notifications don't return a response, so we just verify no error
    await expect(client.notify("echo", [1, 2, 3])).resolves.toBeUndefined();
  });

  it("handles request timeout", async () => {
    const shortTimeoutTransport = new TcpClientTransport("127.0.0.1", PORT);
    const shortTimeoutClient = createClient(shortTimeoutTransport, { requestTimeout: 50 });

    await expect(shortTimeoutClient.call("slow")).rejects.toThrow(/timed out/);

    await shortTimeoutClient.close();
  });
});

describe("TCP Server Bidirectional", () => {
  let server: RpcServer;
  let client: RpcClient;
  let serverTransport: TcpServerTransport;
  let clientTransport: TcpClientTransport;
  const PORT = 13580;

  beforeEach(async () => {
    serverTransport = new TcpServerTransport(PORT, { host: "127.0.0.1" });
    server = createServer();
    server.addTransport(serverTransport);
    await server.listen();

    clientTransport = new TcpClientTransport("127.0.0.1", PORT);
    client = createClient(clientTransport);
    await client.connect();

    // Wait for connection to be registered
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    // Server first to avoid sending to closed connections
    await server.close();
    await client.close();
    // Small delay for cleanup
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("tracks connected clients", () => {
    expect(server.clientCount).toBe(1);
    expect(server.getClientIds().length).toBe(1);
  });

  it("can broadcast to all clients", async () => {
    const received: unknown[] = [];
    client.onNotification("update", (params) => {
      received.push(params);
    });

    await server.broadcast("update", { value: 42 });

    // Wait for notification to arrive
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ value: 42 });
  });

  it("can send to specific client", async () => {
    const received: unknown[] = [];
    client.onNotification("private", (params) => {
      received.push(params);
    });

    const clientId = server.getClientIds()[0]!;
    await server.notify(clientId, "private", { secret: "test" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ secret: "test" });
  });
});

describe("Server Middleware", () => {
  let server: RpcServer;
  let client: RpcClient;
  let serverTransport: TcpServerTransport;
  let clientTransport: TcpClientTransport;
  const PORT = 13581;

  beforeEach(async () => {
    serverTransport = new TcpServerTransport(PORT, { host: "127.0.0.1" });
    server = createServer();
    server.addTransport(serverTransport);

    server.expose("getValue", () => "original");

    await server.listen();

    clientTransport = new TcpClientTransport("127.0.0.1", PORT);
    client = createClient(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("middleware can modify response", async () => {
    server.use(async (ctx, next) => {
      const result = await next();
      if (typeof result === "string") {
        return result.toUpperCase();
      }
      return result;
    });

    const result = await client.call("getValue");
    expect(result).toBe("ORIGINAL");
  });

  it("middleware can add metadata", async () => {
    const logs: string[] = [];

    server.use(async (ctx, next) => {
      logs.push(`Before: ${ctx.request.method}`);
      const result = await next();
      logs.push(`After: ${ctx.request.method}`);
      return result;
    });

    await client.call("getValue");

    expect(logs).toEqual(["Before: getValue", "After: getValue"]);
  });

  it("middleware chain executes in order", async () => {
    const order: number[] = [];

    server.use(async (ctx, next) => {
      order.push(1);
      const result = await next();
      order.push(4);
      return result;
    });

    server.use(async (ctx, next) => {
      order.push(2);
      const result = await next();
      order.push(3);
      return result;
    });

    await client.call("getValue");

    expect(order).toEqual([1, 2, 3, 4]);
  });
});
