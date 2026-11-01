// Test end-to-end del Worker in locale (wrangler dev), con un finto server Telegram.
// Uso: npm test   (dalla cartella worker, dopo "source ../env.sh" e "npm install")
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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
const calls = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    calls.push({ method, body: body ? JSON.parse(body) : {} });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: method === "getWebhookInfo" ? { url: "x" } : true }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ---------------------------------------------------------------- wrangler dev
const persist = mkdtempSync(join(tmpdir(), "sazed-bot-test-"));
let fresh; // archivio nuovo per la fase 4
let dev;

async function startWorker(allowedUser, language = "auto", dir = persist) {
  const vars = {
    WEBHOOK_SECRET: SECRET, AGENT_TOKEN, TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    ALLOWED_USER_ID: allowedUser, TELEGRAM_API_BASE: MOCK, AGENT_TIMEOUT_SECONDS: "3", BOT_NAME,
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
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/`)).status === 404) return; } catch { /* non ancora pronto */ }
    await sleep(500);
  }
  throw new Error("wrangler dev non è partito:\n" + log);
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
  check("il comando di stato ha un nome e una descrizione validi per Telegram in ogni lingua",
    LANGS.every((l) => /^[a-z0-9_]{1,32}$/.test(MESSAGES[l].statusCommand) &&
      MESSAGES[l].statusDescription.length <= 256));
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

  n = calls.length;
  await post(makeUpdate("/stato"));
  c = await newCalls(n);
  check("/stato ad agente collegato",
    c[0]?.body.text === `Ciao ${FIRST_NAME}, l'agente ${BOT_NAME} è collegato. Messaggi da processare: 1.`,
    c[0]?.body.text);

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
  // Il comando registrato per una lingua (undefined = la lista di base), come "nome: descrizione".
  const listed = (code) => {
    const cmd = c.find((x) => x.method === "setMyCommands" && x.body.language_code === code)?.body.commands?.[0];
    return cmd && `${cmd.command}: ${cmd.description}`;
  };
  const perLanguage = c.filter((x) => x.method === "setMyCommands" && x.body.language_code)
    .map((x) => x.body.language_code).sort();
  check("/setup con LANGUAGE auto registra il comando di stato in ogni lingua del catalogo, inglese come base",
    listed(undefined) === "status: Status of the agent and of the messages to process" &&
    listed("en") === "status: Status of the agent and of the messages to process" &&
    listed("it") === "stato: Stato dell'agente e dei messaggi da processare" &&
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
  check("/setup con LANGUAGE fisso: un solo comando nella lingua scelta, versioni per lingua rimosse",
    r.ok && sets.length === 1 && sets[0].body.language_code === undefined &&
    sets[0].body.commands?.[0]?.command === "stato" &&
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
  await post(makeUpdate("/status", { lang: "en" }));
  c = await newCalls(n);
  check("/status in inglese ad agente collegato",
    c[0]?.body.text === `Hi ${FIRST_NAME}, the ${BOT_NAME} agent is connected. Messages to process: 1.`, c[0]?.body.text);
  ws.close();
  await stopWorker();
} catch (err) {
  console.error(err);
  failures++;
  if (dev && dev.exitCode === null) await stopWorker();
} finally {
  mock.close();
  rmSync(persist, { recursive: true, force: true });
  if (fresh) rmSync(fresh, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} controlli falliti` : "\nTutti i controlli superati");
process.exit(failures ? 1 : 0);
