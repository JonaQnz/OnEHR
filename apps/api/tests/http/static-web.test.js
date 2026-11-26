const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestServer } = require('../support/httpServer');

// Exercises the WEB_DIST_DIR branch of createApp(): the built SPA is served
// as static files, unknown non-/api GET paths fall back to index.html, and
// /api/* keeps its own JSON/404 behaviour.
test('serves the built SPA with an index.html fallback outside /api when WEB_DIST_DIR is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onehr-web-'));
  const marker = `onehr-spa-marker-${process.pid}`;
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body>${marker}</body></html>`);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("asset served");');

  const originalDistDir = process.env.WEB_DIST_DIR;
  process.env.WEB_DIST_DIR = dir;
  let server;
  try {
    server = await startTestServer();

    for (const route of ['/', '/forms/123']) {
      const response = await fetch(`${server.baseUrl}${route}`);
      assert.equal(response.status, 200, `${route} should be 200`);
      assert.ok((await response.text()).includes(marker), `${route} should serve index.html`);
    }

    const asset = await fetch(`${server.baseUrl}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.ok((await asset.text()).includes('console.log("asset served")'));

    const missingApi = await fetch(`${server.baseUrl}/api/does-not-exist`);
    assert.equal(missingApi.status, 404);

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDistDir === undefined) {
      delete process.env.WEB_DIST_DIR;
    } else {
      process.env.WEB_DIST_DIR = originalDistDir;
    }
  }
});
