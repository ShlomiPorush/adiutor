# Deploying Mikud

Status: written ahead of the launch; nothing here has been run against a production server. The board UI and the Telegram bot are on `main` (rows 7 and 8 of the [foundation plan](project-foundation.md)); the dry run on the development stack comes first (step 7).

These notes are for the owner, who deploys production himself. Agents never deploy. Replace every example value (`mikud.example.com`, `db.example.com`, `<...>`) with your own; keep the real values in `.env` on the server and in your private notes, never in the repository.

## What you deploy

- **Image:** `ghcr.io/shlomiporush/mikud:<version>`, published by the Release workflow. Every release has an immutable version tag (`0.1.0`) and moves `latest`. Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
- **One container:** `docker-compose.yml` runs only `mikud`. It keeps no files: all state is in your PostgreSQL database. It runs as `node` with no capabilities, no new privileges and a read-only root file system.
- **Migrations** run on every start, before the server listens. There is no separate migration step.
- **Backups** are yours: back up the Mikud database with your own tools. Mikud has no backup feature.

## 1. Create the database

1. Generate a password for the database role (hex, so it needs no escaping in a URL):

   ```bash
   openssl rand -hex 24
   ```

2. Mikud needs PostgreSQL 17 or newer: every connection sets `transaction_timeout`, which older servers refuse, and the "new since your last visit" boundary relies on it. On your PostgreSQL server, as a superuser, create a role and a database that only Mikud uses:

   ```sql
   CREATE ROLE mikud LOGIN PASSWORD '<database password>';
   CREATE DATABASE mikud OWNER mikud;
   REVOKE ALL ON DATABASE mikud FROM PUBLIC;
   ```

   The role owns its database, so the migrations can create their tables. It needs no other rights.

3. Allow the role to connect from the Docker host in your server's `pg_hba.conf`, and only from there.

