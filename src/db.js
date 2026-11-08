
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initializeDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_accounts (
      id TEXT PRIMARY KEY,
      session_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_config (
      account_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      knowledge JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getBotConfig(accountId) {
  if (!accountId) {
    throw new Error("A WhatsApp account ID is required.");
  }

  const result = await query(
    `SELECT settings, knowledge
     FROM whatsapp_bot_config
     WHERE account_id = $1`,
    [accountId]
  );

  if (!result.rows.length) {
    return {
      settings: {},
      knowledge: []
    };
  }

  return {
    settings: result.rows[0].settings || {},
    knowledge: Array.isArray(result.rows[0].knowledge)
      ? result.rows[0].knowledge
      : []
  };
}

async function saveBotSettings(accountId, settings) {
  if (!accountId) {
    throw new Error("A WhatsApp account ID is required.");
  }

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings must be an object.");
  }

  await query(
    `INSERT INTO whatsapp_bot_config
       (account_id, settings, knowledge, updated_at)
     VALUES ($1, $2::jsonb, '[]'::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (account_id)
     DO UPDATE SET
       settings = whatsapp_bot_config.settings || EXCLUDED.settings,
       updated_at = CURRENT_TIMESTAMP`,
    [accountId, JSON.stringify(settings)]
  );

  return getBotConfig(accountId);
}

async function saveBotKnowledge(accountId, knowledge) {
  if (!accountId) {
    throw new Error("A WhatsApp account ID is required.");
  }

  if (!Array.isArray(knowledge)) {
    throw new Error("Knowledge must be an array.");
  }

  await query(
    `INSERT INTO whatsapp_bot_config
       (account_id, settings, knowledge, updated_at)
     VALUES ($1, '{}'::jsonb, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (account_id)
     DO UPDATE SET
       knowledge = EXCLUDED.knowledge,
       updated_at = CURRENT_TIMESTAMP`,
    [accountId, JSON.stringify(knowledge)]
  );

  return getBotConfig(accountId);
}

module.exports = {
  pool,
  query,
  initializeDatabase,
  getBotConfig,
  saveBotSettings,
  saveBotKnowledge
};
