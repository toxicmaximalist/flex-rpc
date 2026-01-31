/**
 * flex-rpc: HTTP Transport Example
 *
 * Demonstrates HTTP client-server communication and Express adapter.
 */

import { createServer, HttpClientTransport, HttpServerTransport, createClient } from "../src/index.js";

const PORT = 3002;

// ============================================================================
// Standalone HTTP Server
// ============================================================================

async function startStandaloneServer() {
  const transport = new HttpServerTransport(PORT, {
    host: "127.0.0.1",
    cors: true, // Enable CORS for browser clients
  });
  
  const server = createServer();
  server.addTransport(transport);

  // Register methods
  server.expose("greet", (params) => {
    const { name } = params as { name: string };
    return `Hello, ${name}!`;
  });

  server.expose("calculate", (params) => {
    const { operation, a, b } = params as { operation: string; a: number; b: number };
    switch (operation) {
      case "add": return a + b;
      case "subtract": return a - b;
      case "multiply": return a * b;
      case "divide": return b !== 0 ? a / b : null;
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  });

  server.expose("batch-example", () => {
    return "This is part of a batch";
  });

  await server.listen();
  console.log(`HTTP server listening on http://127.0.0.1:${PORT}`);

  return server;
}

// ============================================================================
// HTTP Client Usage
// ============================================================================

async function runHttpClient() {
  const transport = new HttpClientTransport(`http://127.0.0.1:${PORT}/`, {
    requestTimeout: 5000,
    retry: true,
    maxRetries: 3,
  });

  const client = createClient(transport);
  await client.connect();

  // Single request
  const greeting = await client.call("greet", { name: "World" });
  console.log(`Greeting: ${greeting}`);

  // Calculate
  const sum = await client.call("calculate", { operation: "add", a: 10, b: 5 });
  console.log(`10 + 5 = ${sum}`);

  // Batch requests
  console.log("\nBatch request:");
  const batchResults = await client.batch([
    { method: "calculate", params: { operation: "add", a: 1, b: 2 } },
    { method: "calculate", params: { operation: "multiply", a: 3, b: 4 } },
    { method: "greet", params: { name: "Batch" } },
  ]);

  batchResults.forEach((result, i) => {
    if (result.success) {
      console.log(`  [${i}] Success: ${JSON.stringify(result.result)}`);
    } else {
      console.log(`  [${i}] Error: ${result.error.message}`);
    }
  });

  // Request with timeout
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    
    // This would abort if the request takes too long
    await client.call("greet", { name: "Abort Test" }, { signal: controller.signal });
  } catch (error) {
    console.log(`\nAbort test: Request completed before abort`);
  }

  await client.close();
}

// ============================================================================
// Express Adapter Example (commented - requires express dependency)
// ============================================================================

/*
import express from "express";

async function startExpressServer() {
  const app = express();
  
  const rpcServer = createServer();
  rpcServer.expose("express-method", () => "Called via Express!");

  const httpTransport = new HttpServerTransport(0); // Port 0 since Express handles listening
  
  // Use the handler directly
  app.use("/rpc", express.json(), (req, res) => {
    httpTransport.createHandler()(req, res);
  });

  app.listen(3003, () => {
    console.log("Express + JSON-RPC on http://127.0.0.1:3003/rpc");
  });
}
*/

// ============================================================================
// Using fetch directly (browser-compatible)
// ============================================================================

async function fetchExample() {
  console.log("\nDirect fetch example:");
  
  const response = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "greet",
      params: { name: "fetch" },
      id: "1",
    }),
  });

  const result = await response.json();
  console.log("Raw response:", JSON.stringify(result, null, 2));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const server = await startStandaloneServer();

  await runHttpClient();
  await fetchExample();

  await server.close();
  console.log("\nServer closed");
}

main().catch(console.error);
