require("dotenv").config();

const express = require("express");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN;
const accounts = new Map();

app.get("/", (req, res) => {
  res.json({ name: "YVONNIE2005", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

app.use("/api", (req, res, next) => {
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/api/accounts/:id/connect", async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");

  if (!id) return res.status(400).json({ error: "Invalid account ID" });
  if (accounts.has(id)) {
    return res.json({ success: true, message: "Already started" });
  }

  try {
    const folder = path.join("/tmp", "yvonnie2005", id);
    fs.mkdirSync(folder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(folder);

    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" })
    });

    const account = {
      socket,
      qr: null,
      pairingCode: null,
      status: "connecting"
    };

    accounts.set(id, account);

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", update => {
      if (update.qr) account.qr = update.qr;

      if (update.connection === "open") {
        account.status = "connected";
        account.qr = null;
      }

      if (update.connection === "close") {
        account.status = "disconnected";
        accounts.delete(id);
      }
    });

    res.json({
      success: true,
      account: id,
      message: "Connection started"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/accounts/:id/qr", (req, res) => {
  const account = accounts.get(req.params.id);

  if (!account) {
    return res.status(404).json({ error: "Start the connection first" });
  }

  res.json({
    status: account.status,
    qr: account.qr
  });
});

app.post("/api/accounts/:id/pair-code", async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (!account) {
    return res.status(404).json({ error: "Start the connection first" });
  }

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  try {
    const code = await account.socket.requestPairingCode(phone);
    account.pairingCode = code;

    res.json({
      success: true,
      pairingCode: code
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/accounts", (req, res) => {
  res.json({
    accounts: [...accounts.entries()].map(([id, account]) => ({
      id,
      status: account.status
    }))
  });
});

app.listen(PORT, () => {
  console.log(`YVONNIE2005 running on port ${PORT}`);
});
