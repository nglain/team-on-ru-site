import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNoToolsUpstream, openRouterPayload } from './upstream.mjs';

const token = 't'.repeat(32);

async function start(modelReply) {
  const historyDir = await mkdtemp(path.join(os.tmpdir(), 'timon-upstream-test-'));
  const server = createNoToolsUpstream({
    env: { TIMON_UPSTREAM_ACCESS_TOKEN: token, TIMON_HISTORY_DIR: historyDir },
    modelReply,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(historyDir, { recursive: true, force: true });
    },
  };
}

test('production provider request exposes no tools or external actions', () => {
  const payload = openRouterPayload('hello');
  assert.equal(payload.model, 'minimax/minimax-m3:free');
  assert.equal(Object.hasOwn(payload, 'tools'), false);
  assert.equal(Object.hasOwn(payload, 'tool_choice'), false);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].content, 'hello');
});

test('requires bearer auth and keeps bounded conversation continuity', async () => {
  const prompts = [];
  const app = await start(async ({ prompt }) => {
    prompts.push(prompt);
    return prompts.length === 1 ? 'Первый ответ' : 'Второй ответ';
  });
  try {
    const unauthorized = await fetch(`${app.url}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const userId = 'site-abcdefghijklmnopqrstuv';
    const first = await fetch(`${app.url}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify({ userId, text: 'Первый вопрос' }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${app.url}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify({ userId, text: 'Второй вопрос' }),
    });
    assert.equal(second.status, 200);
    assert.match(prompts[1], /Первый вопрос/);
    assert.match(prompts[1], /Первый ответ/);
    assert.match(prompts[1], /Второй вопрос/);
  } finally {
    await app.close();
  }
});
