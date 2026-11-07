const { pool } = require("./db");
const {
  initAuthCreds,
  BufferJSON
} = require("@whiskeysockets/baileys");

async function usePostgresAuthState(accountId) {
  const load = async (type, id) => {
    const result = await pool.query(
      `SELECT key_data FROM whatsapp_auth_keys
       WHERE account_id=$1 AND key_type=$2 AND key_id=$3`,
      [accountId, type, id]
    );
    return result.rows[0]
      ? JSON.parse(JSON.stringify(result.rows[0].key_data), BufferJSON.reviver)
      : null;
  };

  const credsResult = await pool.query(
    `SELECT session_data FROM whatsapp_accounts WHERE id=$1`,
    [accountId]
  );

  let creds = credsResult.rows[0]?.session_data
    ? JSON.parse(JSON.stringify(credsResult.rows[0].session_data), BufferJSON.reviver)
    : initAuthCreds();

  await pool.query(
    `INSERT INTO whatsapp_accounts (id, session_data)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [accountId, JSON.stringify(creds, BufferJSON.replacer)]
  );

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) data[id] = await load(type, id);
        return data;
      },
      set: async (data) => {
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values)) {
            if (value) {
              await pool.query(
                `INSERT INTO whatsapp_auth_keys
                 (account_id, key_type, key_id, key_data)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (account_id,key_type,key_id)
                 DO UPDATE SET key_data=EXCLUDED.key_data`,
                [accountId, type, id, JSON.stringify(value, BufferJSON.replacer)]
              );
            } else {
              await pool.query(
                `DELETE FROM whatsapp_auth_keys
                 WHERE account_id=$1 AND key_type=$2 AND key_id=$3`,
                [accountId, type, id]
              );
            }
          }
        }
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      await pool.query(
        `UPDATE whatsapp_accounts SET session_data=$2, updated_at=NOW()
         WHERE id=$1`,
        [accountId, JSON.stringify(creds, BufferJSON.replacer)]
      );
    }
  };
}

module.exports = { usePostgresAuthState };
