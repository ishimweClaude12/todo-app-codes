# todo-app ( To-Do)

The application layer of the To-Do lab: a small Node.js to-do app, its
Dockerfile, tests, the CodeDeploy deploy artifacts, and the GitHub Actions
workflow that builds the image, pushes it to ECR, and uploads the deploy bundle.

This repo holds application code only. The CloudFormation templates live in the
foundation and infrastructure repos.

## Architecture at a glance

```
Internet
  -> Application Load Balancer          (public subnets)
  -> ECS Fargate tasks                  (private app subnets)
       -> RDS Proxy                     (private proxy subnets)
            -> RDS PostgreSQL           (private data subnets)
       -> ElastiCache for Redis         (private cache subnets)
```

Everything runs in us-east-1 across two Availability Zones. Tasks have no public
IPs and reach AWS services (ECR, CloudWatch Logs, S3, Secrets Manager) through
VPC endpoints defined in the infrastructure repo.

## What the app does

The UI at `/` lets a user create, view, edit, complete, and delete tasks.

| Method   | Path             | Behaviour                                                             |
| -------- | ---------------- | --------------------------------------------------------------------- |
| `GET`    | `/`              | Serves the to-do UI                                                   |
| `GET`    | `/api/tasks`     | Lists all tasks. Cached in Redis                                      |
| `GET`    | `/api/tasks/:id` | Returns one task. Cached in Redis                                     |
| `POST`   | `/api/tasks`     | Creates a task in PostgreSQL through RDS Proxy                        |
| `PUT`    | `/api/tasks/:id` | Updates a task's title or completed flag                              |
| `DELETE` | `/api/tasks/:id` | Deletes a task                                                        |
| `GET`    | `/health`        | ALB target group health check. Touches neither the database nor Redis |

### Reads: cache-aside with Redis

1. Look up the key in Redis (`tasks:all` or `tasks:<id>`).
2. On a hit, return the cached JSON with the header `X-Cache: HIT`.
3. On a miss, query PostgreSQL through RDS Proxy, store the result with a TTL of
   `CACHE_TTL_SECONDS`, and return it with `X-Cache: MISS`.

If Redis is unreachable, reads fall through to the database and return
`X-Cache: BYPASS`. The cache is an accelerator, not a dependency: a cache outage
makes the app slower, not unavailable.

### Writes: database first, then invalidate

Creates, updates, and deletes commit to PostgreSQL through RDS Proxy, then
delete the affected keys (`tasks:all`, plus `tasks:<id>` for updates and
deletes). Deleting keys instead of rewriting them means two racing writes can
never leave a stale value in the cache; the next read repopulates it.

### Why `/health` does not check the database or Redis

If the health check depended on the database, a short RDS failover or proxy
blip would mark every task unhealthy at once. ECS would replace all of them
together, and a blue/green deployment in progress would roll back even though
the new code was fine. The health check answers "is this container serving
HTTP". Dependency failures show up as errors on the API routes and in the logs.

## Demonstrating the cache

```bash
ALB=http://<alb-dns-name>

curl -s -D - -o /dev/null "$ALB/api/tasks" | grep -i x-cache   # X-Cache: MISS
curl -s -D - -o /dev/null "$ALB/api/tasks" | grep -i x-cache   # X-Cache: HIT

curl -s -X POST "$ALB/api/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title":"demo task"}'

curl -s -D - -o /dev/null "$ALB/api/tasks" | grep -i x-cache   # X-Cache: MISS (write invalidated it)
```

## Layout

```
-todo-app/
├── src/
│   ├── app.js       # Express routes
│   ├── server.js    # entrypoint: creates the tasks table, connects Redis, listens
│   ├── env.js       # loads .env for local runs
│   ├── db.js        # pg pool and task queries (connects to RDS Proxy)
│   └── cache.js     # Redis client and cache-aside helpers
├── public/
│   └── index.html   # to-do UI
├── test/
│   └── app.test.js  # node:test suite (no database, Redis, or AWS needed)
├── deploy/
│   ├── appspec.yaml # CodeDeploy ECS blue/green appspec
│   └── taskdef.json # task definition template (placeholders)
├── docker-compose.yml # local Postgres and Redis for development
├── Dockerfile
├── .github/workflows/build-and-push.yml
└── package.json
```

## Environment variables (set at runtime by the task definition)

