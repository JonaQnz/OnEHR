const http = require('node:http');
const { createApp } = require('../../dist/app');

/**
 * Boots the real Express app (exactly the routing/middleware stack
 * index.ts wires up in production - see app.ts) on an ephemeral local
 * port, with no DB/plugin bootstrap - HTTP-layer tests mock whichever
 * service-module functions a given route touches, the same way every
 * existing service-level test already mocks dist/db/prisma and friends.
 * Returns a fetch-friendly baseUrl and a close() to tear the listener down.
 *
 * Note on `--test-concurrency=1` (package.json's `test` script): running
 * several tests/http/*.test.js files as node:test's usual concurrent
 * child processes, each opening a real loopback socket, was observed to
 * intermittently corrupt the test-runner's own inter-process result
 * stream ("Unable to deserialize cloned data...") in this environment -
 * a real HTTP listener is enough I/O to occasionally race that channel.
 * Every file passes reliably alone; forcing sequential file execution
 * removes the race suite-wide rather than papering over it per file.
 */
async function startTestServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { startTestServer };
