# Deploying Adiutor

Status: written ahead of the launch; nothing here has been run against a production server. The board UI and the Telegram bot are on `main` (rows 7 and 8 of the [foundation plan](project-foundation.md)).

These notes are for the owner, who deploys production himself. Agents never deploy. Replace every example value (`adiutor.example.com`, `db.example.com`, `<...>`) with your own; keep the real values in `.env` on the server and in your private notes, never in the repository.

## What you deploy

- **Image:** `ghcr.io/shlomiporush/adiutor:<version>`, published by the Release workflow. Every release has an immutable version tag (`0.1.0`) and moves `latest`. Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
- **The sync tray** is not deployed to the server: each release also carries its Windows installer, `AdiutorSync-win-Setup.exe`, on the release's GitHub page, and an installed tray updates itself from there ([sync.md](sync.md), "The tray app"). Immutable releases are on in the repository's Settings (Releases, Enable release immutability), so a published installer can never be replaced; keep them on: a release with the tray that GitHub did not make immutable fails.
- **One container:** `docker-compose.yml` runs only `adiutor`. It keeps no files: all state is in your PostgreSQL database. It runs as `node` with no capabilities, no new privileges and a read-only root file system.
- **Migrations** run on every start, before the server listens. There is no separate migration step.
- **Backups** are yours: back up the Adiutor database with your own tools. Adiutor has no backup feature.

## 1. Create the database

1. Generate a password for the database role (hex, so it needs no escaping in a URL):

   ```bash
   openssl rand -hex 24
   ```

2. Adiutor needs PostgreSQL 16 or newer. On your PostgreSQL server, as a superuser, create a role and a database that only Adiutor uses:

   ```sql
   CREATE ROLE adiutor LOGIN PASSWORD '<database password>';
   CREATE DATABASE adiutor OWNER adiutor;
   REVOKE ALL ON DATABASE adiutor FROM PUBLIC;
   ```

   The role owns its database, so the migrations can create their tables. It needs no other rights.

3. In your server's `pg_hba.conf`, allow the role to connect to its database only from where `adiutor` connects (see "Reaching PostgreSQL" below):
   - **PostgreSQL on another host:** the Docker host's address.
   - **PostgreSQL in a container on the same Docker host:** the subnet of the Docker network the two containers share (`docker network inspect <network>`).

4. Write the connection URL for `.env`:

   ```text
   DATABASE_URL=postgres://adiutor:<database password>@db.example.com:5432/adiutor
   ```

   **Reaching PostgreSQL.** The shipped `docker-compose.yml` puts `adiutor` only on the `traefik` network:
   - **PostgreSQL on another host:** use that host's name in the URL and add `?sslmode=verify-full` (or `?sslmode=require` when the server's certificate cannot be verified). Its firewall and `pg_hba.conf` must let the Docker host in.
   - **PostgreSQL in a container on the same Docker host:** use its container name as the host. `adiutor` must share a Docker network with that container: in `docker-compose.yml`, add that network under the service's `networks:` and declare it at the end of the file as `external: true`, next to `traefik`. Allow that network's subnet in `pg_hba.conf` (item 3). Every container on that network can then reach `adiutor:8080` directly too (see section 3, "The client address and the rate limits").

## 2. Write `.env`

1. Copy `docker-compose.yml` and `.env.example` from the release's tag into a deploy directory on the server, and rename the copy to `.env`.
2. Restrict it: `chmod 600 .env`.
3. Generate the keys. Run the command once per key; the server refuses to start when a value is shorter than 32 bytes, looks like an example placeholder, or is shared between two keys:

   ```bash
   openssl rand -hex 32   # ADIUTOR_AUTH_SECRETS, written as 1:<value>
   openssl rand -hex 32   # ADIUTOR_SETTINGS_KEYS, written as 1:<value>
   ```

   Generate the keys and the database password (step 1) new, on the server, with these `openssl rand` commands. Never reuse a value from the development stack's `stack.env` or `.env.dev` in production: the first launch starts with a new, empty database, so nothing needs the development keys.

