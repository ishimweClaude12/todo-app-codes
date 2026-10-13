// Loads .env for local runs. In ECS there is no .env; the task definition sets the environment.
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
