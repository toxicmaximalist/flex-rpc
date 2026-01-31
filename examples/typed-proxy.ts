/**
 * flex-rpc: Typed Proxy Example
 *
 * Demonstrates the typed proxy feature for natural method calls.
 */

import { createClient, createServer, TcpClientTransport, TcpServerTransport } from "../src/index.js";

const PORT = 3003;

// ============================================================================
// Define your API interface
// ============================================================================

interface MathApi {
  add(a: number, b: number): number;
  subtract(a: number, b: number): number;
  multiply(a: number, b: number): number;
  divide(a: number, b: number): number;
}

interface UserApi {
  create(user: { name: string; email: string }): { id: string; name: string; email: string };
  get(id: string): { id: string; name: string; email: string } | null;
  list(): Array<{ id: string; name: string; email: string }>;
}

interface Api {
  math: MathApi;
  users: UserApi;
  ping(): string;
}

// ============================================================================
// Server with namespaced methods
// ============================================================================

async function startServer() {
  const transport = new TcpServerTransport(PORT, { host: "127.0.0.1" });
  const server = createServer();
  server.addTransport(transport);

  // In-memory user store
  const users = new Map<string, { id: string; name: string; email: string }>();
  let nextId = 1;

  // Math namespace
  server.expose("math.add", (params) => {
    const [a, b] = params as [number, number];
    return a + b;
  });

  server.expose("math.subtract", (params) => {
    const [a, b] = params as [number, number];
    return a - b;
  });

  server.expose("math.multiply", (params) => {
    const [a, b] = params as [number, number];
    return a * b;
  });

  server.expose("math.divide", (params) => {
    const [a, b] = params as [number, number];
    if (b === 0) throw new Error("Division by zero");
    return a / b;
  });

  // Users namespace
  server.expose("users.create", (params) => {
    const { name, email } = params as { name: string; email: string };
    const id = String(nextId++);
    const user = { id, name, email };
    users.set(id, user);
    return user;
  });

  server.expose("users.get", (params) => {
    const [id] = params as [string];
    return users.get(id) ?? null;
  });

  server.expose("users.list", () => {
    return Array.from(users.values());
  });

  await server.listen();
  console.log(`Server listening on port ${PORT}`);

  return server;
}

// ============================================================================
// Client with typed proxy
// ============================================================================

async function runClient() {
  const transport = new TcpClientTransport("127.0.0.1", PORT);
  const client = createClient(transport);

  await client.connect();
  console.log("Client connected\n");

  // Create typed proxy
  const api = client.proxy<Api>();

  // Use math methods with full type safety
  console.log("Math operations:");
  const sum = await api.math.add(10, 5);
  console.log(`  10 + 5 = ${sum}`);

  const diff = await api.math.subtract(10, 5);
  console.log(`  10 - 5 = ${diff}`);

  const product = await api.math.multiply(10, 5);
  console.log(`  10 * 5 = ${product}`);

  const quotient = await api.math.divide(10, 5);
  console.log(`  10 / 5 = ${quotient}`);

  // Use user methods
  console.log("\nUser operations:");
  
  const user1 = await api.users.create({ name: "Alice", email: "alice@example.com" });
  console.log(`  Created user: ${JSON.stringify(user1)}`);

  const user2 = await api.users.create({ name: "Bob", email: "bob@example.com" });
  console.log(`  Created user: ${JSON.stringify(user2)}`);

  const fetchedUser = await api.users.get(user1.id);
  console.log(`  Fetched user: ${JSON.stringify(fetchedUser)}`);

  const allUsers = await api.users.list();
  console.log(`  All users: ${JSON.stringify(allUsers)}`);

  // Built-in ping
  const pong = await api.ping();
  console.log(`\nPing: ${pong}`);

  await client.close();
  console.log("\nClient disconnected");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const server = await startServer();
  await runClient();
  await server.close();
  console.log("Server closed");
}

main().catch(console.error);
