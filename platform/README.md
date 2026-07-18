# 🔌 PlugStack — Pluggable, One-Click App Stacks

PlugStack lets you compose an entire application — **frontend, backend, Kafka, Postgres, Redis, anything** — out of plugins, and bring the whole thing up with **one command**:

```bash
npm run oneclick up fullstack-demo
```

It is our own design (inspired by the "it just runs" feel of tools like PocketBase, but architecturally nothing like it): instead of one monolithic binary, **everything is a plugin** described by a small JSON manifest, and stacks are declarative compositions of plugins.

Zero runtime dependencies — the whole engine is plain Node.js.

## How it works

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────────────┐
│  stack.json  │ --> │   resolver   │ --> │  launch plan (ordered)     │
│ (your app)   │     │ deps + vars  │     │                            │
└─────────────┘     └──────────────┘     │  docker services ──► one   │
       ▲                                  │  generated compose file    │
┌─────────────┐                          │                            │
│ plugin.json  │  (registry: built-ins   │  process services ──► pids │
│ manifests    │   + ./plugins/ locals)  │  + logs + health checks    │
└─────────────┘                          └───────────────────────────┘
```

1. **Plugins** (`platform/plugins/*/plugin.json` built-ins, plus your own in `./plugins/`) declare *how* a component runs: a `docker` image or a local `process` command, default config, env vars, and a health check.
2. **Stacks** (`stacks/*.json`) declare *what* your app is: named services, which plugin each uses, config overrides, and `dependsOn` edges.
3. **The engine** topologically sorts dependencies, interpolates variables (including cross-service references like `${service.db.port}`), starts Docker services as one compose project, starts process services in order, and waits for each health check before declaring the stack up.

## Commands

| Command | What it does |
|---|---|
| `npm run oneclick list` | Show every available plugin |
| `npm run oneclick up <stack>` | **One click**: start everything, wait for health, print URLs |
| `npm run oneclick down <stack>` | Stop everything (reverse dependency order) |
| `npm run oneclick status <stack>` | Live running/healthy state per service |
| `npm run oneclick logs <stack> <svc>` | Show a service's logs (`-f` to follow) |
| `npm run oneclick generate <stack>` | Emit the docker-compose file without starting anything |
| `npm run oneclick init plugin <name>` | Scaffold a new plugin in `./plugins/` |
| `npm run oneclick doctor` | Check Node/Docker environment |

Stack names resolve from `./stacks/` automatically — `up fullstack-demo` finds `stacks/fullstack-demo.json`.

## Built-in plugins

| Plugin | Runner | What you get |
|---|---|---|
| `static-frontend` | process | Serves any static folder (HTML/CSS/JS), zero deps |
| `node-service` | process | Runs any Node.js app — API, worker, bot |
| `postgres` | docker | PostgreSQL 16 |
| `redis` | docker | Redis 7 |
| `mongodb` | docker | MongoDB 7 |
| `kafka` | docker | Apache Kafka 3.7 (KRaft — no ZooKeeper) |

Process plugins need only Node. Docker plugins need a Docker daemon; without one, `up` still generates the compose file and tells you how to run it, and the rest of the stack starts normally.

## Writing a plugin (2 minutes)

```bash
npm run oneclick init plugin my-api
```

That creates `plugins/my-api/plugin.json`:

```json
{
  "name": "my-api",
  "runner": "process",
  "defaults": { "port": 3000 },
  "command": "node ${pluginDir}/server.js",
  "env": { "PORT": "${port}" },
  "health": { "type": "http", "port": "${port}", "path": "/" }
}
```

A **docker** plugin instead declares an image:

```json
{
  "name": "rabbitmq",
  "runner": "docker",
  "defaults": { "port": 5672 },
  "docker": {
    "image": "rabbitmq:3-management",
    "ports": ["${port}:5672"]
  },
  "health": { "type": "tcp", "port": "${port}" }
}
```

Drop it in `./plugins/` and it's immediately usable in any stack. Workspace plugins with the same name override built-ins.

## Writing a stack

```json
{
  "name": "my-app",
  "services": {
    "db":  { "plugin": "postgres", "config": { "user": "demo", "password": "demo", "database": "demo" } },
    "kafka": { "plugin": "kafka" },
    "api": {
      "plugin": "node-service",
      "config": {
        "cwd": "../examples/demo-app/backend",
        "command": "node server.js",
        "port": 4000,
        "env": {
          "DATABASE_URL": "postgres://${service.db.user}:${service.db.password}@localhost:${service.db.port}/${service.db.database}",
          "KAFKA_BROKERS": "localhost:${service.kafka.port}"
        }
      },
      "dependsOn": ["db", "kafka"]
    },
    "web": {
      "plugin": "static-frontend",
      "config": { "root": "../examples/demo-app/frontend", "port": 8080 },
      "dependsOn": ["api"]
    }
  }
}
```

Key features:
- `${...}` interpolation everywhere — `${port}`, `${service.db.port}`, `${env.HOME}`, `${stackDir}`, `${pluginDir}`
- `dependsOn` controls startup order (cycles are detected and rejected)
- `config.env` injects extra environment variables into a service
- Paths in `cwd`/`root` are relative to the stack file

## Variable reference

| Placeholder | Meaning |
|---|---|
| `${port}` (or any config key) | This service's resolved config value |
| `${service.<name>.<key>}` | Another service's resolved config value |
| `${env.<NAME>}` | Host environment variable |
| `${stackDir}` | Directory containing the stack file |
| `${pluginDir}` | Directory containing the plugin |
| `${serviceName}` / `${stackName}` | Names, useful in container labels/hostnames |

## Health checks

```json
{ "type": "http", "port": "${port}", "path": "/health" }
{ "type": "tcp",  "port": "${port}" }
{ "type": "none" }
```

`up` waits (default 30s, override with `healthTimeoutMs` in config) until each process service passes its check; `status` re-checks live.

## Runtime state

Everything lives in `.plugstack/` (gitignored): `state.json` (pids), `logs/<stack>-<service>.log`, and generated `<stack>.compose.yml` files.

## Testing

```bash
npm test   # engine smoke tests: interpolation, resolver, registry, compose generation
```

## 📱 Deploy from Telegram

The killer feature: **[PlugStack Deploy Bot](bot/README.md)** lets you deploy and manage stacks from your phone with password auth, confirmation buttons, and an audit trail:

```bash
TELEGRAM_BOT_TOKEN="123:abc" PLUGSTACK_BOT_PASSWORD="secret" npm run deploy-bot
```

## Roadmap ideas

- `plugstack watch` — restart a service on file change
- Remote targets: SSH deploy to a server, generate systemd units / k8s manifests from the same stack file
- Plugin marketplace: install plugins from git URLs
- Multi-user roles for the deploy bot (viewer / deployer / admin)
