// Unified test teardown for an HTTP server created by createServer().
//
// Always prefer server.shutdown() — it cancels in-flight runs (so SSE streams
// end), rejects awaiting approvals, closes MCP child processes, stops the
// schedule tick, and forcibly destroys lingering keep-alive sockets before
// closing the listener. Calling the bare server.close() leaves those handles
// open, which keeps the event loop alive and causes the full-suite hang /
// libuv "UV_HANDLE_CLOSING" close-race assertion. Falls back to close() for any
// server-like object without shutdown().
export async function closeTestServer(server) {
  if (!server) return;
  if (typeof server.shutdown === 'function') {
    await server.shutdown({ timeoutMs: 2000 });
    return;
  }
  await new Promise((resolve) => server.close(() => resolve()));
}
