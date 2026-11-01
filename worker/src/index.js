// sazed-bot — la porta sempre aperta di sazed: riceve i messaggi Telegram e li
// custodisce finché sazed-agent non li ha presi in carico.
//
// Percorsi:
//   POST /telegram  webhook chiamato da Telegram (protetto dal segreto del webhook)
//   GET  /agent     connessione WebSocket permanente di sazed-agent (protetta da AGENT_TOKEN)
//   POST /setup     registra il webhook presso Telegram (protetto da AGENT_TOKEN)
//
// Qualsiasi richiesta non autenticata, su qualunque percorso, riceve lo stesso 404 vuoto:
// dall'esterno il Worker non rivela che cosa sia né quali percorsi esistano.
//
// Ogni messaggio dell'utente autorizzato viene salvato nella coda del Durable Object
// "Inbox" PRIMA di rispondere 200 a Telegram. Se l'agente è collegato il messaggio gli
// viene spinto subito; altrimenti resta in coda e l'utente riceve un avviso.
// Un elemento esce dalla coda solo quando l'agente conferma di averlo registrato al sicuro (ack).
// /start lo gestisce il Worker; il comando di stato anche, ma solo ad agente scollegato: se
// è collegato va a lui come ogni messaggio, e il Worker risponde solo se non lo conferma.
//
// I testi per l'utente stanno in messages.js, uno per lingua (LANGUAGE in wrangler.jsonc).

import { DurableObject } from "cloudflare:workers";
import { MESSAGES } from "./messages.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/telegram" && request.method === "POST") {
        return await handleTelegram(request, env, ctx);
      }
      if (url.pathname === "/agent") {
        return await handleAgent(request, env);
      }
      if (url.pathname === "/setup" && request.method === "POST") {
        return await handleSetup(request, env, url);
      }
      return notFound();
    } catch (err) {
      console.error("errore non gestito", url.pathname, err?.stack ?? err);
      // 500 a Telegram = Telegram riprova la consegna più tardi.
      return new Response(null, { status: 500 });
    }
  },
};

function notFound() {
  return new Response(null, { status: 404 });
}

// ---------------------------------------------------------------- Telegram

async function handleTelegram(request, env, ctx) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.WEBHOOK_SECRET || !safeEqual(secret, env.WEBHOOK_SECRET)) {
    return notFound();
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update.message ?? update.edited_message;
  const from = msg?.from ?? update.callback_query?.from;
  if (!from || typeof update.update_id !== "number") {
    return new Response("ok"); // tipo di aggiornamento che non ci interessa
  }

  // Solo l'utente autorizzato, e solo in chat privata con il bot: in un gruppo le risposte
  // finirebbero sotto gli occhi di altri. Senza ALLOWED_USER_ID non passa nessuno.
  // Chiunque altro viene ignorato in silenzio, senza toccare la coda.
  const allowed = (env.ALLOWED_USER_ID ?? "").trim();
  if (!allowed || String(from.id) !== allowed || (msg && msg.chat?.type !== "private")) {
    return new Response("ok");
  }

  const inbox = getInbox(env);
  const command = commandOf(msg);

  if (command === "/start" || STATUS_COMMANDS.has(command)) {
    const status = await inbox.status();
    // Con l'agente collegato il comando di stato va a lui, che conosce anche il suo registro.
    // Se non lo conferma entro AGENT_STATUS_GRACE_SECONDS, risponde il Worker (vedi alarm()).
    if (command !== "/start" && status.agentOnline) {
      await inbox.enqueue(update, { statusGrace: true });
      return new Response("ok");
    }
    notify(ctx, env, msg, () => {
      const { t, hello, name } = voice(env, from);
      const state = `${agentText(t, status, name)}. ${t.pending(status.pending)}`;
      return command === "/start"
        ? `${hello}, ${t.intro(name)}\n\n${state[0].toUpperCase()}${state.slice(1)}`
        : `${hello}, ${state}`;
    });
    return new Response("ok");
  }

  // Prima la coda, poi i testi: un errore nei testi non deve mai impedire il salvataggio.
  // Se la scrittura fallisce, l'eccezione produce un 500 e Telegram riprova.
  const result = await inbox.enqueue(update);

  if (result.added && !result.agentOnline && msg) {
    notify(ctx, env, msg, () => {
      const { t, hello, name } = voice(env, from);
      return `${hello}, ${agentText(t, result, name)}: ${t.queued}. ${t.pending(result.pending)}`;
    });
  }
  return new Response("ok");
}

