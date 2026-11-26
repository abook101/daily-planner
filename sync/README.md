# Whoop sync (laptop → phone)

This folder has a small Python program that runs on the laptop. It downloads your
Whoop numbers (recovery %, HRV, resting heart rate, sleep, workouts) through Whoop's
official developer API, and hands them to the planner app on your iPhone when both
are on the home Wi-Fi.

- Only Python's standard library is used. **Nothing to install.**
- No cloud server: the data goes Whoop → your laptop → your phone.
- If the laptop is off or you're away, nothing breaks: type the numbers on Today
  as before.

## How it fits together

```
Whoop's servers  --(login + download, every 30 min)-->  laptop: sync/whoop_sync.py serve
                                                              |
                             https://<laptop>:8765/whoop.json |  (home Wi-Fi only,
                                                              v   needs the sync key)
                                          planner app on the iPhone (when you open it)
```

Why https and a certificate? The app on the phone is a secure (https) page, and
iPhones don't let a secure page download from a plain http address. So the laptop
answers over https with a home-made certificate that you tell the iPhone to trust,
once. The certificate is made on your laptop (`localcert.py`) and only works for it.

## Which numbers win? (the rules)

1. Nothing saved for that day → Whoop's numbers are saved (marked *From Whoop*).
2. Whoop numbers already saved → updated if Whoop changed them.
3. **You typed numbers for that day → they are never overwritten.** Today shows
   "Whoop says …" with a *Use Whoop numbers* button if Whoop's are different.
   (Editing a Whoop day by hand turns it into a typed day.)
4. Only the last 14 days; never future days; strange numbers are skipped.

---

## One-time setup (about 15 minutes)

All commands are typed in a terminal opened **in the project folder**
(`C:\Users\jadh1\Desktop\Projects\Dashboard`). Easiest way: open the folder in
File Explorer, click the address bar, type `cmd`, press Enter.

### Step 1: register a free Whoop developer app (5 min, in the browser)

This gives the script its own "key" to ask Whoop for your data. It's free and
the app stays private to you.

1. Go to **https://developer-dashboard.whoop.com** and log in with your normal
   Whoop account.
2. If it asks you to create a **Team** first, make one (any name, e.g. "Jad").
3. Click **Create App** and fill in:
   - **Name:** `Daily Planner` (anything works)
   - **Scopes:** tick `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`
     (and `offline` if it's in the list).
   - **Redirect URL:** exactly `http://localhost:8722/callback`
   - Other fields (logo, contact, privacy policy link): fill in what's required;
     the app is only used by you.
4. Save. You now see a **Client ID** and a **Client Secret**. Keep the page open.
   Treat the secret like a password: don't post it anywhere.

### Step 2: connect the laptop to Whoop (2 min)

```
python sync/whoop_sync.py setup
```

Paste the Client ID, then the Client Secret (right-click or Ctrl+V, once, then
press Enter; running it again, just press Enter to keep a saved value). Your browser opens Whoop's
"Allow access?" page: press **Allow**. The terminal then shows a table of your
last days. These are saved in `sync/config.json` and `sync/tokens.json`, which
git ignores, so they never end up in the project history.

The Whoop login renews itself automatically. You only log in again if you
remove the app's access in Whoop (then run `python sync/whoop_sync.py login`).

### Step 3: trust the laptop on the iPhone (5 min, once)

```
python sync/whoop_sync.py phone-setup
```

1. If Windows asks whether Python may use the network: tick **Private networks**
   and click **Allow**.
2. On the iPhone (same Wi-Fi), open **Safari** and type the address the terminal
   shows (like `http://192.168.1.23:8766`).
3. Follow the 4 steps on that page: download the certificate → Settings →
   *Profile Downloaded* → Install → Settings → General → About →
   *Certificate Trust Settings* → switch on **Daily Planner home sync CA**.
4. Press Ctrl+C in the terminal when you're done.

### Step 4: start the sync and connect the app

Double-click **`sync/start-whoop-sync.bat`** (or run
`python sync/whoop_sync.py serve`). The window shows the **laptop address** and
the **sync key**. In the planner app: gear → **Laptop sync (Whoop)** → type both →
**Save & test**. "Works!" means you're done.

From then on: whenever the sync window is running and you open the app at home,
the numbers fill in by themselves (at most every 10 minutes; *Sync now* on Today
forces it).

---

## Everyday use

- Start the sync: double-click `sync/start-whoop-sync.bat`. Leave the window open
  (minimised is fine). Closing it stops the sync.
- **Start it automatically with Windows:** double-click `sync/autostart-on.bat` once.
  The window then opens minimised every time you log in.
  **Undo:** double-click `sync/autostart-off.bat`.
- The laptop must be on and awake for the phone to get the numbers.
- If the laptop's Wi-Fi address changes while the sync runs, it makes a new
  certificate by itself within a minute and shows the new address in the window.
- Check what's set up: `python sync/whoop_sync.py status`
- Download now and look at the numbers: `python sync/whoop_sync.py fetch`

## When something doesn't work

| What you see | What to do |
|---|---|
| App: "Can't reach the laptop" | Is the sync window open? Same Wi-Fi? Laptop asleep? Certificate trusted (step 3)? Windows: Wi-Fi network set to **Private** (Settings → Network → Wi-Fi → your network). |
| App: "sync key is wrong" | Retype the key from the sync window in the app's Settings. |
| The laptop's address changed (e.g. after a router restart) | The sync window shows the new address; update it in the app. The certificate is renewed by itself; no iPhone step needed. |
| "Whoop login has expired" / "refused to renew" | `python sync/whoop_sync.py login` |
| Login page says the redirect URL is wrong | In the Whoop dashboard the Redirect URL must be exactly `http://localhost:8722/callback`. |
| Recovery shows "–" in the morning | Whoop hasn't scored it yet. It appears on the next sync. Or type it in. |

## Files

| File | What it is |
|---|---|
| `whoop_sync.py` | The program (login, download, https server, iPhone setup page) |
| `localcert.py` | Makes the home-made https certificates with plain Python |
| `start-whoop-sync.bat` | Double-click to start the sync |
| `autostart-on.bat` / `autostart-off.bat` | Start the sync with Windows / stop doing that |
| `test_whoop_sync.py` | Tests with a fake Whoop: `python sync/test_whoop_sync.py` (21 tests) |
| `config.json`, `tokens.json`, `certs/`, `whoop-data.json` | **Private**, made by the program, ignored by git. Never share them. |

Whoop data is downloaded for the last 14 days. Workouts are saved in
`whoop-data.json` but the app doesn't use them yet (logging stays manual).
