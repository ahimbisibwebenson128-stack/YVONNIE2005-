const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

const connections = new Map();

async function connectWhatsApp(id, onUpdate = () => {}) {
  const folder = path.join("/tmp", "yvonnie-sessions", id);
  fs.mkdirSync(folder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(folder);

  const socket = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" })
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", update => {
    onUpdate(update);

    if (update.connection === "open") {
      connections.set(id, socket);
    }

    if (update.connection === "close") {
      connections.delete(id);
      if (
        update.lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut
      ) {
        setTimeout(() => connectWhatsApp(id, onUpdate), 5000);
      }
    }
  });

  connections.set(id, socket);
  return socket;
}

function getConnection(id) {
  return connections.get(id);
}

module.exports = { connectWhatsApp, getConnection, connections };