// Testi e nomi per chi scrive. Il nome dell'utente arriva da Telegram con ogni messaggio:
// nessun dato personale nel codice.
function voice(env, from) {
  const t = messagesFor(env, from);
  return { t, hello: t.hello(from.first_name), name: env.BOT_NAME || "sazed" };
}

// Risponde in background. Un errore nel comporre o nell'inviare il testo finisce nei log e
// non diventa un 500: Telegram non ripete l'aggiornamento per una risposta mancata.
function notify(ctx, env, msg, compose) {
  ctx.waitUntil((async () => reply(env, msg, compose()))().catch((err) =>
    console.error("risposta non inviata", err?.stack ?? err)));
}

// Lingua dei testi: LANGUAGE = "auto" (quella dell'app Telegram dell'utente), "it" o "en".
// Una lingua senza testi ricade sull'inglese.
function languageSetting(env) {
  return (env.LANGUAGE || "auto").trim().toLowerCase();
}

function messagesFor(env, from) {
  const setting = languageSetting(env);
  const lang = setting === "auto" ? String(from.language_code ?? "").slice(0, 2).toLowerCase() : setting;
  return MESSAGES[lang] ?? MESSAGES.en;
}

// Il comando di stato in ogni lingua del catalogo (/stato, /status), qualunque sia LANGUAGE.
const STATUS_COMMANDS = new Set(Object.values(MESSAGES).map((t) => `/${t.statusCommand}`));

function commandOf(msg) {
  const text = msg?.text ?? "";
  if (!text.startsWith("/")) return null;
  return text.split(/[\s@]/)[0].toLowerCase();
}

// La risposta del Worker a un comando di stato che l'agente collegato non ha confermato.
function silentStatusText(env, from, pending) {
  const { t, hello, name } = voice(env, from);
  return `${hello}, ${t.agentSilent(name)}. ${t.pending(pending)}`;
}

function agentText(t, s, name) {
  return s.agentOnline
    ? t.agentOnline(name)
    : s.lastSeen
      ? t.agentOffline(name, relativeTime(t, s.lastSeen))
      : t.agentNever(name);
}

function relativeTime(t, ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return t.ago.seconds;
  const min = Math.round(sec / 60);
  if (min < 60) return t.ago.minutes(min);
  const h = Math.round(min / 60);
  if (h < 48) return t.ago.hours(h);
  return t.ago.days(Math.round(h / 24));
}

async function reply(env, msg, text) {
  return telegram(env, "sendMessage", {
    chat_id: msg.chat.id,
    text,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });
}

async function telegram(env, method, body) {
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) console.error(`Telegram ${method} fallito:`, data.description);
  return data;
}

// ---------------------------------------------------------------- agente e setup

function bearerOk(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return Boolean(env.AGENT_TOKEN) && safeEqual(token, env.AGENT_TOKEN);
}

async function handleAgent(request, env) {
  if (!bearerOk(request, env)) return notFound();
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  return getInbox(env).fetch(request);
}

