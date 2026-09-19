# Quest Runner — local dashboard

This project adds a dashboard visually modeled on the supplied reference image: token form, Run button, live run cards, real-time console, Stop, and Clear finished. It wraps the existing `bot.ts`; it does not change the quest-completion implementation.

## Windows setup

1. Install **Node.js 24 or later** and open Command Prompt in this folder.
2. Run `npm install`.
3. Run `npm start`.
4. Open **http://127.0.0.1:3000** on the *same computer*.
5. Paste **your own** token, select **Run**, and watch the live console. The input is cleared when the run begins.

To choose another port: in Command Prompt, run `set DASHBOARD_PORT=3001` before `npm start`.

**Important:** The server listens on `127.0.0.1` only. Do not publish its port, tunnel it, or expose it on an unauthenticated Pterodactyl endpoint. The dashboard passes the token to the runner through a temporary process environment rather than saving it in `.env`, run history, or HTML. The original archive's `.env` was intentionally omitted from this package. If it held an active token, revoke/rotate that token, especially if you've uploaded or shared the archive.

A process exiting normally is reported as **finished**, not proof that every quest was completed or every reward claimed. This is an unofficial user-account selfbot. The source project's README warns that Discord prohibits selfbots and accounts may be suspended. Certain quest types are experimental or unsupported. There is no guarantee the original runner works with current Discord APIs.

The dashboard can show **one active run at a time**, keeps up to **eight run cards** in memory, and keeps up to **350 console lines per run**. Refreshing the page reconnects to the live logs; stopping the dashboard clears all history. The dashboard requires network access from the runner to Discord, but the dashboard itself does not need to be published.

## Scripts

- `npm start` or `npm run dashboard` — dashboard
- `npm run bot` — run the original bot directly (needs `TOKEN` in environment)
- `npm run github` — original GitHub-oriented script (needs `TOKEN` in environment)

The original project's `readme.md` and `LICENSE` are included; retain its GPL-3.0-only license if you redistribute modified source.
