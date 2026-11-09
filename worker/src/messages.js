// Testi del bot, una voce per lingua: nessun testo rivolto all'utente sta nel codice, nemmeno
// i nomi dei comandi del menu (statusCommand e balanceCommand: lettere minuscole, cifre e
// trattini bassi). Al bilancio risponde sempre l'agente: qui stanno solo nome e descrizione,
// uguali a quelli del catalogo di sazed-agent.
// Per aggiungere una lingua basta aggiungere qui un blocco con le stesse chiavi: configure.sh
// e i test la trovano da soli. La lingua si sceglie con LANGUAGE in wrangler.jsonc.

export const MESSAGES = {
  it: {
    hello: (first) => (first ? `Ciao ${first}` : "Ciao"),
    intro: (name) =>
      `sono ${name}. Mandami link, note, foto, vocali o documenti, oppure chiedimi ciò che hai salvato.`,
    agentOnline: (name) => `l'agente ${name} è collegato`,
    agentOffline: (name, when) => `l'agente ${name} non è collegato (ultimo contatto ${when})`,
    agentNever: (name) => `l'agente ${name} non si è mai collegato finora`,
    agentSilent: (name) => `l'agente ${name} è collegato ma non risponde`,
    queued: "ho messo il messaggio in coda e lo elaborerà appena si collega",
    pending: (n) => `Messaggi da processare: ${n}.`,
    ago: {
      seconds: "pochi secondi fa",
      minutes: (n) => `${n} ${n === 1 ? "minuto" : "minuti"} fa`,
      hours: (n) => `${n} ${n === 1 ? "ora" : "ore"} fa`,
      days: (n) => `${n} giorni fa`,
    },
    statusCommand: "stato",
    statusDescription: "Stato dell'agente e dei messaggi da processare",
    balanceCommand: "bilancio",
    balanceDescription: "Quanti messaggi ho elaborato, quanti sono da riprovare",
  },
  en: {
    hello: (first) => (first ? `Hi ${first}` : "Hi"),
    intro: (name) =>
      `I'm ${name}. Send me links, notes, photos, voice messages or documents, or ask me about what you have saved.`,
    agentOnline: (name) => `the ${name} agent is connected`,
    agentOffline: (name, when) => `the ${name} agent is not connected (last seen ${when})`,
    agentNever: (name) => `the ${name} agent has never connected so far`,
    agentSilent: (name) => `the ${name} agent is connected but not responding`,
    queued: "your message is queued and will be processed as soon as it connects",
    pending: (n) => `Messages to process: ${n}.`,
    ago: {
      seconds: "a few seconds ago",
      minutes: (n) => `${n} ${n === 1 ? "minute" : "minutes"} ago`,
      hours: (n) => `${n} ${n === 1 ? "hour" : "hours"} ago`,
      days: (n) => `${n} days ago`,
    },
    statusCommand: "status",
    statusDescription: "Status of the agent and of the messages to process",
    balanceCommand: "balance",
    balanceDescription: "How many messages I processed, how many to retry",
  },
};
