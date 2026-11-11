/**
 * Telegram grocery list bot — Cloudflare Worker + D1 database (free, instant replies).
 *
 * Needs in Cloudflare (Worker -> Settings):
 *   - D1 database binding named:  DB
 *   - Secret:   BOT_TOKEN         (from @BotFather)
 *   - Secret:   WEBHOOK_SECRET    (any random text you invent, e.g. "k39dfj2Lq8")
 *   - Variable: ALLOWED_CHAT_IDS  (optional, comma-separated, e.g. "123456789,-987654321")
 *
 * Commands (Hebrew):
 *   חלב | חלב, ביצים (or one item per line) | הסר חלב | מחק חלב | קניתי חלב
 *   רשימה | הצג רשימה | נקה רשימה | עזרה | id
 */

export default {
  async fetch(request, env) {
    // Opening the worker URL in a browser just shows this text
    if (request.method !== 'POST') return new Response('Grocery bot is running ✅');

    // Only accept calls that really come from Telegram
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const update = await request.json();
    const msg = update.message;
    if (!msg || !msg.text) return new Response('ok');

    const chatId = msg.chat.id;
    const text = normalize(msg.text);

    let result;
    if (text === 'id' || text === 'מזהה') {
      result = { text: 'מזהה הצ\'אט: ' + chatId };
    } else if (!isAllowed(chatId, env)) {
      result = { text: 'מצטער, זה בוט פרטי.' };
    } else {
      result = await handleCommand(text, env.DB);
    }

    // Answer directly in the webhook response — Telegram performs it for us.
    // Either a reaction on the user's message, or a text reply.
    if (result.react) {
      return Response.json({
        method: 'setMessageReaction',
        chat_id: chatId,
        message_id: msg.message_id,
        reaction: [{ type: 'emoji', emoji: result.react }],
      });
    }
    return Response.json({ method: 'sendMessage', chat_id: chatId, text: result.text });
  },
};

// "/List@MyBot" -> "list"
function normalize(text) {
  return text.trim().toLowerCase().replace(/^\//, '').replace(/^(\S+)@\S+/, '$1');
}

function isAllowed(chatId, env) {
  const allowed = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(chatId));
}

async function handleCommand(text, db) {
  // Creates the table the first time; does nothing afterwards
  await db.prepare('CREATE TABLE IF NOT EXISTS items (name TEXT PRIMARY KEY, added_at INTEGER)').run();

  if (text === 'start' || text === 'help' || text === 'עזרה') {
    return { text: 'פקודות:\n' +
      '• <מוצר> – הוספה (אפשר כמה: חלב, ביצים)\n' +
      '• הסר <מוצר> / מחק <מוצר>\n' +
      '• קניתי <מוצר>\n' +
      '• רשימה – הצגת הרשימה\n' +
      '• נקה רשימה – מחיקת הכל' };
  }

  if (text === 'רשימה' || text === 'הצג רשימה') {
    const { results } = await db.prepare('SELECT name FROM items ORDER BY added_at, rowid').all();
    if (results.length === 0) return { text: 'הרשימה ריקה ✅' };
    return { text: '🛒 רשימת קניות:\n' + results.map((r, i) => `${i + 1}. ${r.name}`).join('\n') };
  }

  if (text === 'נקה רשימה') {
    await db.prepare('DELETE FROM items').run();
    return { text: 'הרשימה נוקתה 🧹' };
  }

  const removeMatch = text.match(/^(הסר|מחק|קניתי|קנינו)\s+(.+)$/);
  if (removeMatch) {
    const item = removeMatch[2].trim();
    const result = await db.prepare('DELETE FROM items WHERE name = ?').bind(item).run();
    if (result.meta.changes === 0) return { text: `"${item}" לא ברשימה` };
    const { left } = await db.prepare('SELECT COUNT(*) AS left FROM items').first();
    return { text: `הוסר "${item}" (נשארו ${left})` };
  }

  // Anything else = add item(s)
  const items = text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const added = [];
  for (const item of items) {
    const result = await db.prepare('INSERT OR IGNORE INTO items (name, added_at) VALUES (?, ?)')
      .bind(item, Date.now()).run();
    if (result.meta.changes > 0) added.push(item);
  }
  if (added.length === 0) return { text: 'כבר ברשימה 👍' };
  return { react: '👍' };
}
