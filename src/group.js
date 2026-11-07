const { askAI } = require("./ai");

function attachGroupHandlers(socket) {
  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith("@g.us")) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text.startsWith(".")) continue;

      const command = text.trim().split(/\s+/)[0].toLowerCase();
      const question = text.trim().slice(command.length).trim();

      try {
        if (command === ".help") {
          await socket.sendMessage(jid, {
            text: "🤖 YVONNIE2005 Commands\n.help\n.rules\n.ai your question"
          });
        }

        if (command === ".rules") {
          await socket.sendMessage(jid, {
            text: process.env.GROUP_RULES ||
              "Please respect members, avoid spam and follow group admin instructions."
          });
        }

        if (command === ".ai" && question) {
          const answer = await askAI(question);
          await socket.sendMessage(jid, { text: answer });
        }

        if (command === ".moderate") {
          await socket.sendMessage(jid, {
            text: "Moderation is advisory. Group admins should review reported messages."
          });
        }
      } catch (error) {
        console.error("Group command error:", error.message);
      }
    }
  });
}

module.exports = { attachGroupHandlers };