4. Fill in every value; `.env.example` explains each one:
   - `VERSION`: the release to run, for example `0.1.0`.
   - `DOMAIN`: the host name you open, for example `adiutor.example.com`.
   - `DATABASE_URL`: from step 1.
   - `ADIUTOR_PUBLIC_URL`: exactly the origin the browser's address bar shows: `https://` and `DOMAIN`, plus `:<port>` when the proxy's entry point is not on 443. Any difference makes every browser change fail with 403 (invalid origin), sign-in included. Telegram links use it, agents connect to it (it is the issuer of agent access), and the same value goes into every `--url` of the sync's commands (section 6). Passkeys belong to its host name: a new host name makes every passkey stop working, and you sign in with the password and the authenticator, then add new ones. Write the full value, for example `https://adiutor.example.com`, instead of the example's `https://${DOMAIN}`, and check that the server gets it resolved: `docker compose config` shows the environment the container receives.
   - `ADIUTOR_AUTH_SECRETS`: `1:<value>` from step 3. Better Auth signs the sign-in cookies and encrypts the TOTP secret and the backup codes with it, and the authorization server that agents connect through signs its cookies with keys derived from it (one per version, under a label of their own). To rotate, put a new version first and keep the old one (`2:<new>,1:<old>`): every browser signs in again, the stored TOTP secret stays readable while the old version is listed, and an agent approval under way may have to start again.
   - `ADIUTOR_SETTINGS_KEYS`: `1:<value>` from step 3. It encrypts the secrets you store in Settings (the Telegram bot token), and must differ from the auth secret. Rotate it the same way; a stored value whose version is no longer listed must be entered again in Settings.
   - `ADIUTOR_TRUSTED_PROXIES`: the address (or CIDR range) Traefik uses to reach `adiutor` on the `traefik` network, for example the network's subnet from `docker network inspect traefik`. Better Auth then reads the client address from `X-Forwarded-For` (step 3). Prefer Traefik's own fixed address when you can give it one: the whole subnet trusts every container on that network, and any of them can reach `adiutor:8080` directly and forge `X-Forwarded-For`. That weakens only the per-address rate limits; sign-in and agent approval are still required.
   - Keep backups of `.env` with the database backup: with other keys every browser is signed out, the TOTP secret cannot be read, and the stored bot token must be entered again.

   Everything else you manage in Adiutor itself, in Settings: the Telegram bot token and chat id, sending sign-in codes to Telegram, the private domains of the secret check, the connected agents and how long a browser stays signed in. `ADIUTOR_TELEGRAM_BOT_TOKEN`, `ADIUTOR_TELEGRAM_CHAT_ID` and `ADIUTOR_PRIVATE_DOMAINS` may still be set here: each then overrides its field, and Settings shows that field locked. Leave `TELEGRAM_API_URL` empty. Never set a `BETTER_AUTH_*` variable: the server refuses to start with one, because Better Auth would read it on its own. It refuses `ADIUTOR_AUTH_SECRET` too, even empty: that variable is no longer used, and `ADIUTOR_AUTH_SECRETS` holds the auth keys.

`ADIUTOR_OAUTH_SECRETS` is no longer read: 0.2.0 required it, and from 0.2.1 on the agents' cookie keys come from `ADIUTOR_AUTH_SECRETS`. If your `.env` has an `ADIUTOR_OAUTH_SECRETS` line, delete it; until you do, the server only logs a warning at start.

## 3. Fit the network

Adiutor must be reachable only over your NetBird network. The shipped `docker-compose.yml` puts it behind Traefik on the external Docker network `traefik`, publishes no port, and asks Traefik for one router:

| Label                                              | Shipped value  | Change it to                                                                           |
| -------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `traefik.docker.network` and the `networks:` entry | `traefik`      | The Docker network your reverse proxy uses                                             |
| `traefik.http.routers.adiutor.entrypoints`         | `https`        | Your proxy's entry point that only NetBird can reach                                   |
| `traefik.http.routers.adiutor.middlewares`         | `default@file` | Your middleware chain (headers, and an allow list of NetBird addresses if you use one) |
| `traefik.http.routers.adiutor.tls`                 | `true`         | Add `traefik.http.routers.adiutor.tls.certresolver=<resolver>` if your proxy needs it  |

1. Put a NetBird private service in front of the proxy: a NetBird network resource (or route) for the proxy host, with an access policy that allows only your own peers.
2. Make `DOMAIN` resolve only inside NetBird, for example with a NetBird DNS zone or a private DNS record that points at the proxy's NetBird address.
3. Bind the proxy's entry point for Adiutor to the NetBird interface, or firewall it so that only the NetBird interface reaches it. Never publish the `adiutor` container's port on a public interface.
4. Serve HTTPS with a certificate the browsers trust; for a private name, a DNS challenge or your own CA works. With an `https://` public URL the sign-in cookies are `Secure`, so plain HTTP does not work in production.
5. With a reverse proxy other than Traefik: remove the `labels:`, attach `adiutor` to the proxy's Docker network and proxy `https://adiutor.example.com` to `http://adiutor:8080`. Pass the `Origin` header through unchanged.

