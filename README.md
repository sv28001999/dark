# API Server

A layered REST API built with **Node.js and Express 5**, written in plain JavaScript (ES modules).

- **Polymarket capture**: continuously records Polymarket's BTC Up/Down 5-minute events and their outcomes
  (UP/DOWN) in Firebase, split into an odd and an even group, and reports streaks.
- **Runs scripts**: you put Node.js scripts in `scripts/`, and the API runs them in the background and records
  their status and output.
- **Trading**: buys the DOWN side of odd or even events following a step ladder (bigger after a loss, back to $1
  after a win). Simulated by default (each buy is only saved as a trade in Firebase); with `TRADING_MODE=live` it
  places real orders on Polymarket with real money.
- **Push notifications**: sends notifications to the mobile app through Firebase Cloud Messaging (FCM), including
  an alert to every registered device when the odd or even group has a set number of UP outcomes in a row. Needs
  `FIREBASE_SERVICE_ACCOUNT`; without it, notifications are only written to the server log.

> **Storage**: everything is stored in a Firebase Realtime Database, accessed through its public URL (REST API,
> no credentials). That means the database rules allow anyone with the URL to read and write it.

> **Only the trading endpoints are protected**, by `TRADING_API_KEY` (required for live trading). Anyone who can
> reach the server can use the other endpoints, including running your scripts. Keep it on `localhost` or a
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
│   │       ├── settings.routes.js
│   │       └── trading.routes.js
│   ├── validations/             # Zod schemas per endpoint
│   ├── controllers/             # HTTP layer: validate request, call service, send response
│   ├── services/                # Business logic (no req/res here)
│   │   ├── capture.service.js       # BTC Up/Down capture loop, odd/even records, streaks, UP streak alerts
│   │   ├── btcEvent.service.js      # BTC Up/Down 5m events: timing, odd/even, outcomes, DOWN price
│   │   ├── trading.service.js       # Trading loop: odd/even, step ladder, trades (simulated or live)
│   │   ├── polymarketTrading.service.js # Live orders on Polymarket (@polymarket/client SDK)
│   │   ├── polymarket.service.js    # Calls to the Polymarket APIs
│   │   ├── script.service.js        # Starts/cancels script processes, records results
│   │   ├── notification.service.js  # Sends push notifications through FCM and records them
│   │   ├── device.service.js        # Push tokens of the devices the mobile app is installed on
│   │   └── settings.service.js      # Settings stored in Firebase, e.g. the UP streak alert
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
| GET    | `/api/v1/settings`                      | Settings, e.g. `upStreakAlert`                                |
| PATCH  | `/api/v1/settings`                      | Change settings                                               |
| POST   | `/api/v1/trading/odd/start`             | Start trading odd events                                      |
| POST   | `/api/v1/trading/even/start`            | Start trading even events                                     |
| POST   | `/api/v1/trading/odd/stop`              | Stop trading odd events                                       |
| POST   | `/api/v1/trading/even/stop`             | Stop trading even events                                      |
| POST   | `/api/v1/trading/stop`                  | Stop all trading                                              |
| GET    | `/api/v1/trading/status`                | Each group's trading state, and the step ladder               |

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
3. Counts how many UP outcomes in a row each group ends with (odd `U, U, D, D, D, U, U, U` → 3), and sends an
   UP streak alert (below) to all registered devices for each group where that reaches `upStreakAlert`.
4. Starts a loop (every 5 seconds) that runs until stop is called. It creates a `PENDING` record for every new
   event as it starts, and from 1 minute after each event ends checks Polymarket for its outcome and saves it as
   soon as it's published (usually 80–160 seconds after the end).

It returns `{ currentEventTime, capturing, savedRecords, removedRecords, upStreaks }`, where `upStreaks` is
e.g. `{ "odd": { "count": 3, "notification": "sent" }, "even": { "count": 0, "notification": null } }`:
each group's UP count, and the status of the notification sent for it (`sent`, `failed`, `logged`), or `null`
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