async function handleSetup(request, env, url) {
  if (!bearerOk(request, env)) return notFound();
  // Il webhook si registra solo quando il filtro sull'utente è già al suo posto.
  const missing = ["TELEGRAM_BOT_TOKEN", "WEBHOOK_SECRET", "ALLOWED_USER_ID"]
    .filter((k) => !(env[k] ?? "").trim());
  if (missing.length) {
    return Response.json({ ok: false, description: `missing secrets: ${missing.join(", ")}` }, { status: 400 });
  }
  const webhook = await telegram(env, "setWebhook", {
    url: `${url.origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "edited_message", "callback_query"],
    max_connections: 10,
  });
  const commands = await registerCommands(env);
  const info = await telegram(env, "getWebhookInfo", {});
  return Response.json({ setWebhook: webhook, setMyCommands: commands, webhookInfo: info });
}

// Il comando di stato nel menu, con nome e descrizione nella lingua dell'utente. Con LANGUAGE
// "auto" una versione per lingua (Telegram mostra quella dell'app dell'utente, l'inglese per
// tutte le altre); con una lingua fissa solo quella, togliendo le versioni per lingua
// registrate in precedenza.
async function registerCommands(env) {
  const setting = languageSetting(env);
  const auto = setting === "auto";
  const base = auto ? MESSAGES.en : MESSAGES[setting] ?? MESSAGES.en;
  const results = [await telegram(env, "setMyCommands", {
    commands: [{ command: base.statusCommand, description: base.statusDescription }],
  })];
  for (const [code, t] of Object.entries(MESSAGES)) {
    results.push(auto
      ? await telegram(env, "setMyCommands", {
          commands: [{ command: t.statusCommand, description: t.statusDescription }], language_code: code,
        })
      : await telegram(env, "deleteMyCommands", { language_code: code }));
  }
  return results;
}

// ---------------------------------------------------------------- utilità

function getInbox(env) {
  return env.INBOX.get(env.INBOX.idFromName("main"));
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------- Durable Object

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id   INTEGER NOT NULL UNIQUE,
        received_at INTEGER NOT NULL,
        payload     TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // L'agente manda "ping" ogni ~30 s: la risposta automatica non risveglia
    // l'oggetto e ne registra l'orario, usato per capire se l'agente è vivo.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  timeoutMs() {
    const s = Number(this.env.AGENT_TIMEOUT_SECONDS);
    return (Number.isFinite(s) && s > 0 ? s : 90) * 1000;
  }

  lastActivity(ws) {
    const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const att = ws.deserializeAttachment() ?? {};
    return Math.max(auto, att.lastSeen ?? 0);
  }

  agentSockets() {
    return this.ctx.getWebSockets();
  }

  isAgentOnline() {
    const now = Date.now();
    return this.agentSockets().some((ws) => now - this.lastActivity(ws) < this.timeoutMs());
  }

  pendingCount() {
    return this.sql.exec("SELECT COUNT(*) AS n FROM queue").one().n;
  }

  setMeta(key, value) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, String(value)
    );
  }

  getMeta(key) {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? rows[0].value : null;
  }

  statusGraceMs() {
    const s = Number(this.env.AGENT_STATUS_GRACE_SECONDS);
    return (Number.isFinite(s) && s > 0 ? s : 15) * 1000;
  }

  // RPC chiamato dal Worker per ogni messaggio dell'utente. Con statusGrace (un comando di
  // stato passato all'agente) programma l'allarme che controlla se l'agente lo ha confermato.
  async enqueue(update, { statusGrace = false } = {}) {
    const payload = JSON.stringify(update);
    const agentOnline = this.isAgentOnline();
    // Telegram può riconsegnare lo stesso aggiornamento: in quel caso non facciamo nulla.
    const already = this.sql.exec("SELECT id FROM queue WHERE update_id = ?", update.update_id).toArray();
    const added = already.length === 0;

    if (added) {
      const { id } = this.sql.exec(
        "INSERT INTO queue (update_id, received_at, payload) VALUES (?, ?, ?) RETURNING id",
        update.update_id, Date.now(), payload
      ).one();
      const frame = `{"type":"update","id":${id},"update":${payload}}`;
      // Lo spingiamo a ogni connessione aperta, anche se sembra inattiva:
      // se l'agente è vivo lo riceve subito, altrimenti resta comunque in coda.
      for (const ws of this.agentSockets()) {
        try { ws.send(frame); } catch { /* connessione morta: resta in coda */ }
      }
      if (statusGrace) await this.scheduleAlarm(Date.now() + this.statusGraceMs());
    }
    return { added, agentOnline, lastSeen: this.lastSeenAt(), pending: this.pendingCount() };
  }

  // Un solo allarme per oggetto: si anticipa se serve prima, non si posticipa mai.
  async scheduleAlarm(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // Un comando di stato passato all'agente e non confermato entro il tempo previsto riceve la
  // risposta del Worker e lascia la coda: è una domanda, non un contenuto da custodire. Se
  // Telegram non risponde, l'eccezione fa ripetere l'allarme e il comando resta in coda.
  async alarm() {
    const now = Date.now();
    const grace = this.statusGraceMs();
    let next = null;
    const rows = this.sql.exec("SELECT id, received_at, payload FROM queue ORDER BY id").toArray();
    for (const row of rows) {
      const update = JSON.parse(row.payload);
      const msg = update.message ?? update.edited_message;
      if (!STATUS_COMMANDS.has(commandOf(msg))) continue;
      if (now - row.received_at < grace) {
        next = Math.min(next ?? Infinity, row.received_at + grace);
        continue;
      }
      const sent = await reply(this.env, msg, silentStatusText(this.env, msg.from, this.pendingCount() - 1));
      if (!sent.ok) throw new Error(`risposta di riserva non inviata: ${sent.description}`);
      this.sql.exec("DELETE FROM queue WHERE id = ?", row.id);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // RPC per /start e il comando di stato.
  async status() {
    return { agentOnline: this.isAgentOnline(), lastSeen: this.lastSeenAt(), pending: this.pendingCount() };
  }

  lastSeenAt() {
    let lastSeen = Number(this.getMeta("last_seen") ?? 0);
    for (const ws of this.agentSockets()) lastSeen = Math.max(lastSeen, this.lastActivity(ws));
    return lastSeen || null;
  }

  // Apertura della connessione WebSocket dell'agente (già autenticata dal Worker).
  async fetch(request) {
    // Una sola connessione attiva: quelle vecchie (magari rimaste appese) vengono chiuse.
    for (const old of this.agentSockets()) {
      try { old.close(4000, "sostituita da una nuova connessione"); } catch { /* già chiusa */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({ connectedAt: now, lastSeen: now });
    this.setMeta("last_seen", now);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const now = Date.now();
    ws.serializeAttachment({ ...(ws.deserializeAttachment() ?? {}), lastSeen: now });
    this.setMeta("last_seen", now);

    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (data.type === "hello") {
      // L'agente è pronto: gli mandiamo tutto l'arretrato, in ordine di arrivo.
      const rows = this.sql.exec("SELECT id, payload FROM queue ORDER BY id").toArray();
      for (const row of rows) {
        ws.send(`{"type":"update","id":${row.id},"update":${row.payload}}`);
      }
      ws.send(JSON.stringify({ type: "backlog_end", pending: rows.length }));
    } else if (data.type === "ack" && Number.isInteger(data.id)) {
      // Solo ora l'elemento esce dalla coda: l'agente lo ha registrato al sicuro.
      this.sql.exec("DELETE FROM queue WHERE id = ?", data.id);
      ws.send(JSON.stringify({ type: "acked", id: data.id, pending: this.pendingCount() }));
    }
  }

  async webSocketClose(ws, code, reason) {
    this.setMeta("last_seen", this.lastActivity(ws));
    try { ws.close(code, reason); } catch { /* già chiusa */ }
  }

  async webSocketError(ws) {
    this.setMeta("last_seen", this.lastActivity(ws));
  }
}