**The client address and the rate limits.** Better Auth limits sign-up, sign-in, the two-factor codes and the password change to 5 attempts per 5 minutes per client address. Behind Traefik it takes that address from `X-Forwarded-For`, skipping the proxies in `ADIUTOR_TRUSTED_PROXIES`. That is safe only under two conditions, which the shipped setup meets; keep them:

- Adiutor is reachable only through Traefik: the Compose file publishes no port, and `adiutor` is only on the `traefik` network. A database network added in step 1 lets that network's containers reach `adiutor` directly as well.
- Traefik replaces the forwarding headers clients send: do not set `forwardedHeaders.insecure` or `forwardedHeaders.trustedIPs` on the entry point Adiutor uses.

Without `ADIUTOR_TRUSTED_PROXIES`, every request shares one bucket, which fails safe for one owner. Two-factor also locks sign-in for 15 minutes after 10 wrong codes. Adiutor's own limits for agents (invalid tokens, registrations, device codes, token requests and the codes typed on the code page) count per client address too: `X-Forwarded-For` counts only when the connection comes from a proxy in `ADIUTOR_TRUSTED_PROXIES`, and otherwise the connection's address does. Without the setting, every agent and the sync behind Traefik share each count; the owner's browser is never limited by them.

**Check that Traefik replaces the forwarding headers.** The authorization server for agents builds its addresses from the request's host and scheme, which behind Traefik come from `X-Forwarded-Host` and `X-Forwarded-Proto`; Adiutor refuses a request for another host than `ADIUTOR_PUBLIC_URL` with `421`. Traefik must therefore set those headers itself and drop what a client sends. Check it once agents are on (Settings, Agent access; they stay on when you upgrade), from a device on NetBird, with forged headers:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-Host: forged.example' -H 'X-Forwarded-Proto: http' \
  https://adiutor.example.com/.well-known/oauth-authorization-server
```

`200` means Traefik replaced both headers. `421` means a client's forwarding headers reach Adiutor: remove `forwardedHeaders.insecure` and `forwardedHeaders.trustedIPs` from the entry point Adiutor uses, and check again. `404` means agents are off, or `ADIUTOR_PUBLIC_URL` is not an address agents may use (Settings, Agent access says why).

## 4. Start and check

1. The image is public, like the repository: the Release workflow links the `adiutor` package on GHCR to this repository, and the server pulls it without logging in. If the first `docker compose pull` answers `denied` or `unauthorized`, the package was created private: set it to Public once, in the package's settings on GitHub (Package settings, Change visibility), and pull again.

2. In the deploy directory:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps          # adiutor: running (healthy) after up to 30 seconds
   docker compose logs adiutor  # Adiutor <version> listening, with the port
   ```

   The migrations run before that line, which is the only one the server logs at start; there is no line of their own. A failed migration logs `Database migration failed` and the server exits instead of listening.

   Create your account (section 5) right after the container is healthy: until then, anyone on the private network who opens the address could create the owner account.

3. From a device on NetBird:

   ```bash
   curl -fsS https://adiutor.example.com/healthz
   # {"status":"ok","database":"ok"}
   ```

4. From a device outside NetBird (a phone on mobile data with NetBird off), check that the same URL does not answer.

`/healthz` answers 503 with `"database":"down"` when PostgreSQL does not answer; Docker then marks the container unhealthy.

## 5. Create your account and sign in

The browser signs in with a username, a password and a code from an authenticator app (TOTP). There is one account, yours.

