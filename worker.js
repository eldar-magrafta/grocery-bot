/**
 * Telegram grocery list bot — Cloudflare Worker + D1 database (free, instant replies).
 *
 * Every chat has its OWN list: each person who talks to the bot only sees their items.
 * (A Telegram group gets one list shared by the group's members.)
 *
 * Needs in Cloudflare (Worker -> Settings):
 *   - D1 database binding named:  DB
 *   - Secret:   BOT_TOKEN         (from @BotFather)
 *   - Secret:   WEBHOOK_SECRET    (any random text you invent, e.g. "k39dfj2Lq8")
 *
 * Commands (Hebrew):
 *   חלב | חלב, ביצים (or one item per line) | הסר חלב | מחק חלב | קניתי חלב
 *   רשימה | הצג רשימה | נקה רשימה | עזרה
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

    const result = await handleCommand(text, env.DB, chatId);

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

async function handleCommand(text, db, chatId) {
  // Creates the table the first time; does nothing afterwards.
  // chat_id separates the lists: every query below only touches this chat's rows.
  await db.prepare(
      'CREATE TABLE IF NOT EXISTS list_items (chat_id INTEGER, name TEXT, added_at INTEGER, PRIMARY KEY (chat_id, name))'
  ).run();

  if (text === 'start' || text === 'help' || text === 'עזרה') {
    return { text: 'פקודות:\n' +
          '• <מוצר> – הוספה (אפשר כמה: חלב, ביצים)\n' +
          '• הסר <מוצר> / מחק <מוצר>\n' +
          '• קניתי <מוצר>\n' +
          '• רשימה – הצגת הרשימה\n' +
          '• נקה רשימה – מחיקת הכל' };
  }

  if (text === 'רשימה' || text === 'הצג רשימה') {
    const { results } = await db.prepare('SELECT name FROM list_items WHERE chat_id = ? ORDER BY added_at, rowid').bind(chatId).all();
    if (results.length === 0) return { text: 'הרשימה ריקה ✅' };
    return { text: '🛒 רשימת קניות:\n' + results.map((r, i) => `${i + 1}. ${r.name}`).join('\n') };
  }

  if (text === 'נקה רשימה') {
    await db.prepare('DELETE FROM list_items WHERE chat_id = ?').bind(chatId).run();
    return { text: 'הרשימה נוקתה 🧹' };
  }

  const removeMatch = text.match(/^(הסר|מחק|קניתי|קנינו)\s+(.+)$/);
  if (removeMatch) {
    const item = removeMatch[2].trim();
    const result = await db.prepare('DELETE FROM list_items WHERE chat_id = ? AND name = ?').bind(chatId, item).run();
    if (result.meta.changes === 0) return { text: `"${item}" לא ברשימה` };
    const { left } = await db.prepare('SELECT COUNT(*) AS left FROM list_items WHERE chat_id = ?').bind(chatId).first();
    return { text: `הוסר "${item}" (נשארו ${left})` };
  }

  // Anything else = add item(s)
  const items = text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const added = [];
  for (const item of items) {
    const result = await db.prepare('INSERT OR IGNORE INTO list_items (chat_id, name, added_at) VALUES (?, ?, ?)')
        .bind(chatId, item, Date.now()).run();
    if (result.meta.changes > 0) added.push(item);
  }
  if (added.length === 0) return { text: 'כבר ברשימה 👍' };
  return { react: '👍' };
}
