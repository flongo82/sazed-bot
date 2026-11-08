# sazed-bot

The always-open door of **sazed**, a personal knowledge base you feed and query from a
Telegram chat.

This Cloudflare Worker receives every message sent to your bot and keeps it in a persistent
queue until `sazed-agent`, the mind running on your own computer, has taken care of it. If the
agent is connected, the message reaches it at once; if not, the message waits safely in the
queue and the bot tells you so. Nothing leaves the queue until the agent confirms it has made it
its own.

## The project

sazed is a single-user knowledge base that lives in a Telegram chat. You send it links (web
pages, YouTube videos, Instagram reels), notes, photos, voice messages and documents; you ask
it questions in plain language, such as *the recipes I saved about risotto* or *where was I
when I took this photo?*, and the answers come back in the same chat.

| Part | Role | Where it runs |
|---|---|---|
| `sazed-bot` (this repository) | The always-open door: receives the messages and keeps them queued | Cloudflare Workers, free plan |
| [`sazed-agent`](https://github.com/flongo82/sazed-agent) | The mind: reads each message (transcripts, pages, documents, photos), decides whether to keep it, answer it or both, and replies | Your own computer, in a Podman container |
| coppermind | The memory: a SQLite catalogue with full-text and semantic search | Inside `sazed-agent` |

In Brandon Sanderson's *Mistborn*, Sazed is a Terrisman Keeper who stores knowledge in
copperminds: hence the names.

```
phone ──► Telegram ──webhook──► sazed-bot ──WebSocket──► sazed-agent ──► coppermind
                                (Cloudflare,  ◄── ack ──   (your own      (SQLite)
                                 queue)                    computer)
             ▲                                                │
             └──────────────── replies (Bot API) ─────────────┘
```

Why a Worker in front of the agent:

- **The agent may stay offline for days** (a laptop that sleeps, a computer that is switched
  off), but Telegram keeps undelivered messages for 24 hours only. The Worker is always on,
  costs nothing, and holds everything until the agent returns.
- **Answers are immediate when the agent is online**: it keeps a WebSocket open towards the
  Worker, so messages arrive at once, with no polling.
- **Nothing at home is exposed**: the computer running the agent only opens outgoing
  connections.
- **Files never pass through the Worker**: the queue holds their Telegram identifiers, and
  the agent downloads them straight from Telegram.

## Make it yours

sazed is the name of the software, not of your bot. Everything that identifies your instance
is chosen by you and stays out of the repository:

- the bot's display name and username, chosen with @BotFather;
- the name the bot introduces itself with, the language of its messages and the Worker's
  name: `scripts/configure.sh` writes them into `worker/wrangler.jsonc`, which git ignores;
- the secrets, which live only on Cloudflare and in `secrets/`, also ignored by git.

Your own name never appears anywhere: the bot greets you with the first name of your Telegram
profile, which arrives with every message.

The bot speaks Italian and English. `LANGUAGE` is `auto` (the language of your Telegram app,
English for any language without texts), `it` or `en`. All its sentences live in
`worker/src/messages.js`: adding a language means adding one block there, with the same keys;
`configure.sh` and the tests pick it up by themselves.

## Security

A Telegram bot is public by nature: anyone who knows its username can write to it. This is
what keeps strangers out, and what is left to you.

**What the Worker does**

- It listens to one Telegram user only (`ALLOWED_USER_ID`), and only in a private chat: a
  button press counts only if the button belongs to a message in that chat. Anyone else is
  ignored in silence: no reply, nothing queued. Without `ALLOWED_USER_ID`, it ignores everyone.
- Telegram's calls carry a random secret; the agent's connection a random 256-bit token.
- Every request that is not authenticated, on any path, gets the same empty `404`: from the
  outside, the Worker reveals neither what it is nor which paths exist. Such requests never
  reach the queue.
- The webhook can be registered only once every secret, `ALLOWED_USER_ID` included, is in
  place, and your user ID is found before that: the bot never answers anyone else, not even
  during setup. The agent token is sent only to an `https://` address.

**What you should do**

- Keep the Worker's address to yourself: it is the one thing worth hiding. Telegram shows it
  to nobody but the holder of the bot token, so finding the bot does not lead to it.
  `configure.sh` adds a random suffix to the Worker's name; pick a `workers.dev` subdomain
  that does not point to you either.
- In @BotFather, send `/setjoingroups` and choose *Disable*, so that nobody can add your bot
  to a group.
- Name the bot as you like: its username need not be secret, since whoever finds it meets a
  bot that never answers. A username nobody could guess only spares you curious visitors.

**What remains**

- Whoever finds the username can still send messages: they are dropped, at the cost of one
  Worker request each. Telegram limits how fast an account can write, so this is no
  practical way to exhaust the quota below.
- Whoever finds the Worker's address can flood it: every request gets a `404`, but counts
  against the free plan's 100,000 requests a day, reset at midnight UTC. Once the quota is
  spent, Telegram keeps retrying your messages for up to 24 hours: a flood delays them, and
  only one lasting longer than a day could lose them. To guard against it, serve the Worker
  from your own domain on Cloudflare and add a rate limiting rule.
- Messages are not end-to-end encrypted: Telegram sees them, and so does Cloudflare while
  they wait in the queue, until the agent acknowledges them.

## Setup

You need a Telegram account, a free Cloudflare account and a Linux computer. Everything installed
stays inside this folder: Node in `node/`, the libraries in `worker/node_modules/`, the npm
cache in `.npm-cache/`, the Cloudflare login in `.config/`. Deleting the folder uninstalls
everything (plus the Cloudflare and Telegram steps at the bottom).

### 1. Create the bot (from your phone)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Choose a display name, and a username that must end in `bot`.
3. BotFather gives you a **token** like `123456789:AA...`. Keep it to yourself.
4. Send `/setjoingroups`, pick your bot and choose *Disable*.

### 2. Create the Cloudflare account

Sign up for free at <https://dash.cloudflare.com/sign-up> and confirm your email. The free
plan needs no credit card.

### 3. Prepare the folder

```bash
git clone https://github.com/flongo82/sazed-bot.git
cd sazed-bot
scripts/install-node.sh   # official Node.js 24 from nodejs.org into node/, checksum verified
source env.sh
scripts/configure.sh      # your bot's name and language; writes worker/wrangler.jsonc
cd worker
npm install
npm test                  # optional: tries everything locally, in about a minute
```

### 4. Log in to Cloudflare

```bash
npx wrangler login --browser=false
```

Open the link it prints, log in to Cloudflare and authorize wrangler. The authorization is
kept in `.config/`, inside this folder.

### 5. Deploy the Worker

```bash
npx wrangler deploy
```

If it is the first Worker of the account, wrangler may ask you to choose a `workers.dev`
subdomain: pick one that does not point to you. At the end it prints the Worker's address,
`https://<worker-name>.<subdomain>.workers.dev`. Note it down, and keep it private.

### 6. Set the secrets

```bash
../scripts/setup-secrets.sh
```

Paste the bot token when asked: it is neither shown nor saved. The script then asks for your
Telegram user ID: if you don't know it, press Enter, write anything to your bot and confirm
that the sender is you. What you write is not lost: once the webhook is set, it reaches the
agent like any other message. The other two secrets are generated at random; the agent token
is also saved in `secrets/agent_token`, readable only by you, for `sazed-agent`.

Running the script again keeps the agent token, sets a new webhook secret and, once the
Worker's address is known (after step 7), registers the webhook again by itself.

### 7. Connect the bot to the Worker

```bash
../scripts/set-webhook.sh https://<worker-name>.<subdomain>.workers.dev
```

You should see `Webhook registered and checked`: the Worker asks Telegram to deliver to it,
then checks with `getWebhookInfo` that Telegram really does. Any failure ends with an error
and a reason. The address is saved in `secrets/worker_url` only once everything worked.

### 8. Try it

- Send `/stato` (or `/status`, its English name; the bot accepts both): the bot greets you by
  name and tells you whether the agent is connected and how many messages are waiting to be
  processed.
- Send a link: the bot replies that the agent is not connected and the message is queued.
  Once the agent is running and takes the message, that notice disappears from the chat.
- From another Telegram account, the bot must stay silent.

The queued messages will be processed once [`sazed-agent`](https://github.com/flongo82/sazed-agent)
is running: its README explains how to set it up.

## Daily use

- In every new terminal: `cd sazed-bot && source env.sh`
- Live logs of the Worker: `cd worker && npx wrangler tail`
- After changing the code: `cd worker && npm test && npx wrangler deploy`
- After changing the bot's name or language in `worker/wrangler.jsonc`: `npx wrangler deploy`,
  then `../scripts/set-webhook.sh <your Worker's address>` again, which also updates the
  command menu

## Protocol

| Path | Caller | Authentication |
|---|---|---|
| `POST /telegram` | Telegram (webhook) | header `X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>` |
| `GET /agent` (WebSocket) | `sazed-agent` | header `Authorization: Bearer <AGENT_TOKEN>` |
| `POST /setup` | `scripts/set-webhook.sh` | header `Authorization: Bearer <AGENT_TOKEN>` |

Anything else, or the right path with the wrong credentials, gets an empty `404`. `/setup`
answers `{"ok": ..., "commands": ...}` with Telegram's own replies: `200` once the webhook is
registered and checked, `502` if Telegram did not take it, `400` if a secret is missing.

Messages on the WebSocket:

| Direction | Message |
|---|---|
| Agent → Worker | `ping` (plain text, every ~30 s) |
| Agent → Worker | `{"type":"hello"}` right after connecting: nothing is delivered before it |
| Worker → Agent | `{"type":"update","id":N,"update":{...}}` for each message (`update` is Telegram's Update object) |
| Worker → Agent | `{"type":"backlog_end","pending":N}` once, when the whole backlog has been sent; `N` messages still wait for their ack |
| Agent → Worker | `{"type":"ack","id":N}` once the item is safely recorded by the agent |
| Worker → Agent | `{"type":"acked","id":N,"pending":M}` |

- Without a `ping` for 90 seconds (`AGENT_TIMEOUT_SECONDS`), the agent is considered offline.
- Messages leave in order of arrival, backlog first, and at most `AGENT_WINDOW` (50) of them
  wait for an ack at any time: each ack makes room for the next, so a long backlog leaves in
  steps. A message that arrives once the backlog is over leaves at once.
- Only one connection at a time: a new one closes the previous one with code 4000, and whatever
  still arrives from the old one is ignored (at worst, a message is delivered twice; never
  lost). An agent closed with code 4000 must stop instead of reconnecting: another agent has
  taken its place, and two of them would split the messages between two journals.
- The agent acknowledges an item as soon as it has written it to its own durable journal, not
  after processing it: from then on, retries and failures are the agent's business, and a slow
  or broken item never holds up the queue here.
- The "agent not connected" notice the Worker sends for a queued message is deleted from the
  chat when that message is acknowledged (or right after it is sent, if the ack came first). The
  agent knows nothing about it: the Worker keeps the notice's message id next to the queued item.
  Telegram lets bots delete their messages for 48 hours only, so after a longer absence the
  notice stays.
- An item that was not acknowledged is delivered again on the next connection, so the agent
  must skip the `update_id`s it has already recorded.
- `/start` is answered by the Worker itself; everything else goes to the agent.
- The status command (`/stato` in Italian, `/status` in English, both always accepted; its
  name comes from the text catalog) is answered by the Worker only while the agent is offline.
  When the agent is connected, the command is delivered to it like any other message, since
  only the agent knows its own journal. If the agent does not acknowledge it within
  `AGENT_STATUS_GRACE_SECONDS` (15 by default), a Durable Object alarm makes the Worker answer
  by itself ("connected but not responding") and drop the command from the queue; the room it
  frees in the window goes at once to the next message. The alarm reads only the expired
  commands, one at a time, and checks the queue again after each answer, so a command the agent
  acknowledges meanwhile gets no fallback. If the ack lands while the fallback for that very
  command is being sent, the user gets both answers: one too many, never none.

## Uninstall

```bash
cd sazed-bot/worker && npx wrangler delete   # removes the Worker and its queue from Cloudflare
cd ../.. && rm -rf sazed-bot                  # removes everything from your computer
```

To delete the bot, send `/deletebot` to @BotFather.

## License

MIT: see [LICENSE](LICENSE).
