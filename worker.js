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
 * Anything that is not a command below is added to the list as an item
 * (several at once with commas or one per line). Adding reacts with 👍.
 */

// ---------- command phrases (add more here) ----------

const HELP_PHRASES = [
  'start', 'help', 'עזרה', 'פקודות', 'מה אפשר', 'איך משתמשים',
];

const SHOW_PHRASES = [
  'רשימה', 'הצג', 'הצג רשימה', 'הצג הכל',
  'מה צריך', 'מה חסר', 'מה ברשימה', 'מה יש ברשימה',
  'תראה', 'תראה רשימה', 'תראה לי', 'הראה', 'רשימת קניות', 'קניות',
  'list', 'show',
];

const CLEAR_PHRASES = [
  'נקה רשימה', 'נקה', 'נקה הכל', 'מחק הכל', 'מחק רשימה',
  'אפס', 'אפס רשימה', 'התחל מחדש', 'קניתי הכל', 'קנינו הכל',
];

// Words that come BEFORE an item to remove it: "קניתי חלב", "✅ חלב".
// Longer phrases first, so "יש לנו חלב" removes "חלב" and not "לנו חלב".
const REMOVE_PREFIXES = [
  'אין צורך', 'יש לנו',
  'הסר', 'מחק', 'תמחק', 'הורד', 'תוריד', 'בטל',
  'קניתי', 'קנינו', 'נקנה', 'לקחתי', 'יש',
];
const REMOVE_SYMBOLS = ['✅', '✓', '✔️', '✔'];

// ---------- webhook entry point ----------

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

// "/List@MyBot" -> "list",  "מה צריך?" -> "מה צריך",  "חלב!" -> "חלב"
function normalize(text) {
  return text
      .trim()
      .toLowerCase()
      .replace(/^\//, '')
      .replace(/^(\S+)@\S+/, '$1')
      .replace(/[?!.]+$/, '')
      .trim();
}

// "קניתי חלב" -> "חלב",  "✅ חלב" -> "חלב",  "חלב" -> null
function getItemToRemove(text) {
  for (const prefix of REMOVE_PREFIXES) {
    if (text.startsWith(prefix + ' ')) return text.slice(prefix.length).trim();
  }
  for (const symbol of REMOVE_SYMBOLS) {
    if (text.startsWith(symbol)) return text.slice(symbol.length).trim();
  }
  return null;
}

// ---------- command logic ----------

async function handleCommand(text, db, chatId) {
  // Creates the table the first time; does nothing afterwards.
  // chat_id separates the lists: every query below only touches this chat's rows.
  await db.prepare(
      'CREATE TABLE IF NOT EXISTS list_items (chat_id INTEGER, name TEXT, added_at INTEGER, PRIMARY KEY (chat_id, name))'
  ).run();

  // "?" becomes "" after normalize, so an empty message also shows help
  if (text === '' || HELP_PHRASES.includes(text)) {
    return { text: 'פקודות:\n' +
          '• <מוצר> – הוספה (אפשר כמה: חלב, ביצים)\n' +
          '• קניתי <מוצר> / הסר <מוצר> / ✅ <מוצר> – הסרה\n' +
          '• רשימה / מה צריך – הצגת הרשימה\n' +
          '• נקה רשימה / קניתי הכל – מחיקת הכל' };
  }

  if (SHOW_PHRASES.includes(text)) {
    const { results } = await db.prepare('SELECT name FROM list_items WHERE chat_id = ? ORDER BY added_at, rowid').bind(chatId).all();
    if (results.length === 0) return { text: 'הרשימה ריקה ✅' };
    return { text: '🛒 רשימת קניות:\n' + results.map((r, i) => `${i + 1}. ${r.name}`).join('\n') };
  }

  if (CLEAR_PHRASES.includes(text)) {
    await db.prepare('DELETE FROM list_items WHERE chat_id = ?').bind(chatId).run();
    return { text: 'הרשימה נוקתה 🧹' };
  }

  const item = getItemToRemove(text);
  if (item) {
    const result = await db.prepare('DELETE FROM list_items WHERE chat_id = ? AND name = ?').bind(chatId, item).run();
    if (result.meta.changes === 0) return { text: `"${item}" לא ברשימה` };
    const { left } = await db.prepare('SELECT COUNT(*) AS left FROM list_items WHERE chat_id = ?').bind(chatId).first();
    return { text: `הוסר "${item}" (נשארו ${left})` };
  }

  // Anything else = add item(s)
  const items = text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const added = [];
  for (const newItem of items) {
    const result = await db.prepare('INSERT OR IGNORE INTO list_items (chat_id, name, added_at) VALUES (?, ?, ?)')
        .bind(chatId, newItem, Date.now()).run();
    if (result.meta.changes > 0) added.push(newItem);
  }
  if (added.length === 0) return { text: 'כבר ברשימה 👍' };
  return { react: '👍' };
}
