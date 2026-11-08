
const { askAI } = require("./ai");
const { getBotConfig } = require("./db");

const DEFAULT_RULES =
  "Respect all members, avoid spam, harassment and abusive language, and follow group administrator instructions.";

const replyTimes = new Map();
const AI_COOLDOWN_MS = 8000;

function unwrapMessage(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else {
      break;
    }
  }

  return current || {};
}

function getMessageText(message) {
  const msg = unwrapMessage(message);

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

function getContextInfo(message) {
  const msg = unwrapMessage(message);

  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    {}
  );
}

function normaliseJid(jid) {
  return String(jid || "")
    .split(":")[0]
    .toLowerCase();
}

function wasBotMentioned(socket, message, text) {
  const context = getContextInfo(message);
  const botJid = normaliseJid(socket.user?.id);

  if (!botJid) return false;

  const mentioned = (context.mentionedJid || []).map(normaliseJid);

  if (mentioned.includes(botJid)) return true;

  const botNumber = botJid.split("@")[0];

  if (botNumber && text.includes(`@${botNumber}`)) return true;

  const quotedParticipant = normaliseJid(context.participant);

  if (quotedParticipant && quotedParticipant === botJid) return true;

  return false;
}

function getRules(settings) {
  const rules = settings.groupRules;

  if (typeof rules === "string" && rules.trim()) {
    return rules.trim();
  }

  return DEFAULT_RULES;
}

function isCoolingDown(accountId, groupJid) {
  const key = `${accountId}:${groupJid}`;
  const now = Date.now();
  const previous = replyTimes.get(key) || 0;

  if (now - previous < AI_COOLDOWN_MS) return true;

  replyTimes.set(key, now);

  if (replyTimes.size > 1000) {
    for (const [storedKey, time] of replyTimes) {
      if (now - time > 60000) replyTimes.delete(storedKey);
    }
  }

  return false;
}

async function sendAIAnswer(socket, jid, question, config, quotedMessage) {
  const answer = await askAI(question, {
    settings: config.settings,
    groupRules: getRules(config.settings),
    knowledge: config.knowledge
  });

  await socket.sendMessage(
    jid,
    { text: answer },
    quotedMessage ? { quoted: quotedMessage } : {}
  );
}

function attachGroupHandlers(socket, accountId) {
  if (!accountId) {
    throw new Error("Group handlers require a WhatsApp account ID.");
  }

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type && type !== "notify") return;

    for (const message of messages || []) {
      try {
        if (!message.message || message.key.fromMe) continue;

        const jid = message.key.remoteJid;

        if (!jid || !jid.endsWith("@g.us")) continue;

        const text = getMessageText(message.message);

        if (!text) continue;

        const config = await getBotConfig(accountId);
        const settings = config.settings || {};
        const prefix =
          typeof settings.prefix === "string" && settings.prefix.trim()
            ? settings.prefix.trim()
            : ".";

        const trimmed = text.trim();

        // Process commands using the prefix saved for this account.
        if (trimmed.startsWith(prefix)) {
          const commandLine = trimmed.slice(prefix.length).trim();
          const firstSpace = commandLine.indexOf(" ");

          const command = (
            firstSpace === -1
              ? commandLine
              : commandLine.slice(0, firstSpace)
          ).toLowerCase();

          const argument =
            firstSpace === -1
              ? ""
              : commandLine.slice(firstSpace + 1).trim();

          if (command === "help" || command === "commands") {
            await socket.sendMessage(jid, {
              text:
                "🤖 *YVONNIE2005 GROUP BOT*\n\n" +
                `${prefix}help - Show commands\n` +
                `${prefix}ping - Check bot response\n` +
                `${prefix}rules - Display group rules\n` +
                `${prefix}ai your question - Ask the AI\n\n` +
                "Mention the bot to ask a group question when automatic Group AI is enabled."
            });
            continue;
          }

          if (command === "ping") {
            await socket.sendMessage(jid, {
              text: "🟢 YVONNIE2005 is online and responding."
            });
            continue;
          }

          if (command === "rules") {
            await socket.sendMessage(jid, {
              text: `📜 *GROUP RULES*\n\n${getRules(settings)}`
            });
            continue;
          }

          if (command === "ai") {
            if (!argument) {
              await socket.sendMessage(jid, {
                text: `Please enter a question.\nExample: ${prefix}ai Explain photosynthesis.`
              });
              continue;
            }

            if (settings.aiEnabled === false) {
              await socket.sendMessage(jid, {
                text: "⚠️ AI is disabled for this bot account. Enable it in your Control Centre."
              });
              continue;
            }

            if (isCoolingDown(accountId, jid)) {
              await socket.sendMessage(jid, {
                text: "⏳ Please wait a few seconds before asking another AI question."
              });
              continue;
            }

            await sendAIAnswer(
              socket,
              jid,
              argument,
              config,
              message
            );

            continue;
          }

          if (command) {
            await socket.sendMessage(jid, {
              text:
                `I don't recognise "${prefix}${command}".\n\n` +
                `Type ${prefix}help to see the available commands.\n` +
                `For AI questions, use ${prefix}ai your question.`
            });
            continue;
          }
        }

        // Automatic Group AI: respond only when the bot is addressed.
        if (
          settings.aiEnabled === true &&
          settings.aiGroupAnswers === true &&
          wasBotMentioned(socket, message.message, text)
        ) {
          const question = text.replace(/@\d{5,16}/g, "").trim();

          if (!question) continue;

          if (isCoolingDown(accountId, jid)) continue;

          await sendAIAnswer(
            socket,
            jid,
            question,
            config,
            message
          );
        }
      } catch (error) {
        console.error(
          `Group handler error for account ${accountId}:`,
          error.message
        );
      }
    }
  });
}

module.exports = { attachGroupHandlers };