| Variable             | Purpose                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`               | Listen port (3000)                                                                                                                   |
| `DB_HOST`            | RDS Proxy endpoint. Never the RDS instance endpoint                                                                                  |
| `DB_PORT`            | 5432                                                                                                                                 |
| `DB_NAME`, `DB_USER` | Database name and user                                                                                                               |
| `DB_PASSWORD`        | Injected from Secrets Manager through the task definition `secrets` block. Never stored in the image or as a plain environment value |
| `DB_SSL`             | Set to `false` only for a local Postgres. RDS Proxy is configured to require TLS                                                     |
| `REDIS_HOST`         | ElastiCache primary endpoint                                                                                                         |
| `REDIS_PORT`         | 6379                                                                                                                                 |
| `REDIS_TLS`          | Set to `false` only for a local Redis. ElastiCache has in-transit encryption enabled                                                 |
| `CACHE_TTL_SECONDS`  | Cache entry lifetime (default 60)                                                                                                    |

The app makes no AWS API calls at runtime, so the task role grants no
permissions. The task execution role pulls the image, writes logs, and reads the
database secret.

## Run and test locally

RDS Proxy and ElastiCache are private and reachable only from the ECS tasks, so
local development uses Postgres and Redis containers instead. `npm start` loads
`.env` automatically when it exists (`src/env.js`); the container has no `.env`
and uses the task definition.

Prerequisites: Node.js 24 (Active LTS) and Docker. No AWS credentials are needed
locally.

1. Install dependencies:

```bash
   npm install
```

2. Start the local database and cache (credentials in `docker-compose.yml`):

```bash
   docker compose up -d db redis
```

3. Create `.env` in the project root (it is gitignored):

```bash
   PORT=3000

   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=todo
   DB_USER=todoadmin
   DB_PASSWORD=localdev
   DB_SSL=false

   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_TLS=false
   CACHE_TTL_SECONDS=60
```

4. Start the app and open http://localhost:3000:

```bash
   npm start
```

The log should show `Database ready` and `Cache ready`. The `tasks` table is
created on first start.

5. Run the tests (the database and cache modules are stubbed):

```bash
   npm test
```

Stop the containers with `docker compose down` (add `-v` to also delete the
database data).

## CI/CD: one-time setup

The workflow authenticates to AWS with GitHub OIDC, so there are no stored keys
or secrets. It needs two repository variables under
**Settings > Secrets and variables > Actions > Variables**:

- `AWS_ACCOUNT_ID`: `605134436600`
- `AWS_REGION`: `us-east-1`

Set these at repository level, not on a GitHub environment. A job that declares
`environment:` receives an OIDC subject of
`repo:<owner>/<repo>:environment:<name>` instead of
`repo:<owner>/<repo>:ref:refs/heads/main`. The CI role trusts only the `main`
branch subject, so the role assumption would fail.

## What a push does

On every branch and pull request:

1. Runs the tests.
2. Builds the image without pushing it, so a broken Dockerfile fails before
   merge. No AWS access is needed for this.

On `main` only (the only ref the CI role trusts):

3. Assumes `todo-app/foundation/todo-app-ci-role` through OIDC.
4. Pushes the image to ECR tagged with the commit SHA. SHA tags are immutable;
   a re-run skips the push if the tag already exists.
5. Renders `taskdef.json` from the parameters the infrastructure stack publishes
   under `/todo-app/deploy/*`, zips it with `appspec.yaml`, and uploads
   `config-source.zip` to the artifact bucket.
6. Pushes the same image as `latest`. An EventBridge rule matches the ECR push
   event for `latest` and starts CodePipeline, which hands the deployment to
   CodeDeploy as an ECS blue/green deployment. `latest` is the one tag the
   foundation stack leaves mutable.

Step 5 runs before step 6 because the pipeline reads the bundle when it starts.
Uploading it afterwards would deploy the new image with the previous task
definition.

Steps 5 and 6 are skipped if the infrastructure parameters do not exist yet, so
you can push this repo before the infrastructure stack is deployed. The SHA
image still lands in ECR. Once the infrastructure is up, re-run the workflow on
`main` to deploy.

## What a blue/green deployment does

CodeDeploy starts a replacement (green) task set with the new image, registers
it in the second target group, and waits for it to pass ALB health checks. It
then shifts production traffic from blue to green. The blue tasks stay up for
the configured termination wait so a rollback is instant. A failed deployment
rolls back automatically.

## Logs

Container stdout and stderr go to CloudWatch Logs through the `awslogs` log
driver, in the log group the infrastructure stack publishes as `log-group`.

## Contract with the infrastructure stack

The workflow reads these SSM parameters under `/todo-app/deploy/`:

| Parameter            | Used for                                    |
| -------------------- | ------------------------------------------- |
| `task-role-arn`      | Task definition `taskRoleArn`               |
| `execution-role-arn` | Task definition `executionRoleArn`          |
| `log-group`          | `awslogs` log group                         |
| `db-proxy-endpoint`  | `DB_HOST`                                   |
| `db-secret-arn`      | `DB_PASSWORD` source in the `secrets` block |
| `redis-endpoint`     | `REDIS_HOST`                                |
| `artifact-bucket`    | Upload target for `config-source.zip`       |

## Dependency this repo has on the rest of the lab

- **Foundation stack (deployed first):** provides the ECR repository, the
  artifact bucket, and the CI role this workflow assumes, trusted only for this
  repo's `main` branch. The image build and push depend only on this.
- **Infrastructure stack (deployed second):** publishes the SSM parameters above
  and owns the EventBridge rule, CodePipeline, and the CodeDeploy application
  and deployment group that consume the uploaded bundle.
