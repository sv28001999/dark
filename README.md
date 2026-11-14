# API Server

A layered REST API built with **Node.js, Express 5 and Firebase**, written in plain JavaScript (ES modules).

It does two things:

- **Runs scripts.** You put Node.js scripts in `scripts/`, and the API runs them in the background. Each run's
  status and output are stored in the Firebase Realtime Database.
- **Sends push notifications** through Firebase Cloud Messaging (FCM). It can send to a device token, a list of
  tokens or a topic, either on request or automatically when a script finishes.

> **There is no authentication.** Anyone who can reach the server can run your scripts and send pushes to your
> users. Keep it on `localhost` or a private network, or put it behind something that restricts access.

## Project structure

```
├── src/
│   ├── server.js                # Entry point: connects Firebase, starts HTTP server, graceful shutdown
│   ├── app.js                   # Express app: security, logging, rate limit, routes, 404 + error handler
│   ├── config/
│   │   ├── index.js             # Loads + validates environment variables (fails fast on bad config)
│   │   ├── firebase.js          # Firebase Admin initialization + database connection status
│   │   ├── database.js          # Save/read records: Realtime Database, or memory if Firebase is off
│   │   └── logger.js            # pino logger (pretty in dev, JSON in prod)
│   ├── constants/status.js      # Run and notification statuses
│   ├── routes/
│   │   ├── index.js             # Mounts /health and /api/v1
│   │   ├── health.routes.js
│   │   └── v1/                  # Versioned API routes
│   │       ├── script.routes.js
│   │       ├── run.routes.js
│   │       └── notification.routes.js
│   ├── validations/             # Zod schemas per endpoint
│   ├── controllers/             # HTTP layer: validate request, call service, send response
│   ├── services/                # Business logic (no req/res here)
│   │   ├── script.service.js    # Starts/cancels script processes, records results
│   │   └── notification.service.js  # Sends via FCM, records results
│   └── utils/                   # ApiError, response helper, validateRequest
└── scripts/                     # Your runnable scripts (example.js included)
```

## Request flow

```
Request
  → app.js        logging, helmet, cors, compression, body parsing, rate limit
  → routes        URL + method → controller
  → controller    validates input (validateRequest + a Zod schema), calls the service, sends the response
  → service       business rules (spawn scripts, send FCM messages), saves via config/database.js
Errors thrown anywhere → error handler at the bottom of app.js → consistent JSON error response
```

Express 5 forwards rejected promises to the error handler automatically, so async controllers need no `try/catch`.
Throw an `ApiError` (e.g. `ApiError.notFound()`) for expected failures. Any other error becomes a 500, and its
details are hidden in production.

## Getting started

Requirements: Node.js 20.12+ and a Firebase project with the **Realtime Database** created.

