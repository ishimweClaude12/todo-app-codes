const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// In-memory stand-ins for src/db.js and src/cache.js.
function makeDb() {
  let tasks = [];
  let nextId = 1;
  return {
    calls: 0,
    async listTasks() { this.calls++; return tasks.map((t) => ({ ...t })); },
    async getTask(id) { this.calls++; return tasks.find((t) => t.id === id) || null; },
    async createTask(title) {
      const task = { id: nextId++, title, completed: false };
      tasks.push(task);
      return { ...task };
    },
    async updateTask(id, { title, completed }) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      if (title !== undefined) task.title = title;
      if (completed !== undefined) task.completed = completed;
      return { ...task };
    },
    async deleteTask(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      return tasks.length < before;
    },
  };
}

function makeCache({ up = true } = {}) {
  const store = new Map();
  return {
    up,
    store,
    async readThrough(key, loader) {
      if (!this.up) return { data: await loader(), status: 'BYPASS' };
      if (store.has(key)) return { data: JSON.parse(store.get(key)), status: 'HIT' };
      const data = await loader();
      if (data !== null) store.set(key, JSON.stringify(data));
      return { data, status: 'MISS' };
    },
    async invalidate(...keys) { keys.forEach((k) => store.delete(k)); },
  };
}

let db;
let cache;
let server;
let base;

before(async () => {
  // One server; the handlers read db/cache through these mutable references.
  const deps = {
    db: new Proxy({}, { get: (_, p) => (typeof db[p] === 'function' ? db[p].bind(db) : db[p]) }),
    cache: new Proxy({}, { get: (_, p) => (typeof cache[p] === 'function' ? cache[p].bind(cache) : cache[p]) }),
  };
  server = createApp(deps).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  db = makeDb();
  cache = makeCache();
});

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('GET /health returns ok without touching db or cache', async () => {
  db.listTasks = () => { throw new Error('should not be called'); };
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET / serves the UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /api/tasks is MISS then HIT', async () => {
  const first = await fetch(`${base}/api/tasks`);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const second = await fetch(`${base}/api/tasks`);
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal(db.calls, 1);
});

test('POST /api/tasks creates a task and invalidates the list', async () => {
  await fetch(`${base}/api/tasks`);
  const res = await fetch(`${base}/api/tasks`, json('POST', { title: '  buy milk  ' }));
  assert.equal(res.status, 201);
  assert.equal((await res.json()).title, 'buy milk');

  const list = await fetch(`${base}/api/tasks`);
  assert.equal(list.headers.get('x-cache'), 'MISS');
  assert.equal((await list.json()).length, 1);
});

test('POST /api/tasks rejects bad input', async () => {
  for (const body of [{}, { title: '' }, { title: '   ' }, { title: 42 }, { title: 'x'.repeat(201) }]) {
    const res = await fetch(`${base}/api/tasks`, json('POST', body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const malformed = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
});

test('GET /api/tasks/:id returns a task, 404 when missing, 400 when invalid', async () => {
  await fetch(`${base}/api/tasks`, json('POST', { title: 'a' }));
  assert.equal((await fetch(`${base}/api/tasks/1`)).status, 200);
  assert.equal((await fetch(`${base}/api/tasks/99`)).status, 404);
  assert.equal((await fetch(`${base}/api/tasks/abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/0`)).status, 400);
});

test('PUT /api/tasks/:id updates and invalidates both keys', async () => {
  await fetch(`${base}/api/tasks`, json('POST', { title: 'a' }));
  await fetch(`${base}/api/tasks/1`);
  await fetch(`${base}/api/tasks`);
  assert.ok(cache.store.has('tasks:1') && cache.store.has('tasks:all'));

  const res = await fetch(`${base}/api/tasks/1`, json('PUT', { completed: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).completed, true);
  assert.ok(!cache.store.has('tasks:1') && !cache.store.has('tasks:all'));
});

test('PUT /api/tasks/:id validates input', async () => {
  await fetch(`${base}/api/tasks`, json('POST', { title: 'a' }));
  assert.equal((await fetch(`${base}/api/tasks/1`, json('PUT', {}))).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/1`, json('PUT', { completed: 'yes' }))).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/1`, json('PUT', { title: '' }))).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/9`, json('PUT', { completed: true }))).status, 404);
});

test('DELETE /api/tasks/:id removes the task', async () => {
  await fetch(`${base}/api/tasks`, json('POST', { title: 'a' }));
  assert.equal((await fetch(`${base}/api/tasks/1`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/tasks/1`, { method: 'DELETE' })).status, 404);
});

test('reads fall through with BYPASS when the cache is down', async () => {
  cache.up = false;
  const res = await fetch(`${base}/api/tasks`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-cache'), 'BYPASS');
});

test('database errors return 500', async () => {
  db.listTasks = async () => { throw new Error('connection refused'); };
  const res = await fetch(`${base}/api/tasks`);
  assert.equal(res.status, 500);
});
