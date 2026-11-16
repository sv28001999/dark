# API Server

A layered REST API built with **Node.js and Express 5**, written in plain JavaScript (ES modules).

- **Polymarket capture**: continuously records Polymarket's BTC Up/Down 5-minute events and their outcomes
  (UP/DOWN) in Firebase, split into an odd and an even group, and reports streaks.
- **Runs scripts**: you put Node.js scripts in `scripts/`, and the API runs them in the background and records
  their status and output.
- **Push notifications**: sends notifications to the mobile app through Firebase Cloud Messaging (FCM), including
  an alert to every registered device when the odd or even group has a set number of DOWN outcomes in a row. Needs
  `FIREBASE_SERVICE_ACCOUNT`; without it, notifications are only written to the server log.

> **Storage**: everything is stored in a Firebase Realtime Database, accessed through its public URL (REST API,
> no credentials). That means the database rules allow anyone with the URL to read and write it.

> **There is no authentication.** Anyone who can reach the server can run your scripts. Keep it on `localhost` or a
> private network, or put it behind something that restricts access.

## Project structure

```
├── src/
│   ├── server.js                # Entry point: starts the HTTP server, graceful shutdown
│   ├── app.js                   # Express app: security, logging, rate limit, routes, 404 + error handler
│   ├── config/
│   │   ├── index.js             # Loads + validates environment variables (fails fast on bad config)
│   │   ├── firebase.js          # Firebase Realtime Database REST client (get/put/patch/delete)
│   │   ├── database.js          # Save/read runs, notifications and devices in Firebase
│   │   ├── fcm.js               # Firebase Cloud Messaging (HTTP v1) client for push notifications
│   │   └── logger.js            # pino logger (pretty in dev, JSON in prod)
│   ├── constants/status.js      # Run, notification and event-outcome statuses
│   ├── routes/
│   │   ├── index.js             # Mounts /health and /api/v1
│   │   ├── health.routes.js
│   │   └── v1/                  # Versioned API routes
│   │       ├── capture.routes.js
│   │       ├── script.routes.js
│   │       ├── run.routes.js
│   │       ├── notification.routes.js
│   │       ├── device.routes.js
│   │       └── settings.routes.js
│   ├── validations/             # Zod schemas per endpoint
│   ├── controllers/             # HTTP layer: validate request, call service, send response
│   ├── services/                # Business logic (no req/res here)
│   │   ├── capture.service.js       # BTC Up/Down capture loop, odd/even records, streaks, DOWN streak alerts
│   │   ├── polymarket.service.js    # Calls to the Polymarket APIs
│   │   ├── script.service.js        # Starts/cancels script processes, records results
│   │   ├── notification.service.js  # Sends push notifications through FCM and records them
│   │   ├── device.service.js        # Push tokens of the devices the mobile app is installed on
│   │   └── settings.service.js      # Settings stored in Firebase, e.g. the DOWN streak alert
│   └── utils/                   # ApiError, response helper, validateRequest
└── scripts/                     # Your runnable scripts (example.js included)
```

## Request flow

```
Request
  → app.js        logging, helmet, cors, compression, body parsing, rate limit
  → routes        URL + method → controller
  → controller    validates input (validateRequest + a Zod schema), calls the service, sends the response
  → service       business rules, saves to Firebase (config/database.js, config/firebase.js)
Errors thrown anywhere → error handler at the bottom of app.js → consistent JSON error response
```

Express 5 forwards rejected promises to the error handler automatically, so async controllers need no `try/catch`.
Throw an `ApiError` (e.g. `ApiError.notFound()`) for expected failures. Any other error becomes a 500, and its
details are hidden in production.

## Getting started

Requirements: Node.js 20.12+.

