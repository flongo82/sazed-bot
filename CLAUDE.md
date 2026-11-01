# sazed-bot

La porta sempre aperta di sazed su Cloudflare Workers. Riceve i messaggi del bot (webhook),
li custodisce in una coda persistente (Durable Object con SQLite) e li consegna via WebSocket
a `sazed-agent`, la mente che gira sul computer dell'utente.
Architettura, sicurezza, protocollo e passi di installazione sono in `README.md`, in inglese
perché chiunque possa riprodurre il progetto.

## Struttura

- `worker/src/index.js`: tutto il codice (Worker + classe Durable Object `Inbox`)
- `worker/src/messages.js`: tutti i testi rivolti all'utente, uno per lingua (italiano e inglese)
- `worker/wrangler.example.jsonc`: modello di configurazione, pubblico e senza dati personali
- `worker/wrangler.jsonc`: configurazione personale (nome del Worker e del bot), generata da
  `scripts/configure.sh` ed esclusa da git
- `worker/test/e2e.mjs`: test end-to-end con `wrangler dev` e un finto server Telegram
- `scripts/`: Node in locale, configurazione, segreti, registrazione del webhook
- `env.sh`: tiene Node, cache npm e login di wrangler dentro la cartella del repository

## Comandi

```bash
source env.sh                      # sempre, in ogni terminale (se Node manca: scripts/install-node.sh)
cd worker && npm install
npm test                           # ~1 minuto, non richiede internet né account Cloudflare
npx wrangler deploy --dry-run      # verifica bundle e configurazione (serve wrangler.jsonc)
npx wrangler deploy                # pubblica: solo sul computer dell'utente, richiede il login
npx wrangler tail                  # log in tempo reale del Worker pubblicato
```

## Regole

- Il protocollo WebSocket descritto nel README è un contratto con `sazed-agent`.
  Se lo modifichi, aggiorna il README e segnala che va aggiornato anche l'altro repository.
- Un messaggio va scritto nella coda PRIMA di rispondere 200 a Telegram, ed esce dalla coda
  solo con l'ack dell'agente: non cambiare quest'ordine, è ciò che garantisce di non perdere nulla.
- Il repository è pubblico: niente che permetta di raggiungere un'istanza (nome del Worker,
  indirizzo, sottodominio, username del bot, ID utente, ID dell'account Cloudflare) nei file
  tracciati, nei test o nei commit. I valori dell'istanza stanno in `worker/wrangler.jsonc` e
  in `secrets/`. Il nome dell'autore in licenza e commit invece è voluto.
- Niente valori fissi nel codice: ciò che può cambiare da un'istanza all'altra viene dalla
  configurazione, dai segreti o da Telegram.
- Superficie d'attacco minima: ogni richiesta non autenticata riceve lo stesso 404 vuoto e
  non tocca il Durable Object; senza `ALLOWED_USER_ID` il Worker non accetta nessuno; solo
  chat private. Niente percorsi pubblici nuovi (né `/health` né simili).
- Ogni nuovo comportamento richiede un nuovo controllo in `worker/test/e2e.mjs`, e
  `npm test` deve passare prima di dichiarare finito un lavoro.
- Segreti (TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, AGENT_TOKEN, ALLOWED_USER_ID) solo con
  `npx wrangler secret put`: mai in `wrangler.jsonc`, nei test o nei commit. Negli script i
  token passano a curl da stdin (`-K -`), mai come argomenti.
- README e messaggi degli script in inglese. I testi del bot stanno solo in
  `worker/src/messages.js`, in italiano e inglese con le stesse chiavi: mai una frase per
  l'utente scritta direttamente nel codice. La lingua si sceglie con `LANGUAGE` ("auto",
  "it", "en"); ogni testo nuovo va in tutte le lingue, con il suo controllo nei test.
- Il nome dell'utente arriva da Telegram (`first_name`) a ogni messaggio: mai scritto nel
  codice o nella configurazione pubblica; nei test si usano nomi finti.
- Restare nel piano gratuito di Cloudflare: niente servizi a pagamento senza chiedere.
- Gli ambienti nel cloud non raggiungono l'API di Cloudflare né Telegram: deploy e prove
  reali si fanno sul computer dell'utente. Il test locale invece funziona ovunque.
