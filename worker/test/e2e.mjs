// Test end-to-end del Worker in locale (wrangler dev), con un finto server Telegram.
// Uso: npm test   (dalla cartella worker, dopo "source ../env.sh" e "npm install")
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MESSAGES } from "../src/messages.js";

const LANGS = Object.keys(MESSAGES).sort();
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "test-webhook-secret";
const AGENT_TOKEN = "test-agent-token";
const USER = 42;
const BOT_NAME = "Custode";
const FIRST_NAME = "Ada";

// ---------------------------------------------------------------- finto Telegram
// Risponde come Telegram. I metodi in `failing` falliscono; getWebhookInfo restituisce l'URL
// dell'ultimo setWebhook, oppure `foreignWebhook` per simulare un webhook rimasto altrove.
// Con `replyDelay` sendMessage risponde in ritardo (la chiamata è annotata appena arriva).
// Ogni messaggio del bot ha il suo message_id, annotato con la chiamata (result).
const calls = [];
let botMessageId = 5000;
const failing = new Set();
let webhookUrl = "";
let foreignWebhook = null;
let replyDelay = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    const params = body ? JSON.parse(body) : {};
    const call = { method, body: params };
    calls.push(call);
    res.setHeader("content-type", "application/json");
    if (failing.has(method)) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error_code: 500, description: "errore finto" }));
      return;
    }
    if (method === "setWebhook") webhookUrl = params.url;
    const result = method === "getWebhookInfo" ? { url: foreignWebhook ?? webhookUrl, pending_update_count: 0 }
      : method === "sendMessage" ? { message_id: botMessageId++ } : true;
    call.result = result;
    const answer = () => res.end(JSON.stringify({ ok: true, result }));
    if (method === "sendMessage" && replyDelay) setTimeout(answer, replyDelay);
    else answer();
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ---------------------------------------------------------------- wrangler dev
const persist = mkdtempSync(join(tmpdir(), "sazed-bot-test-"));
let fresh; // archivio nuovo per la fase 4
let delivery; // archivio nuovo per la fase 5
let dev;
let devLog = ""; // uscita di wrangler dev, per cercarvi errori del Worker

async function startWorker(allowedUser, language = "auto", dir = persist) {
  const vars = {
    WEBHOOK_SECRET: SECRET, AGENT_TOKEN, TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    ALLOWED_USER_ID: allowedUser, TELEGRAM_API_BASE: MOCK, AGENT_TIMEOUT_SECONDS: "3", BOT_NAME,
    AGENT_STATUS_GRACE_SECONDS: "1", AGENT_WINDOW: "3",
    LANGUAGE: language,
  };
  // Il modello di configurazione, non quella personale: il test non dipende da configure.sh.
  const args = ["wrangler", "dev", "--config", "wrangler.example.jsonc",
    "--port", String(PORT), "--ip", "127.0.0.1",
    "--persist-to", dir, "--show-interactive-dev-session=false"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  args[0] = "node_modules/wrangler/bin/wrangler.js";
  dev = spawn(process.execPath, args, {
    detached: true, // gruppo di processi a parte, per poterlo chiudere tutto insieme
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      CLOUDFLARE_CF_FETCH_ENABLED: "false", // il test non deve dipendere da internet
    },
  });
  devLog = "";
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/`)).status === 404) return; } catch { /* non ancora pronto */ }
    await sleep(500);
  }
  throw new Error("wrangler dev non è partito:\n" + devLog);
}

async function stopWorker() {
  if (dev.exitCode !== null) return;
  const exited = new Promise((r) => dev.once("exit", r));
  try { process.kill(-dev.pid, "SIGTERM"); } catch { /* già terminato */ }
  await Promise.race([exited, sleep(5000)]);
  try { process.kill(-dev.pid, "SIGKILL"); } catch { /* già terminato */ }
  await sleep(500);
}

// ---------------------------------------------------------------- utilità
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextUpdateId = 1000;
let failures = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) failures++;
}

// lang = lingua dell'app Telegram del mittente (language_code).
function makeUpdate(text, { from = USER, updateId, chat = { id: from, type: "private" }, lang = "it" } = {}) {
  const id = updateId ?? nextUpdateId++;
  const sender = { id: from, first_name: FIRST_NAME, language_code: lang };
  return { update_id: id, message: { message_id: id, date: 0, from: sender, chat, text } };
}

// La pressione di un pulsante: da un messaggio del bot in una chat, o da un messaggio inline.
function makeCallback({ chat = { id: USER, type: "private" }, inline = false } = {}) {
  const id = nextUpdateId++;
  const query = { id: String(id), from: { id: USER, first_name: FIRST_NAME, language_code: "it" },
    chat_instance: "1", data: "riprova" };
  if (inline) query.inline_message_id = "inline-1";
  else query.message = { message_id: id, date: 0, chat, text: "un messaggio del bot" };
  return { update_id: id, callback_query: query };
}

const updatesIn = (ws) => ws.inbox.filter((m) => m.type === "update");

async function setup() {
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Una risposta che non rivela nulla: 404 senza corpo.
async function isBlank404(res) {
  return res.status === 404 && (await res.text()) === "";
}

async function post(update, secret = SECRET) {
  return fetch(`${BASE}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  });
}

