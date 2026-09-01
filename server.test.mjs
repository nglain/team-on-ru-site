import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimonProxy } from './server.mjs';

const env = {
  TIMON_UPSTREAM_URL: 'http://upstream.invalid/api/chat',
  TIMON_UPSTREAM_TOKEN: 'u'.repeat(32),
  TIMON_PROXY_COOKIE_SECRET: 'c'.repeat(40),
};

async function start(options = {}) {
  const server = createTimonProxy({ env: { ...env, ...(options.env || {}) }, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('forwards an opaque server-owned session and hides the upstream token', async () => {
  let forwarded;
  const app = await start({
    makeSessionId: () => 'sessionabcdefghijklmnop',
    fetchImpl: async (_url, request) => {
      forwarded = request;
      return new Response(JSON.stringify({ ok: true, text: 'Разберём процесс.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  try {
    const response = await fetch(`${app.url}/api/timon/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: JSON.stringify({ message: 'Как автоматизировать продажи?', userId: 'attacker-choice' }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.text, 'Разберём процесс.');
    assert.match(response.headers.get('set-cookie'), /^timon_session=/);
    assert.equal(forwarded.headers.authorization, `Bearer ${env.TIMON_UPSTREAM_TOKEN}`);
    const upstreamBody = JSON.parse(forwarded.body);
    assert.equal(upstreamBody.userId, 'site-sessionabcdefghijklmnop');
    assert.equal(upstreamBody.threadId, upstreamBody.userId);
    assert.equal(upstreamBody.text, 'Как автоматизировать продажи?');
  } finally {
    await app.close();
  }
});

test('rejects oversized messages before calling the agent', async () => {
  let called = false;
  const app = await start({
    makeSessionId: () => 'sessionabcdefghijklmnop',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });
  try {
    const response = await fetch(`${app.url}/api/timon/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(2_001) }),
    });
    assert.equal(response.status, 413);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test('limits burst traffic per source address', async () => {
  let sequence = 0;
  const app = await start({
    makeSessionId: () => `sessionabcdefghijklmn${String(sequence++).padStart(2, '0')}`,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, text: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  try {
    const statuses = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await fetch(`${app.url}/api/timon/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4' },
        body: JSON.stringify({ message: `turn ${index}` }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  } finally {
    await app.close();
  }
});
