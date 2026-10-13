const { Pool } = require('pg');

// DB_HOST is the RDS Proxy endpoint. The proxy requires TLS and presents a
// publicly trusted certificate, so the default CA store verifies it.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: true },
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

const COLUMNS = `id, title, completed, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         SERIAL PRIMARY KEY,
      title      TEXT        NOT NULL,
      completed  BOOLEAN     NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listTasks() {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM tasks ORDER BY id`);
  return rows;
}

async function getTask(id) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createTask(title) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (title) VALUES ($1) RETURNING ${COLUMNS}`,
    [title],
  );
  return rows[0];
}

async function updateTask(id, { title, completed }) {
  const { rows } = await pool.query(
    `UPDATE tasks
        SET title      = COALESCE($2, title),
            completed  = COALESCE($3, completed),
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, title ?? null, completed ?? null],
  );
  return rows[0] || null;
}

async function deleteTask(id) {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  return rowCount > 0;
}

function close() {
  return pool.end();
}

module.exports = { init, listTasks, getTask, createTask, updateTask, deleteTask, close };
