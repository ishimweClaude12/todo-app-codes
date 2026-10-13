require('./env');

const db = require('./db');
const cache = require('./cache');
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);

async function main() {
  await db.init();
  console.log('Database ready');

  cache.connect();

  const server = createApp({ db, cache }).listen(port, () => {
    console.log(`Listening on port ${port}`);
  });

  // ECS sends SIGTERM on task stop; finish in-flight requests before exiting.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await Promise.allSettled([db.close(), cache.close()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // Connection failures arrive as an AggregateError with an empty message.
  console.error('Startup failed:', err.message || err.code || err);
  process.exit(1);
});