4. Write the connection URL for `.env`:

   ```text
   DATABASE_URL=postgres://mikud:<database password>@db.example.com:5432/mikud
   ```

   When the database is on another host, add `?sslmode=verify-full` (or `?sslmode=require` when the server's certificate cannot be verified). When PostgreSQL runs in a container on the same Docker host, use its container name as the host and attach `mikud` to that container's network (step 3).

## 2. Write `.env`

1. Copy `docker-compose.yml` and `.env.example` from the release's tag into a deploy directory on the server, and rename the copy to `.env`.
2. Restrict it: `chmod 600 .env`.
3. Generate the two tokens and the auth secret. Run the command three times; the server refuses to start when a value is shorter than 32 characters (32 bytes for the secret) or two of them are equal:

   ```bash
   openssl rand -hex 32   # MIKUD_OWNER_TOKEN
   openssl rand -hex 32   # MIKUD_AGENT_TOKEN
   openssl rand -hex 32   # MIKUD_AUTH_SECRET
   ```

4. Fill in every value; `.env.example` explains each one:
   - `VERSION`: the release to run, for example `0.1.0`.
   - `DOMAIN`: the host name you open, for example `mikud.example.com`.
   - `DATABASE_URL`: from step 1.
   - `MIKUD_PUBLIC_URL`: `https://` and `DOMAIN`, exactly what the browser's address bar shows. Browser changes whose `Origin` differs are refused, and Telegram links use it.
   - `MIKUD_OWNER_TOKEN`, `MIKUD_AGENT_TOKEN`: from step 3. The owner token is only for you, for scripts and the API; a browser never uses it. Agents get only the agent token.
   - `MIKUD_AUTH_SECRET`: from step 3. It signs the browsers' sign-in cookies and encrypts the TOTP secret. Keep it with the backup of `.env`: with another value every browser is signed out and the stored TOTP secret cannot be read, so you would need the recovery command (step 8).
   - `MIKUD_PRIVATE_DOMAINS`: optional; your private network's domains, so agents cannot write host names under them into Mikud.
   - `MIKUD_TELEGRAM_BOT_TOKEN` and `MIKUD_TELEGRAM_CHAT_ID`: optional, both or neither (the server refuses to start with one). Without them the bot and the morning message are off. Leave `TELEGRAM_API_URL` empty.

## 3. Fit the network

Mikud must be reachable only over your NetBird network. The shipped `docker-compose.yml` puts it behind Traefik on the external Docker network `traefik`, publishes no port, and asks Traefik for one router:

| Label | Shipped value | Change it to |
|---|---|---|
| `traefik.docker.network` and the `networks:` entry | `traefik` | The Docker network your reverse proxy uses |
| `traefik.http.routers.mikud.entrypoints` | `https` | Your proxy's entry point that only NetBird can reach |
| `traefik.http.routers.mikud.middlewares` | `default@file` | Your middleware chain (headers, and an allow list of NetBird addresses if you use one) |
| `traefik.http.routers.mikud.tls` | `true` | Add `traefik.http.routers.mikud.tls.certresolver=<resolver>` if your proxy needs it |

1. Put a NetBird private service in front of the proxy: a NetBird network resource (or route) for the proxy host, with an access policy that allows only your own peers.
2. Make `DOMAIN` resolve only inside NetBird, for example with a NetBird DNS zone or a private DNS record that points at the proxy's NetBird address.
3. Bind the proxy's entry point for Mikud to the NetBird interface, or firewall it so that only the NetBird interface reaches it. Never publish the `mikud` container's port on a public interface.
4. Serve HTTPS with a certificate the browsers trust; for a private name, a DNS challenge or your own CA works. With an `https://` public URL the sign-in cookies are `Secure`, so plain HTTP does not work in production.
5. With a reverse proxy other than Traefik: remove the `labels:`, attach `mikud` to the proxy's Docker network and proxy `https://mikud.example.com` to `http://mikud:8080`. Pass the `Origin` header through unchanged.

Mikud counts attempts by the address of the connection it receives and never trusts a forwarding header, which a client could forge. Behind a proxy every client has the proxy's address, so the limits apply to all your devices together: 10 failed token attempts a minute, and 5 sign-ins, 5 TOTP codes and 5 password changes per 5 minutes. For one owner that is acceptable and fails safe; if you lock yourself out by mistyping, wait 5 minutes.

## 4. Start and check

1. In the deploy directory:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps          # mikud: running (healthy) after up to 30 seconds
   docker compose logs mikud  # migrations applied, then the listening port
   ```

2. From a device on NetBird:

   ```bash
   curl -fsS https://mikud.example.com/healthz
   # {"status":"ok","database":"ok"}
   ```

3. From a device outside NetBird (a phone on mobile data with NetBird off), check that the same URL does not answer.

`/healthz` answers 503 with `"database":"down"` when PostgreSQL does not answer; Docker then marks the container unhealthy.

## 5. Create your account and sign in

The browser signs in with a username, a password and a code from an authenticator app (TOTP). There is one account, yours.

1. Open `https://mikud.example.com` on the desktop. On a new database it shows the setup: choose a username (3 to 30 letters, digits, dots or underscores) and a password of at least 12 characters.
2. Set up two-factor authentication right away; it is required. Scan the QR code with an authenticator app such as 1Password, Aegis or Google Authenticator, or type the key shown under it, then enter the code the app shows. Mikud has no backup codes: keep the TOTP key in your password manager, and use the recovery command (step 8) when you lose it.
3. On the phone, with NetBird connected, open the same URL and sign in with the username, the password and a code.
4. A browser stays signed in for 30 days after it signs in, then asks again. Settings, General changes that length (1 to 90 days) and can also sign a browser out after a time without activity (off by default). Settings, Account lists the signed-in browsers, changes the password, signs this browser out, signs the others out, or signs out everywhere.
5. Telegram links open the item after you sign in, when the browser is not signed in.

**Upgrading from a version with pairing.** The first start of a version with sign-in shows the setup once; paired browsers are signed out (their device cookie no longer counts). Your data, and "new since your last visit" history, stay. Each browser starts a new "last visit" once.

## 6. Connect the agents and the reconciler

- **Agents:** [agent-instruction.md](agent-instruction.md) has the MCP configuration for Claude Code and Codex and the instruction text. Use `https://mikud.example.com/mcp` and the agent token, read from the `MIKUD_AGENT_TOKEN` environment variable.
- **Reconciler:** on your PC, the T3 scheduled task in [prompts/reconcile.md](../prompts/reconcile.md) runs the sync tool described in [sync.md](sync.md). Its env file sets `MIKUD_URL=https://mikud.example.com` and the agent token. After its first run, `GET /api/v1/sync/runs` shows the run's outcome.

## 7. Move from the dry run to production (once)

The dry run runs on the development stack on your PC with real data. Move its data once, after you approved the dry run (requirements section 9). Production must not run before step 5: the migrations would create empty tables that the restore cannot overwrite.

**Real settings for the dry run.** `docker/dev.env` holds only fake values. Put the real ones in `.env.dev` at the root of the Mikud checkout in WSL; git ignores it, and the development stack reads it after `docker/dev.env`, so its values win:

```text
MIKUD_OWNER_TOKEN=<openssl rand -hex 32>
MIKUD_AGENT_TOKEN=<openssl rand -hex 32>
MIKUD_AUTH_SECRET=<openssl rand -hex 32>
MIKUD_TELEGRAM_BOT_TOKEN=<from BotFather>
MIKUD_TELEGRAM_CHAT_ID=<your chat id>
```

Restrict it (`chmod 600 .env.dev`). A `docker-compose-dev.yml` copied before this change does not read `.env.dev`: copy `docker/docker-compose-dev.example.yml` again, then `scripts/local.sh up`. `scripts/verify.sh` and `scripts/try-pr.sh` never read `.env.dev`. To check the bot without waiting for 08:00, use Settings, "Send a test morning message": it sends today's message now and does not change the 08:00 send.

1. Pause the reconciler's T3 scheduled task.
2. Stop the local application, and keep its database running. The local stack is the only consumer of the Telegram bot; two consumers would take each other's updates. In the Mikud checkout in WSL:

   ```bash
   source scripts/lib/common.sh
   dev_compose stop mikud
   ```

3. Dump the development database to a file outside every repository. It holds your real data: keep it private.

   ```bash
   mkdir -p ~/mikud-move && chmod 700 ~/mikud-move
   dev_compose exec -T postgres pg_dump -U mikud -d mikud -Fc >~/mikud-move/mikud.dump
   ```

4. Create the production database (step 1) and write `.env` (step 2) if you have not yet. The database must be empty: if production already started once, drop and create it again.
5. Restore the dump into it from a machine that reaches the production PostgreSQL. Use `pg_restore` from PostgreSQL 18 or newer, because the development database is PostgreSQL 18; a production server older than 18 may refuse parts of the dump, so check its version first.

   ```bash
   read -rs PGPASSWORD && export PGPASSWORD   # the production role's password; stays out of the history
   docker run --rm -i -e PGPASSWORD postgres:18-bookworm \
     pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
     -h db.example.com -U mikud -d mikud <~/mikud-move/mikud.dump
   unset PGPASSWORD
   ```

   The dump carries everything, including the applied migrations, `job_runs` (so today's morning message is not sent twice) and `telegram_updates` (so no Telegram update is handled twice).

6. Start production and check it (step 4).
7. Sign in with your dry-run account and sign out everywhere (step 8, "After any restore"). Sign-in cookies belong to a host, so the browsers signed in on the PC are not signed in on the production host anyway. When production's `MIKUD_AUTH_SECRET` differs from the dry run's, the stored TOTP secret cannot be read: run the recovery command (step 8) and set up TOTP again.
8. Point the reconciler's env file at production: `MIKUD_URL=https://mikud.example.com` and the production agent token. Resume its scheduled task and check its first run.
9. Point the agents' MCP configuration at production (step 6).
10. Keep the local stack off: `scripts/local.sh down`. Remove the bot settings from `.env.dev` (or delete the file) before you ever start it again.
11. Delete the dump: `rm -r ~/mikud-move`.

## 8. Recovery and after any restore

**Locked out** (password or authenticator app lost): on the server, in the deploy directory, run

```bash
docker compose exec mikud node dist/server/cli.js reset-password
```

It prints the username and a new random password once, removes two-factor authentication, signs out every browser and ends any sign-in in progress, and records the reset in the activity log (actor "system", source "server command"). Sign in with that password, set up TOTP again (the setup shows by itself), then change the password in Settings, Account. Only someone with shell access to the server can run it; Mikud has no other way back in.

**After any restore**, whether a dry-run move or a backup: a restored database can hold sign-ins that you ended after the backup was taken, and their browsers' cookies would count again. So:

1. Sign in and choose Settings, Account, "Sign out everywhere", then sign in again. When you cannot sign in, the recovery command above also signs out every browser.
2. If `.env` or the backup may have leaked, replace `MIKUD_AUTH_SECRET`: every browser is signed out at once, and the stored TOTP secret can no longer be read, so run the recovery command and set up TOTP again.
3. If the owner token may have leaked, generate a new one, set `MIKUD_OWNER_TOKEN` in `.env` and run `docker compose up -d`.
4. If the agent token may have leaked, replace `MIKUD_AGENT_TOKEN` the same way and update it in the agents' environment and the reconciler's env file.

## 9. Upgrade

1. Read the release notes of the new version on the repository's Releases page.
2. Back up the Mikud database with your own tools. Migrations only move forward; the backup is the way back.
3. Set `VERSION` in `.env` to the new version.
4. Run:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps   # healthy again
   ```

5. Check `/healthz` (step 4) and open the board.

To go back to an earlier version, restore the backup from step 2, set the earlier `VERSION`, start it, and follow "Recovery and after any restore" (step 8).
