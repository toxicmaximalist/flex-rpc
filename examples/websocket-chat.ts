/**
 * flex-rpc: WebSocket Transport Example
 *
 * Demonstrates WebSocket client-server communication with bidirectional notifications.
 */

import { createClient, createServer, WsClientTransport, WsServerTransport } from "../src/index.js";

const PORT = 3001;

// ============================================================================
// Server Setup
// ============================================================================

async function startServer() {
  const transport = new WsServerTransport(PORT, { host: "127.0.0.1" });
  const server = createServer();
  server.addTransport(transport);

  // Register methods
  server.expose("echo", (params) => params);

  server.expose("subscribe", (params, ctx) => {
    const { topic } = params as { topic: string };
    console.log(`Client ${ctx.client.id} subscribed to: ${topic}`);
    // In a real app, you'd store the subscription
    return { subscribed: topic };
  });

  server.expose("broadcast", async (params) => {
    const { message } = params as { message: string };
    // Broadcast to all clients
    await server.broadcast("notification", { type: "broadcast", message });
    return { sent: true };
  });

  await server.listen();
  console.log(`WebSocket server listening on ws://127.0.0.1:${PORT}`);

  // Periodic notifications to all clients
  setInterval(() => {
    if (server.clientCount > 0) {
      server.broadcast("tick", { timestamp: Date.now() });
    }
  }, 5000);

  return server;
}

// ============================================================================
// Client Usage
// ============================================================================

async function runClient(clientName: string) {
  const transport = new WsClientTransport(`ws://127.0.0.1:${PORT}`);
  const client = createClient(transport);

  // Handle server notifications
  client.onNotification("notification", (params) => {
    console.log(`[${clientName}] Notification:`, params);
  });

  client.onNotification("tick", (params) => {
    const { timestamp } = params as { timestamp: number };
    console.log(`[${clientName}] Tick: ${new Date(timestamp).toISOString()}`);
  });

  await client.connect();
  console.log(`[${clientName}] Connected`);

  // Subscribe to a topic
  const sub = await client.call("subscribe", { topic: "news" });
  console.log(`[${clientName}] Subscription result:`, sub);

  // Echo test
  const echo = await client.call("echo", { hello: "world" });
  console.log(`[${clientName}] Echo:`, echo);

  // Broadcast a message (other clients will receive it)
  if (clientName === "Client1") {
    await client.call("broadcast", { message: "Hello from Client1!" });
  }

  return client;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const server = await startServer();

  // Connect multiple clients
  const client1 = await runClient("Client1");
  const client2 = await runClient("Client2");

  console.log(`\nConnected clients: ${server.clientCount}`);

  // Keep running for a bit to see notifications
  await new Promise((resolve) => setTimeout(resolve, 6000));

  // Cleanup
  await client1.close();
  await client2.close();
  await server.close();
  console.log("\nAll connections closed");
}

main().catch(console.error);
