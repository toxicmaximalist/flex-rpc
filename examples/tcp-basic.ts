/**
 * flex-rpc: TCP Transport Example
 *
 * Demonstrates basic TCP client-server communication.
 */

import { createClient, createServer, TcpClientTransport, TcpServerTransport } from "../src/index.js";

const PORT = 3000;

// ============================================================================
// Server Setup
// ============================================================================

async function startServer() {
  const transport = new TcpServerTransport(PORT, { host: "127.0.0.1" });
  const server = createServer();
  server.addTransport(transport);

  // Register methods
  server.expose("add", (params) => {
    const [a, b] = params as [number, number];
    return a + b;
  });

  server.expose("subtract", (params) => {
    const { minuend, subtrahend } = params as { minuend: number; subtrahend: number };
    return minuend - subtrahend;
  });

  server.expose("multiply", (params) => {
    const [a, b] = params as [number, number];
    return a * b;
  });

  server.expose("divide", (params) => {
    const [a, b] = params as [number, number];
    if (b === 0) throw new Error("Division by zero");
    return a / b;
  });

  // Async method
  server.expose("slowOperation", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return "Operation completed";
  });

  await server.listen();
  console.log(`Server listening on port ${PORT}`);

  return server;
}

// ============================================================================
// Client Usage
// ============================================================================

async function runClient() {
  const transport = new TcpClientTransport("127.0.0.1", PORT);
  const client = createClient(transport);

  await client.connect();
  console.log("Client connected");

  // Basic calls
  const sum = await client.call<[number, number], number>("add", [1, 2]);
  console.log(`1 + 2 = ${sum}`);

  const diff = await client.call("subtract", { minuend: 42, subtrahend: 23 });
  console.log(`42 - 23 = ${diff}`);

  const product = await client.call<[number, number], number>("multiply", [6, 7]);
  console.log(`6 * 7 = ${product}`);

  // Built-in ping
  const pong = await client.ping();
  console.log(`Ping: ${pong}`);

  // Error handling
  try {
    await client.call("divide", [1, 0]);
  } catch (error) {
    console.log(`Expected error: ${error}`);
  }

  // Concurrent calls
  console.log("\nConcurrent calls:");
  const results = await Promise.all([
    client.call<[number, number], number>("add", [1, 1]),
    client.call<[number, number], number>("add", [2, 2]),
    client.call<[number, number], number>("add", [3, 3]),
  ]);
  console.log(`Results: ${results.join(", ")}`);

  await client.close();
  console.log("Client disconnected");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const server = await startServer();

  // Run client after server is ready
  await runClient();

  // Cleanup
  await server.close();
  console.log("Server closed");
}

main().catch(console.error);