1. Open `https://adiutor.example.com` on the desktop. On a new database it shows the setup: choose a username (3 to 30 letters, digits, underscores or dots; a dot cannot be first, last or next to another dot) and a password of at least 12 characters.
2. Set up two-factor authentication right away; it is required. Scan the QR code with an authenticator app such as 1Password, Aegis or Google Authenticator, or type the key shown under it, then enter the code the app shows.
3. Save the 10 backup codes the setup shows next (Copy or Download), somewhere apart from this device. They are shown only once. Each signs in once without the authenticator; the Account page (the account menu, Account) makes new ones.
4. On the phone, with NetBird connected, open the same URL and sign in with the username, the password and a code. Optionally, add a passkey on the Account page (Passkeys, Add a passkey). It signs in on its own with your fingerprint, face or device PIN, without the password or the code; the password and the authenticator keep working. It works only on the host name of `ADIUTOR_PUBLIC_URL`, over HTTPS.
5. A browser stays signed in while you open Adiutor there at least once every 30 days. Settings, General changes that length (1 to 90 days); a shorter value does not shorten browsers signed in already, so choose "Sign out everywhere" after shortening it. The Account page (the account menu, Account) lists the signed-in browsers, changes the password, signs this browser out, signs the others out, signs out everywhere, makes new backup codes, and sets up a new authenticator.
6. Telegram links open the item after you sign in, when the browser is not signed in.
7. Before you enter the real bot token in production, stop the development stack (`scripts/local.sh down` in the Adiutor checkout in WSL) and make sure its Settings, Telegram hold no real bot token. Two stacks with one bot take each other's updates, and both send the morning message.
8. Settings, Telegram: enter the bot token from BotFather and your chat id (the number of your own chat with the bot), then save. The bot and the morning message start at once, without a restart. "Send sign-in codes to Telegram" is off by default; turned on, it makes your Telegram chat another way in.

## 6. Connect the agents and the sync

Agents and the sync connect by approval: each asks once, you approve it in the browser, signed in, on the code page and the approval page, and choose its areas (read, write, and for the sync the sync area). Settings, Agent access shows how to connect with your address, lists every connection with its areas and last use, and disconnects one or all at once. It also holds the switch that lets agents connect, off on a new installation (an installation upgraded from a release with agent keys keeps agents on), and the idle days after which an unused connection ends (90 by default). No token or key is ever shown or printed.

- **An agent that runs commands** (Claude Code, Codex): tell it the sentence from Settings, Agent access: "Install the adiutor skill into your personal skills folder as described at https://adiutor.example.com/agents/skill/, then connect to Adiutor." It installs the skill from Adiutor, then shows a link and a code; open the link, check that the code matches, and approve. A skill installed from the repository (the shared agent configuration) connects with `adiutor connect --url "https://adiutor.example.com"` instead. The connection belongs to your computer user and is shared by every agent there.
- **Claude Code and Codex over MCP:** in the Adiutor checkout on your PC, `node dist/sync/adiutor-sync.js setup-mcp --for claude --url "https://adiutor.example.com"` (or `--for codex`). It sets the client up for `https://adiutor.example.com/mcp` with OAuth and replaces an older setup that used an agent key; the client then opens Adiutor for you to approve it. For Claude Code alone, `claude mcp add --transport http adiutor "https://adiutor.example.com/mcp"` does the same for a new setup. [sync.md](sync.md), "Setting up Claude Code and Codex", has the details.
- **The sync:** in the Adiutor checkout on your PC, `node dist/sync/adiutor-sync.js connect --name "sync" --url "https://adiutor.example.com"`, and keep the sync area ticked when you approve. It writes `ADIUTOR_URL` into `%LOCALAPPDATA%\adiutor\sync.env` and keeps its connection in a folder of its own, restricted to your Windows user. Then connect it to T3 with `node dist/sync/adiutor-sync.js t3-connect` and run it with `node dist/sync/adiutor-sync.js run` (see [sync.md](sync.md)); after its first run, the sync card in Adiutor shows the time of the last sync.
- Always pass `--url` with the value of `ADIUTOR_PUBLIC_URL`. Without it, the sync falls back to `ADIUTOR_URL` from the environment or an existing env file, which may still point at the development stack.
- A connection ends for good when you disconnect it, turn agents off, leave it unused for the idle days, change the password, reset it with the recovery command, turn two-factor off, or change `ADIUTOR_PUBLIC_URL`. The agent then says it is disconnected; connect it again the same way (the sync: add `--replace`). When the sync has no connection, the morning message and the sync card say that it is disconnected and must be connected again. [agent-instruction.md](agent-instruction.md) has the instruction text for the agents.

## 7. Move from the dry run to production (once)

