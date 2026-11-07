require("dotenv").config();

const express = require("express");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;

const sessions = new Map();

app.get("/", (req, res) => {
  res.json({
    name: "YVONNIE2005",
    status: "online",
    message: "WhatsApp worker is running"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

app.use("/api", (req, res, next) => {
  if (!API_TOKEN || req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/api/accounts", (req, res) => {
  res.json({
    accounts: [...sessions.entries()].map(([id, socket]) => ({
      id,
      connected: socket.user ? true : false
    }))
  });
});

app.post("/api/accounts/:id/connect", async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return res.status(400).json({ error: "Invalid account ID" });

  try {
    const auth = await useMultiFileAuthState(`./sessions/${id}`);

    const socket = makeWASocket({
      auth: auth.state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false
    });

    socket.ev.on("creds.update", auth.saveCreds);

    socket.ev.on("connection.update", update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) console.log(`QR for ${id}: ${qr}`);

      if (connection === "open") {
        console.log(`${id} connected`);
      }

      if (connection === "close") {
        sessions.delete(id);
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log(`${id} disconnected; reconnect manually`);
        }
      }
    });

    sessions.set(id, socket);

    res.json({
      success: true,
      account: id,
      message: "Connection started. Pairing output is in service logs."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/accounts/:id/send", async (req, res) => {
  const socket = sessions.get(req.params.id);
  const { number, message } = req.body || {};

  if (!socket || !socket.user) {
    return res.status(409).json({ error: "Account not connected" });
  }

  if (!number || !message) {
    return res.status(400).json({ error: "Number and message required" });
  }

  try {
    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await socket.sendMessage(jid, { text: String(message) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`YVONNIE2005 worker listening on ${PORT}`);
});