```bash
npm install
cp .env.example .env    # set FIREBASE_DATABASE_URL; everything else has a default
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

| Method | Path                                    | Description                                                   |
| ------ | --------------------------------------- | ------------------------------------------------------------- |
| GET    | `/health`                               | Server status                                                 |
| GET    | `/api/v1/capture/status`                | Whether the capture loop is running, and since when           |
| GET    | `/api/v1/capture/start`                 | startCapturing: store the previous 40 events, start capturing |
| GET    | `/api/v1/capture/stop`                  | stopCapturing: stop the capture loop                          |
| GET    | `/api/v1/capture/records`               | getRecords: odd/even records, streak counts, last 20 outcomes |
| GET    | `/api/v1/capture/cleanup`               | Delete odd/even records except the latest 20 of each          |
| GET    | `/api/v1/scripts`                       | List runnable scripts                                         |
| POST   | `/api/v1/scripts/:name/run`             | Start a script in the background → `202` with the run         |
| GET    | `/api/v1/runs?limit=20`                 | Recent runs, newest first                                     |
| GET    | `/api/v1/runs/:runId`                   | One run: status, exit code, output, duration                  |
| POST   | `/api/v1/runs/:runId/cancel`            | Stop a running script                                         |
| POST   | `/api/v1/notifications`                 | Send a push notification and record it                        |
| GET    | `/api/v1/notifications?limit=20`        | Recent notifications, newest first                            |
| GET    | `/api/v1/notifications/:notificationId` | One notification                                              |
| POST   | `/api/v1/devices`                       | Register a device's push token (called by the mobile app)     |
| GET    | `/api/v1/settings`                      | Settings, e.g. `downStreakAlert`                              |
| PATCH  | `/api/v1/settings`                      | Change settings                                               |

### Capture: start, stop, records

Polymarket runs a `btc-updown-5m-<eventTime>` event every 5 minutes; `eventTime` is its start in Unix seconds, a
multiple of 300. `currentEventTime` is Polymarket's current time rounded down to that (1794623420 → 1794623400).

Records are stored in Firebase at `btc-updown-5m/odd/<eventTime>` and `btc-updown-5m/even/<eventTime>`:
`{ eventTime, slug, group, outcome, updatedAt }`. Consecutive events alternate between the groups: an event is
**even** when `eventTime / 300` is even, **odd** otherwise. `outcome` is `PENDING` until it's collected, then `UP`
or `DOWN` (`UNKNOWN` if Polymarket still has no result 15 minutes after the event ended).

**`GET /api/v1/capture/start`**

1. Stores the previous 40 events with their outcomes (outcomes already in Firebase are kept), and a `PENDING`
   record for the event in progress.
2. Removes every older record, so only those 40 (plus the current one) remain.
3. Counts how many DOWN outcomes in a row each group ends with (odd `D, D, U, U, U, D, D, D` → 3), and sends a
   DOWN streak alert (below) to all registered devices for each group where that reaches `downStreakAlert`.
4. Starts a loop (every 5 seconds) that runs until stop is called. It creates a `PENDING` record for every new
   event as it starts, and from 1 minute after each event ends checks Polymarket for its outcome and saves it as
   soon as it's published (usually 80–160 seconds after the end).

It returns `{ currentEventTime, capturing, savedRecords, removedRecords, downStreaks }`, where `downStreaks` is
e.g. `{ "odd": { "count": 3, "notification": "sent" }, "even": { "count": 0, "notification": null } }`:
each group's DOWN count, and the status of the notification sent for it (`sent`, `failed`, `logged`), or `null`
when none was sent.

Calling start again restarts the whole process, including the alerts. The loop runs inside the server: after a
server restart, call start again. On every server start, all records except the latest 40 are removed.

**`GET /api/v1/capture/stop`** stops the loop. Records already stored are kept.

**`GET /api/v1/capture/status`** returns `{ "capturing": true, "startedAt": "2026-11-15T16:00:02.114Z",
"latestEventTime": 1794760800 }`: whether the loop is running, when it was started (`null` when stopped), and
the newest event it has recorded (`null` before the first start). It answers from memory without calling
Polymarket or Firebase, so it's cheap to poll.

**`GET /api/v1/capture/cleanup`** deletes old records. In each group (odd, even) it keeps the latest 20 records
that have an outcome (UP/DOWN), plus any newer records still waiting for theirs (the event in progress, or one that
just ended). It returns how many were removed and kept per group, e.g.
`{ "removedRecords": { "odd": 7, "even": 0 }, "keptRecords": { "odd": 21, "even": 15 } }`. It can be called
while capturing.

**`GET /api/v1/capture/records`** returns:

- `currentEventTime`, and `capturing` (whether the loop is running).
- `oddRecords`, `evenRecords`: the latest 20 records of each group that have an outcome (UP/DOWN), oldest first.
- `oddDownCount`, `oddUpCount`, `evenDownCount`, `evenUpCount`: how many records in a row each group ends with
  that outcome. For `UP, DOWN, DOWN, UP, DOWN, DOWN, DOWN` the DOWN count is 3 and the UP count 0.
- `last20Outcomes`: the latest 20 outcomes of both groups together, oldest first.

**DOWN streak alerts.** On start, and each time the loop saves an outcome, the group's DOWN streak is counted. When
it reaches the `downStreakAlert` setting (default 2), every registered device gets a push notification, e.g.
"Odd: 2 DOWN in a row", and again on every DOWN after that, until an UP breaks the streak. The data payload is
`{ type: "down-streak", group: "odd", count: "2" }`.

### Settings

Stored in Firebase at `settings`. **`GET /api/v1/settings`** returns them, with defaults for any not saved yet:
`{ "downStreakAlert": 2 }`. **`PATCH /api/v1/settings`** with e.g. `{ "downStreakAlert": 3 }` saves the given
settings and returns all of them.

- `downStreakAlert` (1–20, default 2): how many DOWN outcomes in a row trigger a DOWN streak alert. It is read on
  every check, so a change applies from the next outcome.

### Push notifications

Notifications are sent through Firebase Cloud Messaging (FCM), to the Android notification channel `alerts`
that the mobile app creates. To enable sending:

1. In the Firebase console, open **Project settings → Service accounts → Generate new private key**.
2. Set `FIREBASE_SERVICE_ACCOUNT` to the downloaded file's contents (see [.env.example](.env.example)). Keep it
   secret: anyone with it can send notifications to your app's users.

Without it, notifications are written to the server log and saved with status `logged`. Otherwise the status is
`sent` (FCM accepted it for at least one target) or `failed`, with `sentCount`, `failedCount` and FCM's `errors`.

**`POST /api/v1/devices`** with `{ "token": "<FCM registration token>", "platform": "android" }` registers a
device. The mobile app calls it on every launch once notification permission is granted; registering the same
token again just updates it. Devices are stored at `devices/<id>` in Firebase, and removed automatically when FCM
reports their token as unregistered (for example, the app was uninstalled).

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
- `notify`: send a push notification when the script finishes. Give exactly one of `token`, `tokens` or `topic`.
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
[.env.example](.env.example) for the full list. `FIREBASE_DATABASE_URL` is required; the server refuses to start if
it's missing or a value is invalid. `FIREBASE_SERVICE_ACCOUNT` is optional and enables sending push notifications.
