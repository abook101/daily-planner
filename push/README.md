# Phone notifications and widget (step 8)

Important events show in your iPhone's notifications even when the app is closed, and a
home-screen widget counts down to the next one. Everything is free and has no card on file.

## How it works

```
planner app  --(uploads upcoming events)-->  your Cloudflare Worker (push/worker.mjs)
                                                   |  every minute: anything due?
                                                   v
iPhone notification  <--(empty "ring" via Apple)--  Worker
        ^  the phone then asks the Worker what text to show
Scriptable widget  --(asks /next)-->  Worker  ->  next event + live countdown
```

- The Worker lives on **your own** Cloudflare account. Events (names of reminders, subjects)
  are stored there, locked by a secret key. Nothing goes to anyone else.
- The ring through Apple carries no text. The phone fetches the text from your Worker.
- The Worker address and key are saved **on the phone only** (not in backups, not on the
  public website, not in git).

## What you get notified about

Each can be switched off in Settings > Notifications & widget.

| Kind | When |
|---|---|
| Reminder | At its time minus "Min before" (default 10). No time set: at the morning time. |
| Morning plan | At the morning time (08:00): study subjects, chores, reminders, training |
| Study nudge | At 18:00, only if you haven't logged study today |
| Study timer | When a running timer reaches its block length |
| Exam | Not a notification: the next exam's days-left line on the widget |

The app uploads the next 7 days whenever something changes (and at least every 6 hours it's
open). Events already uploaded still ring if you don't open the app for days. The morning
plan for tomorrow is based on what the app knew when you last opened it.

## One-time setup (about 15 minutes)

You need: the planner installed on the home screen (iPhone, iOS 16.4 or newer).

### A. The Worker on Cloudflare

1. Go to https://dash.cloudflare.com and sign up (free, no card).
2. **Workers & Pages > Create > Create Worker**. Name it `daily-planner-push`, then **Deploy**.
3. Click **Edit code**. Delete everything, paste the full contents of `push/worker.mjs`,
   then **Deploy**.
4. **Storage & databases > KV > Create** a namespace called `planner`.
5. Open your Worker > **Settings > Bindings > Add > KV namespace**. Variable name:
   `PLANNER` (exactly), namespace: `planner`. Save.
6. **Settings > Variables and secrets > Add**: type **Secret**, name `API_KEY`, value = a long
   random text, at least 16 characters (a password manager's generator is perfect; no spaces).
   Keep a copy of it, you type it into the app next.
7. **Settings > Trigger events > Cron triggers > Add**: `* * * * *` (every minute).
8. Copy the Worker's address from the top of its page. It ends in `.workers.dev`.
   Opening it in a browser should show `{"app":"daily-planner-push","ok":true}`.

(If you prefer the command line: `push/wrangler.toml` is ready; run `npx wrangler deploy` and
`npx wrangler secret put API_KEY` in the `push` folder.)

### B. Turn it on in the app

1. Open the planner **from its home-screen icon** > gear > **Notifications & widget**.
2. Paste the Worker address and the key. Tap **Save & turn on** and press **Allow** when
   iPhone asks.
3. Tap **Send test**. Lock the phone: the notification arrives within seconds.

If the allow question doesn't appear: iPhone Settings > Notifications > Planner >
Allow Notifications, then tap **Save & turn on** again.

### C. The widget (free app Scriptable)

Apple doesn't let web apps make widgets, so the widget is a tiny script run by the free
**Scriptable** app.

1. Install **Scriptable** from the App Store.
2. In the planner: Settings > **Copy widget script**.
3. In Scriptable: tap **+**, paste, tap the name at the top and call it `Planner`.
4. Home screen: long-press > **+** > Scriptable > pick a size > Add Widget. Long-press the new
   widget > **Edit Widget** > Script: `Planner`.
   (Lock screen: Settings > Wallpaper > Customize > Lock Screen > Add Widgets > Scriptable.)

The widget shows the kind, title, a **live countdown**, the time, and the next exam's days
left. The countdown ticks by itself; iPhone itself decides how often the widget fetches new
data (roughly every 15 to 60 minutes), so a just-added reminder can take a while to show.
The last answer is saved, so the widget still works offline.

## Limits you should know about

- A real iPhone widget or Live Activity (the countdown on the lock screen / Dynamic Island)
  from the planner itself would need a native iOS app, which needs a Mac and an Apple developer
  account (99 EUR a year). Scriptable is the free workaround.
- iPhone Focus / Do Not Disturb modes silence the notifications as usual.
- Cloudflare's free plan allows 100,000 requests a day; this uses about 1,500.
- If notifications ever stop: Settings > Notifications & widget shows the last problem. After
  reinstalling the home-screen app or changing the Worker/key, tap **Save & turn on** again.
- To turn everything off: **Turn off** in the app, then delete the Worker in Cloudflare.

## Tests

`node push/test_worker.mjs` (the Worker, with a fake Apple push service and a fake KV) and
`node tests/notify.test.js` (the app side). Both run in the website build check too.
