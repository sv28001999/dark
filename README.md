# API Server

A layered REST API built with **Node.js and Express 5**, written in plain JavaScript (ES modules).

- **Polymarket capture**: reads the current BTC Up/Down 5-minute event from Polymarket and the outcomes of the
  previous ones.
- **Runs scripts**: you put Node.js scripts in `scripts/`, and the API runs them in the background and records
  their status and output.
- **Notifications**: the notification endpoints validate and record notifications, but **sending is not
  implemented yet**. Notifications are written to the server log.

> **Storage is in memory for now**: runs and notifications are lost when the server restarts. A database will be
> connected in `src/config/database.js` later.

> **There is no authentication.** Anyone who can reach the server can run your scripts. Keep it on `localhost` or a
> private network, or put it behind something that restricts access.

## Project structure

```
├── src/
│   ├── server.js                # Entry point: starts the HTTP server, graceful shutdown
│   ├── app.js                   # Express app: security, logging, rate limit, routes, 404 + error handler
│   ├── config/
│   │   ├── index.js             # Loads + validates environment variables (fails fast on bad config)
│   │   ├── database.js          # Save/read records (in memory for now)
│   │   └── logger.js            # pino logger (pretty in dev, JSON in prod)
│   ├── constants/status.js      # Run, notification and event-outcome statuses
│   ├── routes/
│   │   ├── index.js             # Mounts /health and /api/v1
│   │   ├── health.routes.js
│   │   └── v1/                  # Versioned API routes
│   │       ├── capture.routes.js
│   │       ├── script.routes.js
│   │       ├── run.routes.js
│   │       └── notification.routes.js
│   ├── validations/             # Zod schemas per endpoint
│   ├── controllers/             # HTTP layer: validate request, call service, send response
│   ├── services/                # Business logic (no req/res here)
│   │   ├── capture.service.js       # BTC Up/Down event time and previous outcomes
│   │   ├── polymarket.service.js    # Calls to the Polymarket APIs
│   │   ├── script.service.js        # Starts/cancels script processes, records results
│   │   └── notification.service.js  # Records notifications (sending not implemented)
│   └── utils/                   # ApiError, response helper, validateRequest
└── scripts/                     # Your runnable scripts (example.js included)
```

## Request flow

```
Request
  → app.js        logging, helmet, cors, compression, body parsing, rate limit
  → routes        URL + method → controller
  → controller    validates input (validateRequest + a Zod schema), calls the service, sends the response
  → service       business rules, saves via config/database.js
Errors thrown anywhere → error handler at the bottom of app.js → consistent JSON error response
```

Express 5 forwards rejected promises to the error handler automatically, so async controllers need no `try/catch`.
Throw an `ApiError` (e.g. `ApiError.notFound()`) for expected failures. Any other error becomes a 500, and its
details are hidden in production.

## Getting started

Requirements: Node.js 20.12+.

```bash
npm install
cp .env.example .env    # optional: every setting has a default
npm run dev             # starts with auto-reload on http://localhost:3000
```

## Scripts

| Script           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `npm run dev`    | Start with `node --watch` (restarts on file changes) |
| `npm start`      | Start in normal mode                                 |
| `npm run lint`   | ESLint                                               |
| `npm run format` | Prettier                                             |

## Endpoints

| Method | Path                                    | Description                                                       |
| ------ | --------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/health`                               | Server status                                                     |
| GET    | `/api/v1/capture/start`                 | startCapturing: current event time + previous 10 outcomes (below) |
| GET    | `/api/v1/capture/records`               | getRecords (placeholder: returns empty data)                      |
| POST   | `/api/v1/capture/stop`                  | stopCapturing (placeholder: returns empty data)                   |
| GET    | `/api/v1/scripts`                       | List runnable scripts                                             |
| POST   | `/api/v1/scripts/:name/run`             | Start a script in the background → `202` with the run             |
| GET    | `/api/v1/runs?limit=20`                 | Recent runs, newest first                                         |
| GET    | `/api/v1/runs/:runId`                   | One run: status, exit code, output, duration                      |
| POST   | `/api/v1/runs/:runId/cancel`            | Stop a running script                                             |
| POST   | `/api/v1/notifications`                 | Record a notification (logged, not sent)                          |
| GET    | `/api/v1/notifications?limit=20`        | Recent notifications, newest first                                |
| GET    | `/api/v1/notifications/:notificationId` | One notification                                                  |

### startCapturing

`GET /api/v1/capture/start` returns:

- `currentEventTime`: Polymarket's current time rounded down to the start of its 5-minute window
  (e.g. 1794623420 → 1794623400).
- `previousResults`: the previous 10 `btc-updown-5m-<time>` events, newest first, each with `outcome` `UP` or
  `DOWN`.

Polymarket publishes an event's result roughly 80–160 seconds after it ends. Called during that time, the request
waits until the result is available, so **it can take up to a few minutes**: set your client's timeout to at least
5 minutes. If a result still isn't available after 4 minutes, that event's outcome is `PENDING`.

### Run a script

```http
POST /api/v1/scripts/example/run
Content-Type: application/json

{
  "args": ["Alice"],
  "notify": { "token": "<device token>", "when": "always" }
}
```

Both fields are optional. A request with no body is fine.

- `args`: strings passed to the script as command-line arguments.
- `notify`: record a notification when the script finishes. Give exactly one of `token`, `tokens` or `topic`.
  `when` is `always` (default), `success` or `failure`.

The response is `202 Accepted` with the run (`status: "running"`). Poll `GET /api/v1/runs/:runId` to follow it.
Its status ends as one of `succeeded`, `failed`, `timed_out` or `cancelled`.

## Writing scripts

Every `.js` file in `scripts/` can be run by its file name (`scripts/backup-db.js` → `POST /api/v1/scripts/backup-db/run`).
Files starting with `_` (e.g. `_utils.js`) are never runnable, so use them for shared helpers.

- Arguments: `process.argv.slice(2)`. The run id is in `process.env.RUN_ID`.
- Everything printed to stdout/stderr is saved on the run (the last 10,000 characters of each).
- Exit code `0` = `succeeded`. Any other exit code or an uncaught error = `failed`.
- A script running longer than `SCRIPT_TIMEOUT_MS` is killed (`timed_out`). At most `MAX_CONCURRENT_RUNS` scripts
  run at once; further requests get `429`.
- Each run is a separate Node.js process, so a crashing script can't take the server down.

## Configuration

All settings come from environment variables, validated at startup in `src/config/index.js`. See
[.env.example](.env.example) for the full list. The server refuses to start if a value is invalid.