async function newCalls(since, wait = 400) {
  await sleep(wait);
  return calls.slice(since);
}

function connectAgent(token = AGENT_TOKEN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`, { headers: { Authorization: `Bearer ${token}` } });
    ws.inbox = [];
    ws.on("message", (m) => {
      const s = m.toString();
      try { ws.inbox.push(JSON.parse(s)); } catch { ws.inbox.push(s); } // "pong" è testo semplice
    });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

// La risposta di riserva del Worker a un comando di stato, tra le chiamate a Telegram.
const fallbackTo = (update, since) => calls.slice(since).filter((c) =>
  c.method === "sendMessage" && c.body.reply_parameters?.message_id === update.message.message_id);

async function waitFor(ws, pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = ws.inbox.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

// ---------------------------------------------------------------- test
try {
  console.log("Fase 0: catalogo dei testi");
  // Ogni lingua ha le stesse chiavi, gli stessi tipi e gli stessi argomenti dell'italiano, e ogni
  // testo esce come stringa piena: una chiave mancante non deve mai arrivare a un utente.
  const shape = (o) => Object.fromEntries(Object.entries(o).sort().map(([k, v]) =>
    [k, typeof v === "function" ? `function/${v.length}` : typeof v === "object" ? shape(v) : typeof v]));
  const texts = (o) => Object.values(o).flatMap((v) =>
    typeof v === "function" ? [v(2, "x")] : typeof v === "object" ? texts(v) : [v]);
  check("il catalogo ha le stesse chiavi, tipi e argomenti in ogni lingua",
    LANGS.every((l) => JSON.stringify(shape(MESSAGES[l])) === JSON.stringify(shape(MESSAGES.it))), LANGS.join(","));
  check("ogni testo di ogni lingua è una stringa piena",
    LANGS.every((l) => texts(MESSAGES[l]).every((s) => typeof s === "string" && s.length > 0 && !s.includes("undefined"))));
  check("i comandi del menu hanno nomi e descrizioni validi per Telegram in ogni lingua, nomi diversi",
    LANGS.every((l) => [["statusCommand", "statusDescription"], ["balanceCommand", "balanceDescription"]]
      .every(([c, d]) => /^[a-z0-9_]{1,32}$/.test(MESSAGES[l][c]) && MESSAGES[l][d].length <= 256) &&
      MESSAGES[l].statusCommand !== MESSAGES[l].balanceCommand));
  const { it, en } = MESSAGES;
  check("saluto senza nome, se Telegram non lo manda", it.hello() === "Ciao" && en.hello() === "Hi");
  check("tempi relativi, singolare e plurale",
    en.ago.minutes(1) === "1 minute ago" && en.ago.minutes(2) === "2 minutes ago" && en.ago.hours(1) === "1 hour ago" &&
    en.ago.days(3) === "3 days ago" && it.ago.minutes(1) === "1 minuto fa" && it.ago.hours(2) === "2 ore fa" &&
    it.ago.days(3) === "3 giorni fa");

  console.log("Fase 1: utente autorizzato");
  await startWorker(String(USER));

  let r = await post(makeUpdate("ciao"), "sbagliato");
  check("segreto del webhook errato → 404 vuoto", await isBlank404(r), r.status);

  const probes = [
    fetch(`${BASE}/`),
    fetch(`${BASE}/health`),
    fetch(`${BASE}/telegram`),
    fetch(`${BASE}/agent`),
    fetch(`${BASE}/setup`, { method: "POST" }),
    fetch(`${BASE}/qualsiasi/percorso`, { method: "POST" }),
  ];
  const blanks = await Promise.all((await Promise.all(probes)).map(isBlank404));
  check("richieste non autenticate, su qualunque percorso → stesso 404 vuoto", blanks.every(Boolean), JSON.stringify(blanks));

  let n = calls.length;
  r = await post(makeUpdate("intruso", { from: 999 }));
  check("utente non autorizzato → ignorato senza risposta", r.status === 200 && (await newCalls(n)).length === 0);

  n = calls.length;
  r = await post(makeUpdate("/stato", { chat: { id: -100123, type: "supergroup" } }));
  check("utente autorizzato ma in un gruppo → ignorato senza risposta", r.status === 200 && (await newCalls(n)).length === 0);

  n = calls.length;
  await post(makeUpdate("/start"));
  let c = await newCalls(n);
  check("/start saluta per nome e si presenta con BOT_NAME",
    c[0]?.body.text.startsWith(`Ciao ${FIRST_NAME}, sono ${BOT_NAME}.`) &&
    c[0]?.body.text.endsWith(`L'agente ${BOT_NAME} non si è mai collegato finora. Messaggi da processare: 0.`),
    c[0]?.body.text);

  n = calls.length;
  const first = makeUpdate("https://example.com/ricetta");
  r = await post(first);
  c = await newCalls(n);
  check("agente scollegato → messaggio in coda e avviso all'utente",
    r.status === 200 && c.length === 1 && c[0].method === "sendMessage" &&
    c[0].body.text === `Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non si è mai collegato finora: ` +
      "ho messo il messaggio in coda e lo elaborerà appena si collega. Messaggi da processare: 1.",
    JSON.stringify(c));
  check("l'avviso è una risposta al messaggio originale",
    c[0]?.body.reply_parameters?.message_id === first.message.message_id);

  n = calls.length;
  r = await post(first);
  check("stesso update ripetuto da Telegram → nessun doppione", r.status === 200 && (await newCalls(n)).length === 0);

  n = calls.length;
  await post(makeUpdate("/stato"));
  c = await newCalls(n);
  check("/stato ad agente mai collegato",
    c[0]?.body.text === `Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non si è mai collegato finora. Messaggi da processare: 1.`,
    c[0]?.body.text);

  n = calls.length;
  await post(makeUpdate("/status"));
  c = await newCalls(n);
  check("/status vale come /stato, anche per un utente italiano",
    c[0]?.body.text === `Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non si è mai collegato finora. Messaggi da processare: 1.`,
    c[0]?.body.text);

  n = calls.length;
  await post(makeUpdate("/stato", { lang: "en" }));
  c = await newCalls(n);
  check("LANGUAGE auto: utente con Telegram in inglese → risposta in inglese",
    c[0]?.body.text === `Hi ${FIRST_NAME}, the ${BOT_NAME} agent has never connected so far. Messages to process: 1.`,
    c[0]?.body.text);

  n = calls.length;
  await post(makeUpdate("/stato", { lang: "xx" })); // un codice che non avrà mai testi
  c = await newCalls(n);
  check("LANGUAGE auto: lingua senza testi → inglese", c[0]?.body.text.startsWith(`Hi ${FIRST_NAME}, the ${BOT_NAME} agent`), c[0]?.body.text);

  try { await connectAgent("sbagliato"); check("agente con token errato → rifiutato", false); }
  catch (e) { check("agente con token errato → rifiutato (404)", e.message === "HTTP 404", e.message); }

  let ws = await connectAgent();
  const pinger = setInterval(() => ws.readyState === 1 && ws.send("ping"), 1000);
  ws.send(JSON.stringify({ type: "hello" }));
  const backlogEnd = await waitFor(ws, (m) => m.type === "backlog_end");
  const backlogItem = ws.inbox.find((m) => m.type === "update");
  check("alla connessione l'agente riceve l'arretrato", backlogEnd?.pending === 1 && backlogItem?.update.update_id === first.update_id);

  n = calls.length;
  const second = makeUpdate("nota: comprare il riso carnaroli");
  await post(second);
  const pushed = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === second.update_id, 1000);
  check("agente collegato → il messaggio arriva subito via WebSocket", Boolean(pushed));
  check("agente collegato → nessun avviso automatico all'utente", (await newCalls(n)).length === 0);

  ws.send(JSON.stringify({ type: "ack", id: backlogItem.id }));
  const acked = await waitFor(ws, (m) => m.type === "acked" && m.id === backlogItem.id);
  check("dopo l'ack l'elemento esce dalla coda", acked?.pending === 1, JSON.stringify(acked));

  // Agente collegato: il comando di stato va a lui come ogni messaggio, e il Worker tace.
  n = calls.length;
  const statusUpdate = makeUpdate("/stato");
  await post(statusUpdate);
  const forwarded = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === statusUpdate.update_id, 1000);
  check("/stato ad agente collegato → passa all'agente, il Worker non risponde",
    Boolean(forwarded) && (await newCalls(n)).length === 0);
  ws.send(JSON.stringify({ type: "ack", id: forwarded.id }));
  await waitFor(ws, (m) => m.type === "acked" && m.id === forwarded.id);
  await sleep(1500); // oltre AGENT_STATUS_GRACE_SECONDS (1 s nel test)
  check("…confermato dall'agente: nessuna risposta di riserva del Worker", (await newCalls(n, 0)).length === 0);

  // Agente collegato che non conferma: passato il tempo previsto risponde il Worker.
  n = calls.length;
  const unanswered = makeUpdate("/status", { lang: "en" });
  await post(unanswered);
  const forwarded2 = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === unanswered.update_id, 1000);
  await sleep(1800);
  c = await newCalls(n, 0);
  check("agente collegato che non conferma /status → passato il tempo previsto risponde il Worker",
    Boolean(forwarded2) && c.length === 1 &&
    c[0].body.text === `Hi ${FIRST_NAME}, the ${BOT_NAME} agent is connected but not responding. Messages to process: 1.` &&
    c[0].body.reply_parameters?.message_id === unanswered.message.message_id,
    JSON.stringify(c));

  clearInterval(pinger);
  ws.close();
  await sleep(3500);
  n = calls.length;
  await post(makeUpdate("/stato"));
  c = await newCalls(n);
  check("/stato dopo la disconnessione",
    c[0]?.body.text.startsWith(`Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non è collegato (ultimo contatto `) &&
    c[0]?.body.text.endsWith("Messaggi da processare: 1."),
    c[0]?.body.text);

  ws = await connectAgent();
  ws.send(JSON.stringify({ type: "hello" }));
  await waitFor(ws, (m) => m.type === "backlog_end");
  const redelivered = ws.inbox.find((m) => m.type === "update" && m.update.update_id === second.update_id);
  check("un elemento non confermato viene riconsegnato alla riconnessione", Boolean(redelivered));
  check("…ma non il comando di stato già risposto dal Worker",
    !ws.inbox.some((m) => m.type === "update" && m.update.update_id === unanswered.update_id));
  ws.send(JSON.stringify({ type: "ack", id: redelivered.id }));
  const acked2 = await waitFor(ws, (m) => m.type === "acked" && m.id === redelivered.id);
  check("coda vuota dopo l'ultimo ack", acked2?.pending === 0, JSON.stringify(acked2));

  // Connessione appesa: aperta ma senza ping da più del timeout (3 s nel test).
  await sleep(3500);
  n = calls.length;
  const third = makeUpdate("https://youtube.com/watch?v=abc");
  await post(third);
  c = await newCalls(n);
  check("connessione appesa → agente considerato scollegato (avviso all'utente)",
    c[0]?.body.text.startsWith(`Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non è collegato (ultimo contatto `) &&
    c[0]?.body.text.includes("ho messo il messaggio in coda"),
    JSON.stringify(c));
  const stillPushed = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === third.update_id, 1000);
  check("…ma il messaggio viene comunque spinto e resta in coda", Boolean(stillPushed));
  ws.close();

  r = await fetch(`${BASE}/setup`, { method: "POST", headers: { Authorization: "Bearer sbagliato" } });
  check("/setup con token errato → 404 vuoto", await isBlank404(r), r.status);
  n = calls.length;
  r = await fetch(`${BASE}/setup`, { method: "POST", headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  c = await newCalls(n, 100);
  const sw = c.find((x) => x.method === "setWebhook");
  check("/setup registra il webhook con URL e segreto giusti",
    r.ok && sw?.body.url === `${BASE}/telegram` && sw?.body.secret_token === SECRET, JSON.stringify(sw));
  // I comandi registrati per una lingua (undefined = la lista di base), come "nome: descrizione | …".
  const listed = (code) => c.find((x) => x.method === "setMyCommands" && x.body.language_code === code)
    ?.body.commands?.map((cmd) => `${cmd.command}: ${cmd.description}`).join(" | ");
  const EN_MENU = "status: Status of the agent and of the messages to process | " +
    "balance: How many messages I processed, how many to retry";
  const perLanguage = c.filter((x) => x.method === "setMyCommands" && x.body.language_code)
    .map((x) => x.body.language_code).sort();
  check("/setup con LANGUAGE auto registra stato e bilancio in ogni lingua del catalogo, inglese come base",
    listed(undefined) === EN_MENU && listed("en") === EN_MENU &&
    listed("it") === "stato: Stato dell'agente e dei messaggi da processare | " +
      "bilancio: Quanti messaggi ho elaborato, quanti sono da riprovare" &&
    perLanguage.join(",") === LANGS.join(","),
    JSON.stringify(c.filter((x) => x.method === "setMyCommands")));

  await stopWorker();

  console.log("Fase 2: ALLOWED_USER_ID non impostato");
  await startWorker("");
  n = calls.length;
  r = await post(makeUpdate("ciao", { from: 7 }));
  check("senza ALLOWED_USER_ID nessuno passa, e nessuna risposta", r.status === 200 && (await newCalls(n)).length === 0);
  n = calls.length;
  r = await fetch(`${BASE}/setup`, { method: "POST", headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  const refused = await r.json().catch(() => ({}));
  check("senza ALLOWED_USER_ID /setup non registra il webhook",
    r.status === 400 && refused.description?.includes("ALLOWED_USER_ID") && (await newCalls(n, 100)).length === 0,
    JSON.stringify(refused));
  await stopWorker();

  // Italiano fisso per un utente con l'app in inglese: la lingua attesa è diversa sia da quella
  // dell'utente sia da quella di ripiego, così un LANGUAGE ignorato non può passare inosservato.
  console.log("Fase 3: riavvio con lo stesso archivio, LANGUAGE fisso in italiano");
  await startWorker(String(USER), "it");
  n = calls.length;
  await post(makeUpdate("/stato", { lang: "en" }));
  c = await newCalls(n);
  check("la coda sopravvive al riavvio e la fase 2 non ha salvato nulla", c[0]?.body.text.endsWith("Messaggi da processare: 1."), c[0]?.body.text);
  check("LANGUAGE fisso prevale sulla lingua dell'app Telegram",
    c[0]?.body.text.startsWith(`Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} non è collegato (ultimo contatto `), c[0]?.body.text);

  n = calls.length;
  r = await fetch(`${BASE}/setup`, { method: "POST", headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  c = await newCalls(n, 100);
  const sets = c.filter((x) => x.method === "setMyCommands");
  const deleted = c.filter((x) => x.method === "deleteMyCommands").map((x) => x.body.language_code).sort();
  check("/setup con LANGUAGE fisso: un solo menu nella lingua scelta, versioni per lingua rimosse",
    r.ok && sets.length === 1 && sets[0].body.language_code === undefined &&
    sets[0].body.commands?.map((x) => x.command).join(",") === "stato,bilancio" &&
    sets[0].body.commands?.[0]?.description === "Stato dell'agente e dei messaggi da processare" &&
    deleted.join(",") === LANGS.join(","),
    JSON.stringify(c));
  await stopWorker();

  console.log("Fase 4: testi inglesi, archivio nuovo");
  fresh = mkdtempSync(join(tmpdir(), "sazed-bot-test-"));
  await startWorker(String(USER), "auto", fresh);
  n = calls.length;
  await post(makeUpdate("/start", { lang: "en" }));
  c = await newCalls(n);
  check("/start in inglese",
    c[0]?.body.text === `Hi ${FIRST_NAME}, I'm ${BOT_NAME}. Send me links, notes, photos, voice messages or documents, ` +
      `or ask me about what you have saved.\n\nThe ${BOT_NAME} agent has never connected so far. Messages to process: 0.`,
    c[0]?.body.text);
  n = calls.length;
  await post(makeUpdate("https://example.com/article", { lang: "en" }));
  c = await newCalls(n);
  check("avviso di coda in inglese",
    c[0]?.body.text === `Hi ${FIRST_NAME}, the ${BOT_NAME} agent has never connected so far: your message is queued ` +
      "and will be processed as soon as it connects. Messages to process: 1.",
    c[0]?.body.text);
  ws = await connectAgent();
  ws.send("ping");
  n = calls.length;
  await post(makeUpdate("/start", { lang: "en" }));
  c = await newCalls(n);
  check("/start in inglese ad agente collegato",
    c[0]?.body.text.endsWith(`\n\nThe ${BOT_NAME} agent is connected. Messages to process: 1.`), c[0]?.body.text);
  ws.close();
  await stopWorker();

  console.log("Fase 5: consegna all'agente, callback e setup, archivio nuovo");
  delivery = mkdtempSync(join(tmpdir(), "sazed-bot-test-"));
  await startWorker(String(USER), "auto", delivery);
  const beforeBacklog = calls.length;
  const backlog = [];
  for (let i = 0; i < 7; i++) {
    backlog.push(makeUpdate(`nota ${i}`));
    await post(backlog[i]);
  }
  ws = await connectAgent();
  ws.send("ping");
  const early = makeUpdate("arrivato dopo la connessione, prima di hello");
  await post(early);
  await sleep(500);
  check("prima di hello l'agente non riceve nulla", updatesIn(ws).length === 0, JSON.stringify(ws.inbox));
  ws.send(JSON.stringify({ type: "hello" }));
  await sleep(500);
  check("dopo hello al massimo AGENT_WINDOW elementi senza ack (3 nel test)",
    updatesIn(ws).length === 3 && !ws.inbox.some((m) => m.type === "backlog_end"),
    JSON.stringify(updatesIn(ws).map((m) => m.update.update_id)));
  const seen = [];
  const confirmed = new Set();
  while (seen.length < 8) {
    const u = await waitFor(ws, (m) => m.type === "update" && !confirmed.has(m.id), 2000);
    if (!u) break;
    confirmed.add(u.id);
    seen.push(u.update.update_id);
    ws.send(JSON.stringify({ type: "ack", id: u.id }));
  }
  const expected = [...backlog, early].map((u) => u.update_id);
  check("ogni ack libera il posto al successivo: tutto l'arretrato, in ordine, una volta sola",
    JSON.stringify(seen) === JSON.stringify(expected) && updatesIn(ws).length === 8,
    JSON.stringify(updatesIn(ws).map((m) => m.update.update_id)));
  const ends = ws.inbox.filter((m) => m.type === "backlog_end");
  const lastIndex = ws.inbox.findIndex((m) => m.type === "update" && m.update.update_id === early.update_id);
  check("backlog_end una volta sola, dopo l'ultimo elemento dell'arretrato",
    ends.length === 1 && ws.inbox.indexOf(ends[0]) > lastIndex, JSON.stringify(ends));
  // L'avviso "agente non collegato" di un messaggio sparisce dalla chat quando l'agente lo conferma.
  const notices = calls.slice(beforeBacklog).filter((x) => x.method === "sendMessage" &&
    backlog.some((u) => x.body.reply_parameters?.message_id === u.message.message_id));
  const deletions = () => calls.slice(beforeBacklog).filter((x) => x.method === "deleteMessage");
  const allGone = await until(() => notices.length === 7 && notices.every((x) => deletions().some((d) =>
    d.body.chat_id === USER && d.body.message_id === x.result.message_id)));
  check("all'ack di ogni messaggio dell'arretrato il suo avviso di agente scollegato sparisce dalla chat",
    allGone && deletions().length === 7, JSON.stringify({ notices: notices.length, deleted: deletions().map((d) => d.body) }));
  const live = makeUpdate("in diretta");
  await post(live);
  check("finito l'arretrato, un messaggio nuovo arriva subito",
    Boolean(await waitFor(ws, (m) => m.type === "update" && m.update.update_id === live.update_id, 1000)));

  for (const frame of ["null", "[]", "42", '"testo"', "{}", '{"type":"ack","id":"1"}']) ws.send(frame);
  const after = makeUpdate("dopo i frame strani");
  await post(after);
  const afterMsg = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === after.update_id, 1000);
  await sleep(1000); // wrangler dev scrive gli errori del Worker con un po' di ritardo
  check("frame che non sono oggetti validi: ignorati senza errori, la connessione continua",
    Boolean(afterMsg) && !/TypeError|Uncaught/.test(devLog), devLog.slice(-800));
  ws.send(JSON.stringify({ type: "ack", id: afterMsg?.id }));
  await waitFor(ws, (m) => m.type === "acked" && m.id === afterMsg?.id);

  const fromGroup = makeCallback({ chat: { id: -100123, type: "supergroup" } });
  const inline = makeCallback({ inline: true });
  const fromPrivate = makeCallback();
  for (const u of [fromGroup, inline, fromPrivate]) await post(u);
  await waitFor(ws, (m) => m.type === "update" && m.update.update_id === fromPrivate.update_id, 1000);
  const delivered = updatesIn(ws).map((m) => m.update.update_id);
  check("callback da un gruppo o da un messaggio inline → ignorato",
    !delivered.includes(fromGroup.update_id) && !delivered.includes(inline.update_id), JSON.stringify(delivered));
  check("callback dalla chat privata → in coda", delivered.includes(fromPrivate.update_id));

  const old = ws;
  const closed = new Promise((resolve) => old.once("close", (code) => resolve(code)));
  ws = await connectAgent();
  check("una nuova connessione chiude la precedente con il codice 4000",
    (await Promise.race([closed, sleep(2000).then(() => null)])) === 4000);
  ws.send(JSON.stringify({ type: "hello" }));
  await waitFor(ws, (m) => m.type === "backlog_end");
  const again = updatesIn(ws).map((m) => m.update.update_id);
  check("la nuova connessione riceve tutto ciò che non era confermato, e solo quello",
    JSON.stringify(again) === JSON.stringify([live.update_id, fromPrivate.update_id]), JSON.stringify(again));

  // Da qui l'agente resta collegato (ping ogni mezzo secondo) e conferma solo quando lo dice il test.
  const keepAlive = setInterval(() => ws.readyState === 1 && ws.send("ping"), 500);
  const ackAll = async () => {
    const open = updatesIn(ws).filter((m) => !ws.inbox.some((a) => a.type === "acked" && a.id === m.id));
    for (const m of open) ws.send(JSON.stringify({ type: "ack", id: m.id }));
    for (const m of open) await waitFor(ws, (a) => a.type === "acked" && a.id === m.id);
  };
  const received = (u) => updatesIn(ws).find((m) => m.update.update_id === u.update_id);
  await ackAll();

  // Finestra piena (3) con un comando di stato non confermato: quando il Worker risponde al
  // posto dell'agente e toglie il comando dalla coda, l'elemento in attesa parte senza altri eventi.
  n = calls.length;
  const stuckStatus = makeUpdate("/stato");
  const inWindow = [makeUpdate("prima"), makeUpdate("seconda")];
  const queued = makeUpdate("in attesa di un posto");
  for (const u of [stuckStatus, ...inWindow, queued]) await post(u);
  await sleep(300);
  const waitedForRoom = !received(queued);
  const freed = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === queued.update_id, 3000);
  check("comando di stato scaduto con la finestra piena: risponde il Worker e l'elemento in attesa parte da solo",
    waitedForRoom && Boolean(freed) && fallbackTo(stuckStatus, n).length === 1,
    JSON.stringify({ waitedForRoom, freed: Boolean(freed), replies: fallbackTo(stuckStatus, n).length }));
  await ackAll();

  // Allarme e ack che si incrociano. Il Worker risponde in ritardo al primo comando; intanto
  // ne arrivano altri due, che scadono mentre aspetta Telegram. L'allarme successivo li trova
  // scaduti entrambi; mentre risponde al primo dei due, l'agente conferma il secondo, che
  // quindi non deve ricevere la risposta di riserva.
  n = calls.length;
  replyDelay = 1500;
  const slowFirst = makeUpdate("/stato");
  await post(slowFirst);
  await until(() => fallbackTo(slowFirst, n).length > 0, 3000);
  const answered = makeUpdate("/stato");
  const confirmedLate = makeUpdate("/stato");
  await post(answered);
  await post(confirmedLate);
  await waitFor(ws, (m) => m.type === "update" && m.update.update_id === confirmedLate.update_id, 1000);
  await until(() => fallbackTo(answered, n).length > 0, 6000);
  ws.send(JSON.stringify({ type: "ack", id: received(confirmedLate)?.id }));
  await waitFor(ws, (m) => m.type === "acked" && m.id === received(confirmedLate)?.id);
  replyDelay = 0;
  await sleep(2500);
  const replies = [slowFirst, answered, confirmedLate].map((u) => fallbackTo(u, n).length);
  check("un comando confermato mentre il Worker risponde a un altro non riceve la risposta di riserva",
    JSON.stringify(replies) === "[1,1,0]", JSON.stringify(replies));
  await ackAll();
  clearInterval(keepAlive);
  ws.close();

  // L'agente si collega e conferma mentre l'avviso sta ancora partendo: il Worker lo toglie appena
  // Telegram gliene dà il message_id.
  await sleep(3500); // agente scollegato (3 s nel test)
  n = calls.length;
  replyDelay = 1500;
  const racing = makeUpdate("https://example.com/di-corsa");
  await post(racing);
  ws = await connectAgent();
  ws.send(JSON.stringify({ type: "hello" }));
  const racingMsg = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === racing.update_id);
  ws.send(JSON.stringify({ type: "ack", id: racingMsg?.id }));
  await waitFor(ws, (m) => m.type === "acked" && m.id === racingMsg?.id);
  const racingNotice = () => calls.slice(n).find((x) => x.method === "sendMessage" &&
    x.body.reply_parameters?.message_id === racing.message.message_id);
  const goneAtOnce = await until(() => calls.slice(n).some((x) => x.method === "deleteMessage" &&
    x.body.message_id === racingNotice()?.result.message_id), 4000);
  replyDelay = 0;
  check("se l'agente conferma mentre l'avviso parte, l'avviso sparisce appena inviato",
    Boolean(racingNotice()) && goneAtOnce, JSON.stringify(calls.slice(n).map((x) => x.method)));
  ws.close();

  // Telegram non cancella (avviso di più di 48 ore, o già cancellato dall'utente): l'ack vale lo stesso.
  await sleep(3500);
  failing.add("deleteMessage");
  const stubborn = makeUpdate("avviso che non si cancella");
  await post(stubborn);
  await sleep(300);
  ws = await connectAgent();
  ws.send(JSON.stringify({ type: "hello" }));
  const stubbornMsg = await waitFor(ws, (m) => m.type === "update" && m.update.update_id === stubborn.update_id);
  ws.send(JSON.stringify({ type: "ack", id: stubbornMsg?.id }));
  const stubbornAck = await waitFor(ws, (m) => m.type === "acked" && m.id === stubbornMsg?.id);
  await sleep(500);
  check("un avviso che Telegram non cancella non ferma l'ack né la coda",
    stubbornAck?.pending === 0 && !/TypeError|Uncaught/.test(devLog), JSON.stringify(stubbornAck));
  failing.clear();
  ws.close();

  failing.add("setWebhook");
  let s = await setup();
  check("/setup con setWebhook rifiutato da Telegram → errore, non un successo",
    s.status === 502 && s.body.ok === false, JSON.stringify(s));
  failing.clear();
  foreignWebhook = "https://altrove.example/telegram";
  s = await setup();
  check("/setup con getWebhookInfo che indica un altro indirizzo → errore",
    s.status === 502 && s.body.ok === false, JSON.stringify(s));
  foreignWebhook = null;
  failing.add("setMyCommands");
  s = await setup();
  check("/setup con il menu non registrato → webhook a posto, menu segnalato",
    s.status === 200 && s.body.ok === true && s.body.commands === false, JSON.stringify(s));
  failing.clear();
  s = await setup();
  check("/setup riuscito: esito complessivo e indirizzo verificato",
    s.status === 200 && s.body.ok === true && s.body.commands === true &&
    s.body.webhookInfo?.result?.url === `${BASE}/telegram`, JSON.stringify(s));
  await stopWorker();

  // Una copia dello script in una cartella senza segreti: anche se il controllo mancasse, non
  // avrebbe token da inviare né un secrets/ vero da toccare.
  const scratch = mkdtempSync(join(tmpdir(), "sazed-bot-script-"));
  mkdirSync(join(scratch, "scripts"));
  copyFileSync("../scripts/set-webhook.sh", join(scratch, "scripts", "set-webhook.sh"));
  const plain = spawnSync("bash", [join(scratch, "scripts", "set-webhook.sh"), "http://127.0.0.1:1"], { encoding: "utf8" });
  rmSync(scratch, { recursive: true, force: true });
  check("set-webhook.sh rifiuta un indirizzo non https, prima di inviare il token",
    plain.status === 1 && plain.stderr.includes("must start with https://"), plain.stderr);
} catch (err) {
  console.error(err);
  failures++;
  if (dev && dev.exitCode === null) await stopWorker();
} finally {
  mock.close();
  rmSync(persist, { recursive: true, force: true });
  if (fresh) rmSync(fresh, { recursive: true, force: true });
  if (delivery) rmSync(delivery, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli superati");
process.exit(failures ? 1 : 0);
