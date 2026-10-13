const { createClient } = require('redis');

// The cache is an accelerator, not a dependency: every helper here degrades to
// "no cache" instead of throwing when Redis is unreachable.
let client = null;
let wasDown = false;

function ttlSeconds() {
  return Number(process.env.CACHE_TTL_SECONDS || 60);
}

function connect() {
  client = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      tls: process.env.REDIS_TLS !== 'false',
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 500, 5000),
    },
    // ElastiCache AUTH token; unset locally.
    password: process.env.REDIS_PASSWORD || undefined,
    // Fail commands immediately while disconnected instead of queueing them.
    disableOfflineQueue: true,
  });

  client.on('ready', () => {
    wasDown = false;
    console.log('Cache ready');
  });
  client.on('error', (err) => {
    if (!wasDown) console.error('Cache unavailable:', err.message);
    wasDown = true;
  });

  // Not awaited: the client keeps retrying in the background and the app
  // serves uncached reads until it connects.
  client.connect().catch((err) => console.error('Cache connect failed:', err.message));
}

function isReady() {
  return Boolean(client && client.isReady);
}

// Cache-aside read. Returns { data, status } where status is HIT, MISS or BYPASS.
async function readThrough(key, loader) {
  if (!isReady()) return { data: await loader(), status: 'BYPASS' };

  let cached;
  try {
    cached = await client.get(key);
  } catch (err) {
    console.error(`Cache get ${key} failed:`, err.message);
    return { data: await loader(), status: 'BYPASS' };
  }

  if (cached !== null) return { data: JSON.parse(cached), status: 'HIT' };

  const data = await loader();
  if (data !== null && data !== undefined) {
    try {
      await client.setEx(key, ttlSeconds(), JSON.stringify(data));
    } catch (err) {
      console.error(`Cache set ${key} failed:`, err.message);
    }
  }
  return { data, status: 'MISS' };
}

async function invalidate(...keys) {
  if (!isReady()) return;
  try {
    await client.del(keys);
  } catch (err) {
    console.error(`Cache invalidate ${keys.join(', ')} failed:`, err.message);
  }
}

async function close() {
  if (client && client.isOpen) await client.quit();
}

module.exports = { connect, isReady, readThrough, invalidate, close };
