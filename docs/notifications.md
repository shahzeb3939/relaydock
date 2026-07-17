# Push notifications

RelayDock can send a Web Push notification when a job needs your attention, so
you don't have to keep a tab open. Notifications work on laptops (Chrome, Edge,
Firefox, Safari) and Android; on iPhone/iPad they require the app to be added to
the Home Screen first (see [iOS](#ios)).

## When a notification fires

The server emits a push the moment a job transitions to one of:

| Status              | Notification title            |
| ------------------- | ----------------------------- |
| `waiting_for_input` | **Waiting for your input**    |
| `completed`         | **Job completed** (or `Job finished · exit N` when the exit code is non-zero) |
| `failed`            | **Job failed**                |

Deliberately **not** notified: `cancelled` (you triggered it) and
`disconnected` (usually a transient blip the agent recovers from). The
notification body is only the **repository name** — the raw command can contain
secrets and would land on a lock screen, so identity comes from the repo and
tapping the notification opens the full session.

## Enabling push (server config)

Push is inert until a VAPID key pair is configured. The private key is a secret
— generate your own and store it in your secret manager / deployment env; never
commit it.

1. Generate a key pair:

   ```sh
   npx web-push generate-vapid-keys
   ```

2. Apply the database migration that adds the `PushSubscription` table, pointing
   `DATABASE_URL` at the target database. **Do this before enabling the keys** —
   the subscribe endpoint writes to this table:

   ```sh
   pnpm --filter @relaydock/server prisma:deploy
   ```

3. Set three environment variables (repo-root `.env` for local, and the Vercel
   **api** service env for production):

   | Variable            | Value                                                     |
   | ------------------- | --------------------------------------------------------- |
   | `VAPID_PUBLIC_KEY`  | the public key from step 1                                |
   | `VAPID_PRIVATE_KEY` | the private key from step 1 (**secret**)                  |
   | `VAPID_SUBJECT`     | a contact `mailto:` address or an `https://` URL          |

   All three are required together; a partial set is rejected at startup. Each
   also accepts a `RELAYDOCK_`-prefixed alias (e.g. `RELAYDOCK_VAPID_PUBLIC_KEY`).

With the keys present the server exposes the public key at
`GET /api/push/config`, and the web UI shows an **Enable notifications** toggle
(in the sidebar on desktop, the header on mobile). Without the keys the toggle
is hidden.

## Enabling push (per browser)

Each browser opts in individually via the toggle, which requests notification
permission and registers a subscription. Turning it off unsubscribes that
browser. Subscriptions are scoped to your user account; a subscription the push
service later reports as expired (HTTP 404/410) is pruned automatically on the
next send.

## iOS

Safari on iPhone/iPad only delivers Web Push to a site installed as a PWA. Open
RelayDock in Safari, tap **Share → Add to Home Screen**, then open it from the
Home Screen and use the toggle. Until then the toggle shows an "Add to Home
Screen" hint. (RelayDock already ships an installable manifest and icons.)

## How it works

- The service worker (`apps/web/public/sw.js`) handles the `push` and
  `notificationclick` events. A per-job `tag` means a newer state replaces the
  older notification for the same job instead of stacking.
- The server's `PushService` (`apps/server/src/services/push.ts`) is called
  from the single job-transition chokepoint (`JobService.transitionFromAgent`),
  so a push is sent by whichever process is already handling the agent message —
  no always-on background worker is required.
- Delivery is fire-and-forget: a push failure can never affect the job
  transition that triggered it.
