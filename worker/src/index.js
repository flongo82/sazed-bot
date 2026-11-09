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
// viene spinto subito; altrimenti resta in coda e l'utente riceve un avviso, che il Worker
// toglie dalla chat quando l'agente prende in carico il messaggio.
// Un elemento esce dalla coda solo quando l'agente conferma di averlo registrato al sicuro (ack).
// Gli elementi partono verso l'agente da una sola strada (Inbox.pump): dopo il suo hello, in
// ordine di arrivo, con al massimo AGENT_WINDOW elementi in attesa di ack.
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
  const query = update.callback_query;
  const from = msg?.from ?? query?.from;
  if (!from || typeof update.update_id !== "number") {
    return new Response("ok"); // tipo di aggiornamento che non ci interessa
  }
  // La chat dell'aggiornamento; per un pulsante, quella del messaggio del bot che lo porta. Un
  // pulsante di un messaggio inline non ha una chat da verificare, e non passa.
  const chat = msg ? msg.chat : query?.message?.chat;

  // Solo l'utente autorizzato, e solo in chat privata con il bot: in un gruppo le risposte
  // finirebbero sotto gli occhi di altri. Senza ALLOWED_USER_ID non passa nessuno.
  // Chiunque altro viene ignorato in silenzio, senza toccare la coda.
  const allowed = (env.ALLOWED_USER_ID ?? "").trim();
  if (!allowed || String(from.id) !== allowed || chat?.type !== "private") {
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
    }, (sent) => inbox.noticeSent(update.update_id, msg.chat.id, sent.message_id));
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
// non diventa un 500: Telegram non ripete l'aggiornamento per una risposta mancata. Con sent,
// a risposta inviata le passa il messaggio del bot (per l'avviso: il suo message_id).
function notify(ctx, env, msg, compose, sent = null) {
  ctx.waitUntil((async () => {
    const data = await reply(env, msg, compose());
    if (data.ok && sent) await sent(data.result);
  })().catch((err) => console.error("risposta non inviata", err?.stack ?? err)));
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

// Toglie dalla chat un avviso del Worker. Telegram lo permette entro 48 ore: dopo, o se
// l'utente l'ha già cancellato, l'avviso resta e l'errore finisce solo nei log.
async function deleteNotice(env, chatId, messageId) {
  await telegram(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function reply(env, msg, text) {
  return telegram(env, "sendMessage", {
    chat_id: msg.chat.id,
    text,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });
}

const TELEGRAM_TIMEOUT_MS = 10_000;

// Ogni esito torna come risposta di Telegram ({ ok, ... }), anche rete assente e timeout: chi
// chiama decide che cosa è un errore. La descrizione non riporta mai l'indirizzo, che contiene
// il token.
async function telegram(env, method, body) {
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  let data;
  try {
    const res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  } catch (err) {
    data = { ok: false, description: err?.name === "TimeoutError" ? "timeout" : "Telegram non raggiungibile" };
  }
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
  const expected = `${url.origin}/telegram`;
  const webhook = await telegram(env, "setWebhook", {
    url: expected,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "edited_message", "callback_query"],
    max_connections: 10,
  });
  const commands = await registerCommands(env);
  const info = await telegram(env, "getWebhookInfo", {});
  // Conta il webhook, verificato con getWebhookInfo: senza, il bot non riceve nulla. Il menu
  // dei comandi è secondario e viene solo segnalato.
  const ok = Boolean(webhook.ok && info.ok && info.result?.url === expected);
  return Response.json(
    { ok, commands: commands.every((r) => r.ok), setWebhook: webhook, setMyCommands: commands, webhookInfo: info },
    { status: ok ? 200 : 502 });
}

// I comandi del menu (stato e bilancio), con nomi e descrizioni nella lingua dell'utente. Con LANGUAGE
// "auto" una versione per lingua (Telegram mostra quella dell'app dell'utente, l'inglese per
// tutte le altre); con una lingua fissa solo quella, togliendo le versioni per lingua
// registrate in precedenza.
async function registerCommands(env) {
  const setting = languageSetting(env);
  const auto = setting === "auto";
  const base = auto ? MESSAGES.en : MESSAGES[setting] ?? MESSAGES.en;
  const results = [await telegram(env, "setMyCommands", { commands: menu(base) })];
  for (const [code, t] of Object.entries(MESSAGES)) {
    results.push(auto
      ? await telegram(env, "setMyCommands", { commands: menu(t), language_code: code })
      : await telegram(env, "deleteMyCommands", { language_code: code }));
  }
  return results;
}

function menu(t) {
  return [
    { command: t.statusCommand, description: t.statusDescription },
    { command: t.balanceCommand, description: t.balanceDescription },
  ];
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
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id       INTEGER NOT NULL UNIQUE,
        received_at     INTEGER NOT NULL,
        payload         TEXT    NOT NULL,
        status_deadline INTEGER,
        notice_chat     INTEGER,
        notice_id       INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // status_deadline: per un comando di stato passato all'agente, quando risponde il Worker se
    // l'agente non lo ha confermato; vuoto per tutto il resto. notice_chat e notice_id: l'avviso
    // "agente non collegato" mandato per questo messaggio, da togliere all'ack. Le code di prima
    // non hanno queste colonne.
    const columns = this.sql.exec("PRAGMA table_info(queue)").toArray().map((c) => c.name);
    for (const column of ["status_deadline", "notice_chat", "notice_id"]) {
      if (!columns.includes(column)) this.sql.exec(`ALTER TABLE queue ADD COLUMN ${column} INTEGER`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS queue_status_deadline ON queue (status_deadline)
                   WHERE status_deadline IS NOT NULL`);
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

  // La connessione corrente dell'agente: quella con il numero di sessione più recente. Le
  // altre sono state sostituite, e possono restare per un po' tra quelle in chiusura.
  currentSocket() {
    const session = this.currentSession();
    return this.ctx.getWebSockets().find((ws) => ws.deserializeAttachment()?.session === session) ?? null;
  }

  currentSession() {
    return Number(this.getMeta("session") ?? 0);
  }

  isAgentOnline() {
    const ws = this.currentSocket();
    return ws !== null && Date.now() - this.lastActivity(ws) < this.timeoutMs();
  }

  windowSize() {
    const n = Number(this.env.AGENT_WINDOW);
    return Number.isInteger(n) && n > 0 ? n : 50;
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
      const deadline = statusGrace ? Date.now() + this.statusGraceMs() : null;
      this.sql.exec(
        "INSERT INTO queue (update_id, received_at, payload, status_deadline) VALUES (?, ?, ?, ?)",
        update.update_id, Date.now(), payload, deadline
      );
      // Parte subito se l'agente è pronto e ha posto nella finestra, anche se la connessione
      // sembra inattiva; altrimenti partirà dopo i precedenti. Intanto resta comunque in coda.
      const ws = this.currentSocket();
      if (ws) this.pump(ws);
      if (deadline !== null) await this.scheduleAlarm(deadline);
    }
    return { added, agentOnline, lastSeen: this.lastSeenAt(), pending: this.pendingCount() };
  }

  // L'unica strada da cui gli elementi partono verso l'agente: dopo il suo hello, in ordine di
  // arrivo, con al massimo windowSize() elementi in attesa di ack. Il cursore (l'ultimo id
  // inviato) sta nell'allegato della connessione, che sopravvive all'ibernazione; ogni ack fa
  // posto al successivo. Finito l'arretrato, backlog_end una volta sola.
  pump(ws) {
    const att = ws.deserializeAttachment() ?? {};
    if (!att.ready) return;
    let cursor = att.cursor ?? 0;
    let caughtUp = att.caughtUp ?? false;
    try {
      const inFlight = this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE id <= ?", cursor).one().n;
      const room = this.windowSize() - inFlight;
      if (room > 0) {
        const rows = this.sql.exec("SELECT id, payload FROM queue WHERE id > ? ORDER BY id LIMIT ?", cursor, room);
        for (const row of rows) {
          ws.send(`{"type":"update","id":${row.id},"update":${row.payload}}`);
          cursor = row.id;
        }
      }
      if (!caughtUp && this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE id > ?", cursor).one().n === 0) {
        ws.send(JSON.stringify({ type: "backlog_end", pending: this.pendingCount() }));
        caughtUp = true;
      }
    } catch (err) {
      console.warn("invio all'agente non riuscito, gli elementi restano in coda:", err?.message ?? err);
    }
    ws.serializeAttachment({ ...att, cursor, caughtUp });
  }

  // Un solo allarme per oggetto: si anticipa se serve prima, non si posticipa mai.
  async scheduleAlarm(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // Un comando di stato passato all'agente e non confermato entro il tempo previsto riceve la
  // risposta del Worker e lascia la coda: è una domanda, non un contenuto da custodire. Se
  // Telegram non risponde, l'eccezione fa ripetere l'allarme e il comando resta in coda.
  // Si legge un comando scaduto alla volta, e solo quello: la memoria non dipende dalla coda, e
  // dopo ogni attesa di Telegram la coda si rilegge, così un comando confermato nel frattempo
  // dall'agente non riceve la risposta di riserva. Resta un caso: se l'ack arriva proprio mentre
  // parte la risposta a quel comando, rispondono tutti e due (meglio una risposta in più che
  // nessuna). Ogni comando tolto libera un posto nella finestra: alla fine riparte la consegna.
  async alarm() {
    try {
      for (;;) {
        const row = this.sql.exec(
          "SELECT id, payload FROM queue WHERE status_deadline <= ? ORDER BY status_deadline, id LIMIT 1",
          Date.now()
        ).toArray()[0];
        if (!row) break;
        const update = JSON.parse(row.payload);
        const msg = update.message ?? update.edited_message;
        const sent = await reply(this.env, msg, silentStatusText(this.env, msg.from, this.pendingCount() - 1));
        if (!sent.ok) throw new Error(`risposta di riserva non inviata: ${sent.description}`);
        this.sql.exec("DELETE FROM queue WHERE id = ?", row.id);
      }
      const next = this.sql.exec("SELECT MIN(status_deadline) AS at FROM queue").one().at;
      if (next !== null) await this.ctx.storage.setAlarm(next);
    } finally {
      const ws = this.currentSocket();
      if (ws) this.pump(ws);
    }
  }

  // RPC: l'avviso "agente non collegato" mandato per un messaggio in coda. Si annota, per
  // toglierlo dalla chat quando l'agente conferma il messaggio; se l'agente lo ha già
  // confermato mentre l'avviso partiva, si toglie subito.
  async noticeSent(updateId, chatId, messageId) {
    const row = this.sql.exec("SELECT id FROM queue WHERE update_id = ?", updateId).toArray()[0];
    if (row) {
      this.sql.exec("UPDATE queue SET notice_chat = ?, notice_id = ? WHERE id = ?", chatId, messageId, row.id);
    } else {
      await deleteNotice(this.env, chatId, messageId);
    }
  }

  // RPC per /start e il comando di stato.
  async status() {
    return { agentOnline: this.isAgentOnline(), lastSeen: this.lastSeenAt(), pending: this.pendingCount() };
  }

  lastSeenAt() {
    const ws = this.currentSocket();
    const lastSeen = Math.max(Number(this.getMeta("last_seen") ?? 0), ws ? this.lastActivity(ws) : 0);
    return lastSeen || null;
  }

  // L'ultimo contatto va solo avanti: la chiusura tardiva di una connessione vecchia non lo
  // riporta indietro.
  touchLastSeen(ts) {
    if (ts > Number(this.getMeta("last_seen") ?? 0)) this.setMeta("last_seen", ts);
  }

  // Apertura della connessione WebSocket dell'agente (già autenticata dal Worker).
  async fetch(request) {
    // Una sola connessione attiva, con un numero di sessione nuovo: quelle vecchie (magari
    // rimaste appese) vengono chiuse con il codice 4000, e ciò che ne arriva ancora viene
    // ignorato. Un loro ack tardivo non toglie nulla dalla coda: al massimo, un doppione.
    for (const old of this.ctx.getWebSockets()) {
      try { old.close(4000, "sostituita da una nuova connessione"); } catch { /* già chiusa */ }
    }
    const session = this.currentSession() + 1;
    this.setMeta("session", session);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    // ready: l'agente ha mandato hello; cursor: l'ultimo elemento inviato; caughtUp: arretrato finito.
    server.serializeAttachment({ session, connectedAt: now, lastSeen: now, ready: false, cursor: 0, caughtUp: false });
    this.touchLastSeen(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() ?? {};
    if (att.session !== this.currentSession()) return; // connessione sostituita
    const now = Date.now();
    ws.serializeAttachment({ ...att, lastSeen: now });
    this.touchLastSeen(now);

    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (data === null || typeof data !== "object") return;

    if (data.type === "hello") {
      // L'agente è pronto: l'arretrato parte dal primo elemento in coda. Un secondo hello
      // ricomincia da capo, e l'agente scarta ciò che ha già registrato.
      ws.serializeAttachment({ ...att, lastSeen: now, ready: true, cursor: 0, caughtUp: false });
      this.pump(ws);
    } else if (data.type === "ack" && Number.isInteger(data.id)) {
      // Solo ora l'elemento esce dalla coda: l'agente lo ha registrato al sicuro. Con lui se ne
      // va l'avviso mandato all'utente, se c'era: la promessa è mantenuta.
      const notice = this.sql.exec("SELECT notice_chat, notice_id FROM queue WHERE id = ? AND notice_id IS NOT NULL",
        data.id).toArray()[0];
      this.sql.exec("DELETE FROM queue WHERE id = ?", data.id);
      try {
        ws.send(JSON.stringify({ type: "acked", id: data.id, pending: this.pendingCount() }));
      } catch (err) {
        console.warn("conferma all'agente non inviata:", err?.message ?? err);
      }
      this.pump(ws);
      if (notice) await deleteNotice(this.env, notice.notice_chat, notice.notice_id);
    }
  }

  async webSocketClose(ws, code, reason) {
    this.touchLastSeen(this.lastActivity(ws));
    try { ws.close(code, reason); } catch { /* già chiusa */ }
  }

  async webSocketError(ws) {
    this.touchLastSeen(this.lastActivity(ws));
  }
}