**Not needed for the first launch.** The first launch starts production with a new, empty database (requirements section 9, owner's decision of 2026-11-12), so skip the numbered move below; it stays for moving a development database to production later. The notes on the development stack apply either way.

**Not into PostgreSQL 16.** The development database is PostgreSQL 18, and a PostgreSQL 18 dump is not downward compatible: its restore starts with `SET transaction_timeout`, which PostgreSQL 16 refuses. The move below works only into a production server of PostgreSQL 18 or newer. On PostgreSQL 16 the supported first launch is a new, empty database.

The dry run runs on the development stack on your PC with real data. Move its data once, after you approved the dry run (requirements section 9). Production must not run before step 5: the migrations would create empty tables that the restore cannot overwrite.

**Keys of the development stack.** `scripts/local.sh up` or `start` generates the database password and the keys once into `stack.env` in the stack's data directory (default `~/.local/share/adiutor-dev/stack.env`, mode 0600), before PostgreSQL first starts, and never rewrites it. Keep that file with the database: without it the stack refuses to start, because new keys would not open the database. `nuke` deletes both. Keys that an older `.env.dev` already sets keep winning over `stack.env`; leave them there, or move them by hand as whole values with every version listed. Interrupted on its very first start (before any data), a stack can be started over with `nuke` and `start`.

**Values from the old tracked `docker/dev.env` are public.** Before commit 9c6ff7b, the repository tracked `docker/dev.env` with a PostgreSQL password, a connection string that held it, and fixed `ADIUTOR_AUTH_SECRETS` and `ADIUTOR_SETTINGS_KEYS`. The repository is public, so those values are public. They were meant for the development stack only (production's keys are made on the server, step 2), but replace every one that is still in use, in `.env.dev` or anywhere else, and never keep one listed as an older key version afterwards: a listed auth secret still verifies sign-in cookies and the agents' cookies, and a listed settings key still decrypts what Settings stores.

- **When the development data can go** (production holds your real data), the simplest way: delete those lines from `.env.dev`, then `scripts/local.sh nuke` and `scripts/local.sh start`. The stack starts empty with a new password and new keys in `stack.env`; create the account again.
- **To keep the development data,** in one sitting:
  1. In `.env.dev`: set `ADIUTOR_PORT=127.0.0.1:8090` (the port, published on this address only) and `ADIUTOR_PUBLIC_URL=http://127.0.0.1:8090`; in `ADIUTOR_AUTH_SECRETS` and `ADIUTOR_SETTINGS_KEYS` list a new random value first (`openssl rand -hex 32`) under a new version and keep the public one after it, for this sitting only (Adiutor refuses those public values as the first entry, so a stack still on them does not start); give the database role a new password (`ALTER ROLE ... PASSWORD`) and put it in the connection string wherever one is set. Stop the reverse proxy, then `scripts/local.sh start`.
  2. Sign in at `http://127.0.0.1:8090` with the password and the code (a passkey belongs to the usual address). On the Account page set up a new authenticator and make new backup codes. In Settings enter the secrets stored there again (the Telegram bot token, the GitHub App key). In Settings, Agent access choose Disconnect all.
  3. The agents' signing key is stored encrypted with the settings key too, and a new one is made only when none is stored. Clear it, so the next start makes one under the new settings key: `source scripts/lib/common.sh && dev_compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update agent_state set signing_key_enc = null where id = 1"'`.
  4. In `.env.dev`, remove the public versions from both lists and set `ADIUTOR_PORT` and `ADIUTOR_PUBLIC_URL` back as they were. Start the reverse proxy, then `scripts/local.sh start`, sign in at the usual address to check, and connect your agents again.

  Older copies may name these values `MIKUD_AUTH_SECRETS`, `MIKUD_SETTINGS_KEYS`, `POSTGRES_PASSWORD` and `DATABASE_URL` (the product's earlier name): Adiutor no longer reads the `MIKUD_` names, so delete those lines wherever they are.

**Optional overrides in `.env.dev`.** `docker/dev.env.example` lists them. Without a `.env.dev` at the root of the Adiutor checkout in WSL, copy the example there (git ignores it) and restrict it (`chmod 600 .env.dev`). When `.env.dev` exists, never copy over it: add only the lines you need, because keys it holds may be the ones your data is encrypted with. Then enter the Telegram bot token and chat id in Settings, Telegram. Connect your agents and the sync to production only (section 6).

**A reverse proxy in front of the development stack.** The stack publishes its port (`ADIUTOR_PORT`, default 8090) on every interface. Set `ADIUTOR_PUBLIC_URL` in `.env.dev` to the URL the browser opens through the proxy; the access restrictions live in the proxy. Set `ADIUTOR_TRUSTED_PROXIES` only when the proxy replaces the `X-Forwarded-For` header clients send (section 3).

A `docker-compose-dev.yml` copied before these changes is refused: copy `docker/docker-compose-dev.example.yml` again, then `scripts/local.sh start`. `scripts/verify.sh` and `scripts/try-pr.sh` never read `.env.dev`. To check the bot without waiting for 08:00, use Settings, "Send a test morning message": it sends today's message now and does not change the 08:00 send.

1. Do not run the sync (`adiutor-sync.js run`) until step 8.
2. Stop the local application, and keep its database running. The local stack is the only consumer of the Telegram bot; two consumers would take each other's updates. In the Adiutor checkout in WSL:

   ```bash
   source scripts/lib/common.sh
   dev_compose stop adiutor
   ```

3. Dump the development database to a file outside every repository. It holds your real data: keep it private.

   ```bash
   mkdir -p ~/adiutor-move && chmod 700 ~/adiutor-move
   dev_compose exec -T postgres pg_dump -U adiutor -d adiutor -Fc >~/adiutor-move/adiutor.dump
   ```

4. Create the production database (step 1) and write `.env` (step 2) if you have not yet. The database must be empty: if production already started once, drop and create it again.
5. Restore the dump into it from a machine that reaches the production PostgreSQL. Use `pg_restore` from PostgreSQL 18 or newer, because the development database is PostgreSQL 18. The production server must be PostgreSQL 18 or newer too (see above): check its version first.

   ```bash
   read -rs PGPASSWORD && export PGPASSWORD   # the production role's password; stays out of the history
   docker run --rm -i -e PGPASSWORD postgres:18-bookworm \
     pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
     -h db.example.com -U adiutor -d adiutor <~/adiutor-move/adiutor.dump
   unset PGPASSWORD
   ```

   The dump carries everything, including the applied migrations, `job_runs` (so today's morning message is not sent twice) and `telegram_updates` (so no Telegram update is handled twice).

6. Start production and check it (step 4).
7. Sign in with your dry-run account and sign out everywhere (step 8, "After any restore"). Sign-in cookies belong to a host, so the browsers signed in on the PC are not signed in on the production host anyway. Use the dry run's `ADIUTOR_AUTH_SECRETS` and `ADIUTOR_SETTINGS_KEYS` in production's `.env` (or list them after new versions): otherwise the stored TOTP secret, the backup codes and the bot token cannot be read. The backup codes are encrypted with the same key, so they do not help then; see "Lost an auth secret" in step 8.
8. Connect the sync to production (step 6): a connection belongs to the public URL it was approved under, so every connection of the dry run ended when production started under its own address. Then run the sync once and check its result.
9. Connect the agents to production (step 6).
10. Keep the local stack off: `scripts/local.sh down`. Before you ever start it again, remove the bot token in its Settings (or reset its database), so it never polls the real bot.
11. Delete the dump: `rm -r ~/adiutor-move`.

## 8. Recovery and after any restore

**Forgot the password:** on the server, in the deploy directory, run

```bash
docker compose exec adiutor node dist/server/cli.js reset-password
```

Run it with `docker compose exec`, in the running container, never with `docker compose run`: the reset is recorded under the container it runs in, and one from another container cannot be told apart from a leftover.

It runs Better Auth's own password reset: it prints the username and a new random password once, signs out every browser, ends every agent connection (connect the agents and the sync again afterwards, step 6), and records the reset in the activity log (actor "system", source "server command"). Two-factor and passkeys stay: sign in with the new password and the authenticator, a saved backup code or a passkey, then change the password on the Account page. If someone else may hold one of your passkeys, remove it on the Account page and sign out the other browsers. A sign-in that someone started before the reset with your old password and a current code can still finish within 3 minutes (G3); check the browsers list afterwards.

**Lost a device with a passkey:** sign in (with another passkey, or the password and the authenticator), remove that passkey on the Account page, then choose "Sign out other browsers": a sign-in that was already under way with the passkey when you removed it can still finish (the passkey plugin does not read it again).

**Lost the authenticator:** sign in with the password and a saved backup code ("Use a backup code"), then the Account page, "Set up a new authenticator". With the password lost too, run the command above first. Finish the setup right away: until the new authenticator is verified, the password alone can sign in, from any browser, and lead to the setup (G-C in the foundation plan).

**Lost the authenticator and every backup code,** with no passkey, no browser still signed in and sign-in codes to Telegram off: there is no supported way back; only editing the database by hand (G4 in the foundation plan). Keep the backup codes safe, and make new ones when they run low.

**Lost an auth secret.** Better Auth encrypts the TOTP secret and the backup codes with `ADIUTOR_AUTH_SECRETS`. A backup code is therefore no way back when the key that encrypted it is gone: both it and the TOTP secret can be read only with that key. When sign-in codes to Telegram are on and reach you, and the settings key that encrypts the bot token was kept (`ADIUTOR_SETTINGS_KEYS`), there is another way: sign in with the password and a code sent to Telegram ("Send a code to Telegram instead"), then the Account page, "Set up a new authenticator": it turns two-factor off with the password and enrols a new authenticator, with new backup codes; finish it right away, as above. Only when no such sign-in path is available is the way back to put the old key back: list it again in `ADIUTOR_AUTH_SECRETS` under its old version (after a newer one, if you rotated, for example `2:<new>,1:<old>`), and run `docker compose up -d`. So keep every auth secret you ever used with the backup of `.env`, and remove an old version only after you set up the authenticator and made new backup codes under the new one. Without the old key the stored factor cannot be read; Adiutor has no recovery for that beyond editing the database by hand (G4). The same holds for `ADIUTOR_SETTINGS_KEYS` and the stored bot token, which you can simply enter again in Settings.

**After any restore**, whether a dry-run move or a backup: a restored database can hold sign-ins that you ended after the backup was taken, and agent connections and passkeys you removed since. So:

1. Sign in and choose the Account page, "Sign out everywhere", then sign in again. When you cannot sign in, the recovery command above also signs out every browser.
2. Open Settings, Agent access and disconnect every agent you do not recognise or had disconnected (Disconnect all, then connect your own again, is the sure way). On the Account page, remove every passkey you do not recognise or had removed.
3. Open Settings, GitHub: check the installations on the list and the key's fingerprint against the App's page on GitHub. Remove an installation you had removed (and uninstall the App from that account on GitHub), and delete on GitHub every key you no longer use.
4. If `.env` or the backup may have leaked, put a new version first in `ADIUTOR_AUTH_SECRETS` (keep the old one listed so the TOTP secret stays readable; the agents' cookie keys follow it) and run `docker compose up -d`: every browser is signed out. Disconnect all agents and connect them again, and replace the Telegram bot token with BotFather and the GitHub App's key on GitHub (section 11, "Rotate the key").

## 9. Upgrade

1. Read the release notes of the new version on the repository's Releases page.
2. Back up the Adiutor database with your own tools. Migrations only move forward; the backup is the way back.
3. Set `VERSION` in `.env` to the new version.
4. Run the commands below.

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps   # healthy again
   ```

5. Check `/healthz` (step 4) and open the board.

To go back to an earlier version, restore the backup from step 2, set the earlier `VERSION`, start it, and follow "Recovery and after any restore" (step 8).

## 10. The agent access release (once)

The release that switches agents to connect by approval (CHANGELOG, "Agents and the sync connect by approval") ends the agent keys: from it on, Adiutor refuses every agent key before any of its code runs, and no new key can be made. Every agent and the sync connect once again, by approval. Do these steps in this order: a client updated before the server cannot connect to the older server (it stops with `endpoints_unavailable`), and an old client against the new server only stops.

1. **Deploy the server** (section 9). From now on an old skill copy gets `401`, forgets its key and says to connect again, and its old `connect` gets `404` and stops; an old Claude Code or Codex setup with a key gets `401`; the sync stops pushing, and the morning message and the sync card say that the sync is disconnected, with the time of its last good run.
2. **Check the forwarding headers** with the command in section 3 ("Check that Traefik replaces the forwarding headers").
3. **Then update the clients:** move the shared agent configuration to this release's tag (installed skill copies follow releases, not the default branch), and on the PC that runs the sync, pull this release in the Adiutor checkout and build the sync bundle again (`pnpm build:sync`, see [sync.md](sync.md)).
4. **Approve each client once** (section 6): the skill once per computer, Claude Code and Codex with `setup-mcp` (it replaces the setup with the key), and the sync with `connect --replace` if it says a connection is kept, else `connect`.
5. **Clean up:** Settings, Agent access lists the agent keys left over, which no longer work: delete them there (the list goes away in a later release). On the Account page, sign out any session named "adiutor connect (agent approval)" that a cut-off approval of the old command left.

From the deploy until you approve each client again, that client cannot write to Adiutor, and the sync does not run until it is connected again; the board and the morning message keep working.

## 11. GitHub: the server reads security data (once, then as needed)

From the release that moves security data to the server (CHANGELOG, "The server reads GitHub security data itself"), the Adiutor server reads GitHub's security alerts (Dependabot, code scanning, secret scanning) and the open Issues count of each project's repository itself, every hour on the hour. It reads only through your own GitHub App, read only, and only the installations you allow in Settings, GitHub. The sync on your PC no longer collects or sends security data.

**Network.** Production must reach `https://api.github.com` over HTTPS (outbound only). Nothing on GitHub calls Adiutor: the App has no webhook.

### Create the App (once)

1. On GitHub, open your personal account's Settings, Developer settings, GitHub Apps, New GitHub App.
2. Name it (for example "Adiutor reader"), set any homepage URL (the repository's address is fine), and leave "Callback URL" empty. Turn off "Expire user authorization tokens" and "Request user authorization (OAuth) during installation". Under Webhook, clear "Active".
3. Repository permissions, each **Read-only**: Dependabot alerts, Code scanning alerts, Secret scanning alerts, Issues. Metadata becomes read-only by itself. Give no other repository, organization or account permission: Adiutor refuses to read an installation granted anything more.
4. "Where can this GitHub App be installed?": **Any account**, so it can be installed on the organizations too. Adiutor still reads only the installations you add in Settings.
5. Create the App, and note its **App ID** from the App's settings page.
6. Under "Private keys", generate a private key. GitHub downloads a `.pem` file once: keep it in your password manager or secret store, and delete the downloaded file. Never put it in a repository, a chat or an issue.

### Install it and allow the installations

1. On the App's page, Install App: install it on your personal account and on each organization whose repositories Adiutor should read (you must be an owner of the organization). Choose all repositories, or only those of your projects.
2. Each installation's settings page has an address that ends with its id (`.../settings/installations/<id>`); note each id.
3. In Adiutor, Settings, GitHub: enter the App ID, paste the private key's text and save. Adiutor checks the key with GitHub and shows its fingerprint, the same one GitHub shows beside the key on the App's page. Then add each installation by its id.
4. Press Read now, and check the last pull, the projects without a repository, and the projects not covered.

Instead of Settings, `.env` may set `ADIUTOR_GITHUB_APP_ID`, `ADIUTOR_GITHUB_PRIVATE_KEY` (the `.pem`'s text, its line breaks written as `\n`, from your secret store) and `ADIUTOR_GITHUB_INSTALLATIONS` (ids, comma-separated); Settings then shows those fields locked. When the App id or the installations are set there, the server refuses to start without a readable key. If a stored key no longer decrypts (for example after a restore with other `ADIUTOR_SETTINGS_KEYS`) and the server refuses to start for that reason, set `ADIUTOR_GITHUB_PRIVATE_KEY` from your secret store, or remove the GitHub variables from `.env` and paste the key again in Settings.

### Move from the PC to the server (once)

1. **Wait for the release to be published with the tray files.** The image goes up before the tray package: deploy the server only once the GitHub Release of this version is published with its tray assets.
2. **Deploy the server** (section 9). From then on the server has no route for the PC's security data. Until the tray app on your PC updates itself (it does, from the same release), the old sync reports its security part as failed, and after two scheduled runs the tray says the sync did not complete; T3 keeps syncing. If the tray updates before the server is deployed, the old server keeps the counts last sent, which turn stale after 26 hours.
3. **Set up the App** (above). Until then, the board and the morning message say that GitHub is not set up, so a quiet morning never means "nothing was checked".
4. **Retire the old collector** on the PC: remove the scheduled task that ran the `overview` collector, and the overview folder setting in the tray app if it is still there.
5. **Projects without a repository.** A project's repository now comes only from T3 or from you on the project page. Settings, GitHub lists the projects without one; set it on each project's page.

**Rollback.** Going back to an earlier server version brings the old route back, but an updated tray app no longer sends security data: the counts then turn stale until you upgrade again.

### Rotate the key, or remove an installation

- **Rotate:** on the App's page generate a second key, paste it in Settings, GitHub (check that the fingerprint shown is the new one), then delete the old key on GitHub. A key that was ever committed, shown or sent anywhere is public: delete it on GitHub and paste a new one.
- **Remove an installation:** Remove in Settings, GitHub stops reading it at once. Also uninstall the App from that account on GitHub (the account's Settings, Applications, the App, Uninstall): a database restored from before the removal would otherwise read it again.
