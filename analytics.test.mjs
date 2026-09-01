import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicPages = [
  'index.html',
  'main.html',
  'main/index.html',
  'talk/index.html',
  'partners/index.html',
  'leadsell/index.html',
  'copilot/index.html',
  'roadmap/index.html',
];

test('every public page loads the shared analytics owner exactly once', async () => {
  for (const page of publicPages) {
    const html = await readFile(new URL(page, import.meta.url), 'utf8');
    assert.equal(
      html.match(/<script src="\/analytics\.js"><\/script>/g)?.length,
      1,
      `${page} must load /analytics.js exactly once`,
    );
    assert.doesNotMatch(html, /metrika\/tag\.js/, `${page} must not own a second counter loader`);
  }
});

test('Timon conversion funnel is explicit and chat content is hidden from Webvisor', async () => {
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');

  for (const goal of [
    'timon_chat_open',
    'timon_chat_submit',
    'timon_chat_reply',
    'timon_chat_error',
  ]) {
    assert.match(html, new RegExp(`TeamONAnalytics\\?\\.goal\\('${goal}'\\)`));
  }

  assert.match(html, /class="timon-chat ym-hide-content"/);
  assert.match(html, /class="timon-form ym-disable-submit"/);
  assert.match(html, /id="timonInput" class="ym-disable-keys"/);
});

test('shared analytics initializes the intended Yandex Metrika counter', async () => {
  const analytics = await readFile(new URL('analytics.js', import.meta.url), 'utf8');
  assert.match(analytics, /const counterId = 107062766;/);
  assert.match(analytics, /window\.ym\(counterId, 'init'/);
  assert.match(analytics, /window\.ym\(counterId, 'reachGoal', name\)/);
});
