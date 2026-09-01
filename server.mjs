#!/usr/bin/env node
import http from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'timon-web-proxy-v1';
const BODY_LIMIT_BYTES = 4_096;
const MESSAGE_LIMIT_CHARS = 2_000;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createTimonProxy(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const makeSessionId = options.makeSessionId || (() => randomBytes(18).toString('base64url'));
  const upstreamUrl = requiredUrl(env.TIMON_UPSTREAM_URL);
  const upstreamToken = requiredSecret(env.TIMON_UPSTREAM_TOKEN, 'TIMON_UPSTREAM_TOKEN');
  const cookieSecret = requiredSecret(env.TIMON_PROXY_COOKIE_SECRET, 'TIMON_PROXY_COOKIE_SECRET', 32);
  const maxConcurrent = positiveInt(env.TIMON_MAX_CONCURRENT, 2);
  const timeoutMs = positiveInt(env.TIMON_UPSTREAM_TIMEOUT_MS, 180_000);
  const counters = new Map();
  const activeSessions = new Set();
  let activeTotal = 0;

  return http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/timon/health') {
      return json(res, 200, { ok: true, service: VERSION, active: activeTotal });
    }

    if (req.method !== 'POST' || url.pathname !== '/api/timon/chat') {
      return json(res, 404, { ok: false, error: 'not_found' });
    }

    const ip = clientIp(req);
    const currentTime = now();
    const session = sessionFromRequest(req, cookieSecret) || makeSession(makeSessionId(), cookieSecret);
    if (!sessionFromRequest(req, cookieSecret)) {
      res.setHeader('set-cookie', `timon_session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    }

    const limit = firstRejectedLimit([
      hitLimit(counters, `minute:${ip}`, 6, 60_000, currentTime),
      hitLimit(counters, `day:${ip}`, 60, 86_400_000, currentTime),
      hitLimit(counters, `session:${session.id}`, 30, 86_400_000, currentTime),
    ]);
    if (limit) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
      return json(res, 429, { ok: false, error: 'rate_limited', message: 'Лимит сообщений исчерпан. Попробуйте позже.' });
    }

    if (activeTotal >= maxConcurrent || activeSessions.has(session.id)) {
      res.setHeader('retry-after', '10');
      return json(res, 429, { ok: false, error: 'busy', message: 'Тимон уже отвечает. Дождитесь текущего ответа.' });
    }

    let body;
    try {
      body = await readJson(req, BODY_LIMIT_BYTES);
    } catch (error) {
      const tooLarge = error?.code === 'body_too_large';
      return json(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'message_too_large' : 'invalid_json' });
    }
    const message = String(body?.message || body?.text || '').trim();
    if (!message) return json(res, 400, { ok: false, error: 'message_required' });
    if (message.length > MESSAGE_LIMIT_CHARS) {
      return json(res, 413, { ok: false, error: 'message_too_large', message: `До ${MESSAGE_LIMIT_CHARS} символов за сообщение.` });
    }

    activeTotal += 1;
    activeSessions.add(session.id);
    const startedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestId = `site-${makeSessionId()}`;
      const response = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstreamToken}`,
          'content-type': 'application/json',
          'user-agent': 'team-on.ru-timon-proxy/1',
        },
        body: JSON.stringify({
          userId: `site-${session.id}`,
          threadId: `site-${session.id}`,
          requestId,
          displayName: 'Посетитель team-on.ru',
          text: message,
          attachments: [],
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) throw new Error(`upstream_${response.status}`);
      const text = String(data?.text || '').trim();
      if (!text) throw new Error('upstream_empty_response');
      audit('turn.ok', { session: safeHash(session.id), ip: safeHash(ip), ms: now() - startedAt });
      return json(res, 200, { ok: true, text: text.slice(0, 12_000) });
    } catch (error) {
      const timeout = error?.name === 'AbortError';
      audit('turn.failed', { session: safeHash(session.id), ip: safeHash(ip), ms: now() - startedAt, reason: timeout ? 'timeout' : 'upstream' });
      return json(res, timeout ? 504 : 502, {
        ok: false,
        error: timeout ? 'timeout' : 'temporarily_unavailable',
        message: timeout ? 'Ответ занял слишком много времени. Попробуйте ещё раз.' : 'Тимон временно недоступен. Попробуйте чуть позже.',
      });
    } finally {
      clearTimeout(timer);
      activeTotal -= 1;
      activeSessions.delete(session.id);
      pruneCounters(counters, now());
    }
  });
}

function requiredUrl(value) {
  const parsed = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('TIMON_UPSTREAM_URL must use http or https');
  return parsed.href;
}

function requiredSecret(value, name, minimum = 24) {
  const secret = String(value || '').trim();
  if (secret.length < minimum) throw new Error(`${name} must contain at least ${minimum} characters`);
  return secret;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req.socket.remoteAddress || 'unknown');
  return /^[0-9a-f:.]{3,64}$/i.test(raw) ? raw : 'unknown';
}

function sessionFromRequest(req, secret) {
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('timon_session='));
  const token = cookie ? decodeURIComponent(cookie.slice('timon_session='.length)) : '';
  const [id, signature, extra] = token.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9_-]{20,64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  const expected = signSession(id, secret);
  const supplied = Buffer.from(signature, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return null;
  return { id, token };
}

function makeSession(id, secret) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw new Error('generated session id is invalid');
  return { id, token: `${id}.${signSession(id, secret)}` };
}

function signSession(id, secret) {
  return createHmac('sha256', secret).update(id).digest('hex');
}

function hitLimit(store, key, maximum, windowMs, now) {
  const existing = store.get(key);
  const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  bucket.count += 1;
  store.set(key, bucket);
  return bucket.count > maximum ? { rejected: true, retryAfterMs: bucket.resetAt - now } : { rejected: false };
}

function firstRejectedLimit(results) {
  return results.find((item) => item.rejected) || null;
}

function pruneCounters(store, now) {
  if (store.size < 2_000) return;
  for (const [key, value] of store) if (value.resetAt <= now) store.delete(key);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request body is too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function securityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function safeHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function audit(event, data) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
}

export function main(env = process.env) {
  const host = String(env.TIMON_PROXY_HOST || '127.0.0.1');
  const port = positiveInt(env.TIMON_PROXY_PORT, 4174);
  const server = createTimonProxy({ env });
  server.listen(port, host, () => process.stdout.write(`[${VERSION}] http://${host}:${port}\n`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