**UP streak alerts.** On start, and each time the loop saves an outcome, the group's UP streak is counted. When
it reaches the `upStreakAlert` setting (default 2), every registered device gets a push notification, e.g.
"Odd: 2 UP in a row", and again on every UP after that, until a DOWN breaks the streak. The data payload is
`{ type: "up-streak", group: "odd", count: "2" }`.

### Settings

Stored in Firebase at `settings`. **`GET /api/v1/settings`** returns them, with defaults for any not saved yet:
`{ "upStreakAlert": 2 }`. **`PATCH /api/v1/settings`** with e.g. `{ "upStreakAlert": 3 }` saves the given
settings and returns all of them. Settings that no longer exist (such as the old `downStreakAlert`) are ignored.

- `upStreakAlert` (1–20, default 2): how many UP outcomes in a row trigger an UP streak alert. It is read on
  every check, so a change applies from the next outcome.

### Trading

`TRADING_MODE` decides what a buy does:

- `simulated` (default): **nothing is sent to Polymarket**; each buy is only saved as a trade.
- `live`: **real orders on Polymarket with real money**, from the account in `POLYMARKET_PRIVATE_KEY` and
  `POLYMARKET_WALLET_ADDRESS` (see [Live trading](#live-trading)).

Each trade is saved in Firebase at `trades/<id>`: `{ group, eventTime, slug, side: "DOWN", orderType, amount, price,
quantity, step, epoch, placedAt, status, outcome, resolvedAt, simulated }`. `epoch` is when it was placed (Unix
seconds). `price` is the limit price, or for a market order the DOWN side's price at that moment (`null` if
unavailable). `quantity` is set for limit orders only. `status` is `open`, then `won` (the event ended DOWN), `lost`
(UP) or `unknown`, or `cancelled` (trading stopped before anything was bought, with `cancelledAt` and
`cancelReason`). Live trades have more fields and statuses, below.

Odd and even are traded separately, each on its own events. **`POST /api/v1/trading/odd/start`** (or `even`)
skips the event in progress and picks the group's next event. Its **starting step comes from the group's latest
results**, as if it had been trading all along: one more than the number of UP results its latest events ended
with (odd ended D, U, U, U → step 4; latest DOWN → step 1), up to step 10; events without a clear result are
skipped. If the group's newest event has no result yet, it waits for it (the next event starts later). The first
order is placed as soon as the step is known (`startedFrom: { step, upStreak }`). Then:

1. The order buys the DOWN side of its event, ahead of the event's start, with the current step's order (table
   below).
2. 1 minute after the event ends, its outcome is checked (again every 5 seconds until Polymarket has it).
3. DOWN: the trade won, the next trade is step 1. UP: it lost, the next trade is the next step. No outcome 15
   minutes after the end: `unknown`, the same step again.
4. As soon as the outcome is known, the next order is placed, on the group's first event that hasn't started yet.

| Step | Order                                                           |
| ---- | --------------------------------------------------------------- |
| 1    | $1 market                                                       |
| 2    | $1.50 market                                                    |
| 3    | $2.94 limit: 6 shares at $0.49                                  |
| 4–6  | limit at $0.49: 12, 24, 48 shares ($6, $12, $24)                |
| 7–10 | limit at $0.50: 96, 192, 384, 768 shares ($48, $96, $192, $384) |

Losing step 10 stops trading for the group. Starting a group that is already trading returns `409`. An order is placed at most 1 minute after its event starts; if the server was busy or asleep
past that, the event is skipped.

**Failures are retried.** Every Polymarket request is retried up to 5 times (waiting 1, 2, 3 and 4 seconds) when it
fails in a way that may pass: network error, timeout, HTTP 5xx or 429. A buy is retried up to 5 times too; if all
fail, that event is skipped, the next event is bought at the same step, and the error is shown in the app
(`lastError`) until the next successful buy.

**`POST /api/v1/trading/{odd|even}/stop`** stops a group and **`POST /api/v1/trading/stop`** stops both: no new
orders. An open order whose event hasn't started is cancelled; one whose event is under way stays open until its
outcome is recorded. An order that was being placed at the moment of the stop is cancelled too.
**`GET /api/v1/trading/status`** returns each group's state and the step table.

Each group's state is kept in Firebase at `trading/{odd|even}`, for the mobile app and for restarts: `{ active,
step, current, ifLost, nextEventTime, openTrade, placingTradeId, lastResult, lastError, startedFrom, resumedAt,
startedAt, stoppedAt, stoppedReason }`, where `current` is the open or next trade's step and order, and `ifLost`
the step after a loss (both `null` when stopped, or while the starting step is being chosen). Pending work is kept
at `tradingQueue`: trades waiting for their result (`unresolved`) and winnings to redeem (`redeem`).

**Trading continues across server restarts.** Stopping the server only pauses it (after letting a step in progress
finish); nothing is cancelled. On startup, each group that was trading continues with its own step, open trade and
next event, as its previous trades decided; its starting step is not chosen again (`resumedAt` is set). If the
open trade's result or the next event's start passed while the server was down, the first loop catches up: the
result is recorded and moves the step, and the next order goes on the group's first event that hasn't started.
Trades waiting for their result and winnings to redeem are picked up too. Live, if the server stopped while an
order was being sent (`placingTradeId`) and its trade is still `placing`, it's unclear whether it was placed: it's
marked `unconfirmed` and the group stops, to be checked on polymarket.com. **`npm run dev` restarts the server
whenever a source file is saved**; use `npm start` while trading.

All trading endpoints require the `X-Api-Key` header to equal `TRADING_API_KEY`, when it is set (always, in live
mode); otherwise they answer `401`.

#### Live trading

Set `TRADING_MODE=live`, `TRADING_API_KEY`, `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_WALLET_ADDRESS` (see
[.env.example](.env.example)); the server refuses to start if one is missing. The private key controls the
account's funds: keep it only in `.env` (gitignored) and the host's environment settings, never in git or chat.
Optionally set the relayer API key pair, used for gasless transactions such as redeeming winnings.

Before a group starts, the server checks that Polymarket doesn't block trading from its location
(`polymarket.com/api/geoblock`, `403` if it does) and connects to the account. Then, for each trade:

- **Market orders** (steps 1–2) are fill-or-kill for the step's USD amount (Polymarket's taker fee is added on top),
  at most at the price the current asks give for that amount: either all of it is bought, or nothing.
- **Limit orders** (steps 3–10) rest on the book until the event ends (good-till-date), then expire. Whatever filled
  counts as the trade.
- The trade's result uses the shares its order actually bought (`filledShares`): an order that bought nothing is
  `unfilled`, and the same step is tried on the next event.
- A won trade's winnings are **redeemed** for USDC automatically (`redeemedAt`, `redeemTx`), retried 1, 2, 4 and 8
  minutes after a failure; after that, claim them on polymarket.com (the app shows the error).
- Each trade is saved **before** its order is sent (`placing`), with `orderId`, `orderStatus`, `assetId` and
  `conditionId` once placed. A rejected order is saved as `failed` and retried (up to 5 times). An order whose
  sending failed in a way that leaves unclear whether it was placed (connection lost, timeout) is `unconfirmed`:
  it is **never retried** (it could buy twice), and trading stops for the group until you check polymarket.com.
- Stopping cancels the open order on Polymarket. Shares already bought (a market order, or a partly filled limit
  order) can't be undone: that trade stays open until its result.

### Push notifications

Notifications are sent through Firebase Cloud Messaging (FCM), to the Android notification channel `alerts_chime` (with the app's custom sound)
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
