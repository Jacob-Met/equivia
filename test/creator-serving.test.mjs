import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server.mjs';

test('the maintained server serves every manual creator runtime asset exactly', async () => {
  const server = createServer({ env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [route, file, type] of [
      ['/creator', '../public/creator.html', 'text/html'],
      ['/creator.css', '../public/creator.css', 'text/css'],
      ['/creator.js', '../public/creator.js', 'text/javascript'],
      ['/src/creator.js', '../src/creator.js', 'text/javascript'],
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.ok(response.headers.get('content-type').startsWith(type));
      assert.equal(await response.text(), await readFile(new URL(file, import.meta.url), 'utf8'));
    }
    const html = await (await fetch(base + '/creator')).text();
    assert.match(html, /type="module" src="\/creator\.js"/);
    assert.match(await (await fetch(base + '/')).text(), /href="\/creator"/);
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.model.configured, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
