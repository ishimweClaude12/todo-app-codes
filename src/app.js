const path = require('node:path');
const express = require('express');

const MAX_TITLE_LENGTH = 200;
const ALL_KEY = 'tasks:all';
const taskKey = (id) => `tasks:${id}`;

function parseId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 && id <= 2147483647 ? id : null;
}

function validateTitle(title) {
  if (typeof title !== 'string') return 'title must be a string';
  const trimmed = title.trim();
  if (!trimmed) return 'title is required';
  if (trimmed.length > MAX_TITLE_LENGTH) return `title must be at most ${MAX_TITLE_LENGTH} characters`;
  return null;
}

// db and cache are injected so the tests can stub them.
function createApp({ db, cache }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // ALB health check. Deliberately touches neither the database nor Redis.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/tasks', async (req, res) => {
    const { data, status } = await cache.readThrough(ALL_KEY, () => db.listTasks());
    res.set('X-Cache', status).json(data);
  });

  app.get('/api/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid task id' });

    const { data, status } = await cache.readThrough(taskKey(id), () => db.getTask(id));
    res.set('X-Cache', status);
    if (!data) return res.status(404).json({ error: 'task not found' });
    res.json(data);
  });

  app.post('/api/tasks', async (req, res) => {
    const error = validateTitle(req.body?.title);
    if (error) return res.status(400).json({ error });

    const task = await db.createTask(req.body.title.trim());
    await cache.invalidate(ALL_KEY);
    res.status(201).json(task);
  });

  app.put('/api/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid task id' });

    const { title, completed } = req.body ?? {};
    if (title === undefined && completed === undefined) {
      return res.status(400).json({ error: 'provide title and/or completed' });
    }
    if (title !== undefined) {
      const error = validateTitle(title);
      if (error) return res.status(400).json({ error });
    }
    if (completed !== undefined && typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'completed must be a boolean' });
    }

    const task = await db.updateTask(id, { title: title?.trim(), completed });
    if (!task) return res.status(404).json({ error: 'task not found' });
    await cache.invalidate(ALL_KEY, taskKey(id));
    res.json(task);
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid task id' });

    const deleted = await db.deleteTask(id);
    if (!deleted) return res.status(404).json({ error: 'task not found' });
    await cache.invalidate(ALL_KEY, taskKey(id));
    res.status(204).end();
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error(`${req.method} ${req.originalUrl} failed:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