1. In the [Firebase Console](https://console.firebase.google.com), go to **Project settings → Service accounts →
   Generate new private key**. Save the file as `serviceAccountKey.json` in the project root. It is in
   `.gitignore`; never commit it.
2. Copy your database URL from **Realtime Database → Data** (it looks like
   `https://<project-id>-default-rtdb.firebaseio.com`).
3. Configure and start the server:

```bash
npm install
cp .env.example .env    # set FIREBASE_DATABASE_URL (and FIREBASE_SERVICE_ACCOUNT_PATH if you saved the key elsewhere)
npm run dev             # starts with auto-reload on http://localhost:3000
```

The server uses admin credentials, which bypass database security rules. You can therefore lock the database down
completely for clients (`".read": false, ".write": false`).

### Running without Firebase

To try the API before Firebase is set up, put `FIREBASE_ENABLED=false` in `.env`. You don't need a key file or
database URL. Everything works, with two differences:

- Runs and notifications are kept in memory and are lost when the server restarts.
- Notifications are written to the server log instead of being sent. They are saved with status `simulated`.

Set `FIREBASE_ENABLED=true` once Firebase is configured.

## Scripts

| Script           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `npm run dev`    | Start with `node --watch` (restarts on file changes) |
| `npm start`      | Start in normal mode                                 |
| `npm run lint`   | ESLint                                               |
| `npm run format` | Prettier                                             |

## Endpoints

| Method | Path                                    | Description                                                                |
| ------ | --------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/health`                               | Server + database status (503 if database is down)                         |
| GET    | `/api/v1/scripts`                       | List runnable scripts                                                      |
| POST   | `/api/v1/scripts/:name/run`             | Start a script in the background → `202` with the run                      |
| GET    | `/api/v1/runs?limit=20`                 | Recent runs, newest first                                                  |
| GET    | `/api/v1/runs/:runId`                   | One run: status, exit code, output, duration                               |
| POST   | `/api/v1/runs/:runId/cancel`            | Stop a running script                                                      |
| POST   | `/api/v1/notifications`                 | Send a push notification                                                   |
| GET    | `/api/v1/notifications?limit=20`        | Recent notifications, newest first                                         |
| GET    | `/api/v1/notifications/:notificationId` | One notification and its delivery result                                   |
| GET    | `/api/v1/capture/records`               | getRecords (placeholder: returns empty data)                               |
| GET    | `/api/v1/capture/start`                 | startCapturing: `currentEventTime` = Polymarket time rounded down to 5 min |
| POST   | `/api/v1/capture/stop`                  | stopCapturing (placeholder: returns empty data)                            |

### Run a script

```http
POST /api/v1/scripts/example/run
Content-Type: application/json

{
  "args": ["Alice"],
  "notify": { "token": "<device FCM token>", "when": "always" }
}
```

Both fields are optional. A request with no body is fine.

- `args`: strings passed to the script as command-line arguments.
- `notify`: send a push when the script finishes. Give exactly one of `token`, `tokens` or `topic`.
  - `when` is `always` (default), `success` or `failure`.
  - `title` and `body` are optional. By default the title is `Script "example" succeeded` (or failed / timed out)
    and the body is the last line the script printed.
  - The notification's `data` contains `runId`, `script` and `status`, so the app can open the right screen.

The response is `202 Accepted` with the run (`status: "running"`). Poll `GET /api/v1/runs/:runId` to follow it.
Its status ends as one of `succeeded`, `failed`, `timed_out` or `cancelled`.

### Send a notification

```http
POST /api/v1/notifications
Content-Type: application/json

{
  "topic": "news",
  "title": "Hello",
  "body": "Your report is ready",
  "imageUrl": "https://example.com/image.png",
  "data": { "screen": "reports" }
}
```

- Use exactly one of `token`, `tokens` (up to 500) or `topic`.
- `imageUrl` and `data` are optional. `data` values must be strings.

Possible responses:

- `201`, status `sent`: everything was delivered.
- `201`, status `partial`: some tokens failed. The failed tokens are listed in `failures`.
- `502`: nothing was delivered.

Every attempt is saved and can be viewed with `GET /api/v1/notifications`.

## Writing scripts

Every `.js` file in `scripts/` can be run by its file name (`scripts/backup-db.js` → `POST /api/v1/scripts/backup-db/run`).
Files starting with `_` (e.g. `_utils.js`) are never runnable, so use them for shared helpers.

- Arguments: `process.argv.slice(2)`. The run id is in `process.env.RUN_ID`.
- Everything printed to stdout/stderr is saved on the run (the last 10,000 characters of each).
- Exit code `0` = `succeeded`. Any other exit code or an uncaught error = `failed`.
- A script running longer than `SCRIPT_TIMEOUT_MS` is killed (`timed_out`). At most `MAX_CONCURRENT_RUNS` scripts
  run at once; further requests get `429`.
- Each run is a separate Node.js process, so a crashing script can't take the server down.

A script can use Firebase itself:

```js
import { getDatabase } from 'firebase-admin/database';
import { closeFirebase, initFirebase } from '../src/config/firebase.js';

initFirebase();
await getDatabase().ref('reports/latest').set({ createdAt: Date.now() });
await closeFirebase(); // otherwise the open connection keeps the script running
```

## Data in the Realtime Database

```
runs/<runId>                  script, args, status, exitCode, stdout, stderr, startedAt, finishedAt, durationMs, notification
notifications/<notificationId>  token|tokens|topic, title, body, data, status, successCount, failureCount, failures, source, createdAt
```

Ids are Firebase push keys, which sort by creation time.

## Configuration

All settings come from environment variables, validated at startup in `src/config/index.js`. See
[.env.example](.env.example) for the full list. The server refuses to start if a value is missing or invalid, and
it also fails if it can't reach the Realtime Database within 10 seconds.
