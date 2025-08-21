// تابع برای escape کردن کاراکترهای MarkdownV2
function escapeMarkdownV2(text) {
  if (!text) return text;
  const charsToEscape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let escaped = text;
  for (const char of charsToEscape) {
    escaped = escaped.split(char).join(`\\${char}`);
  }
  return escaped;
}

async function sendMessage(chatId, text, replyMarkup = null, parseMode = null, env) {
  try {
    console.log(`Sending message to chat ${chatId}: ${text}`);
    const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    if (parseMode) body.parse_mode = parseMode;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) {
      console.error(`Telegram API error: ${result.description}`);
    }
    return result;
  } catch (e) {
    console.error(`Error in sendMessage: ${e.message}\nStack: ${e.stack}`);
    return null;
  }
}

async function deleteMessage(chatId, messageId, env) {
  try {
    console.log(`Deleting message ${messageId} from chat ${chatId}`);
    const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
    const result = await response.json();
    if (!result.ok) {
      console.error(`Telegram API error in deleteMessage: ${result.description}`);
    }
    return result;
  } catch (e) {
    console.error(`Error in deleteMessage: ${e.message}\nStack: ${e.stack}`);
    return null;
  }
}

async function cleanupMessages(messagesToDelete, env) {
  try {
    console.log('Cleaning up expired messages');
    const now = Date.now();
    const messagesToKeep = messagesToDelete.filter(msg => msg.delete_at > now);
    const expiredMessages = messagesToDelete.filter(msg => msg.delete_at <= now);
    for (const msg of expiredMessages) {
      console.log(`Deleting expired message: chat=${msg.chat_id}, messageId=${msg.message_id}`);
      await deleteMessage(msg.chat_id, msg.message_id, env);
      await env.D1.prepare('DELETE FROM messages_to_delete WHERE chat_id = ? AND message_id = ?')
        .bind(msg.chat_id, msg.message_id)
        .run();
    }
    return messagesToKeep;
  } catch (e) {
    console.error(`Error in cleanupMessages: ${e.message}\nStack: ${e.stack}`);
    return messagesToDelete;
  }
}

async function loadWords(env) {
  try {
    console.log('Loading words from D1');
    const { results } = await env.D1.prepare('SELECT id, word, hint FROM words').all();
    if (!results || results.length === 0) {
      console.error('Error: No words found in D1');
      return [];
    }
    console.log(`Loaded ${results.length} words from D1`);
    return results;
  } catch (e) {
    console.error(`Error loading words from D1: ${e.message}\nStack: ${e.stack}`);
    return [];
  }
}

async function getRandomWord(usedWords, env) {
  console.log(`Selecting random word. Used words: ${usedWords}`);
  const words = await loadWords(env);
  if (words.length === 0) {
    console.error('No words available in D1');
    return null;
  }
  const availableWords = words.filter(w => !usedWords.includes(w.id));
  if (availableWords.length === 0) {
    console.error('No available words left');
    return null;
  }
  const randomIndex = Math.floor(Math.random() * availableWords.length);
  console.log(`Selected word: ${availableWords[randomIndex].word}, id: ${availableWords[randomIndex].id}`);
  return availableWords[randomIndex];
}

function assignNewRoles(gameData) {
  console.log('Assigning new roles');
  const roles = [];
  for (let i = 0; i < (gameData.spyCount || 0); i++) roles.push('جاسوس');
  for (let i = 0; i < (gameData.citizenCount || 0); i++) roles.push('شهروند');
  for (let i = 0; i < (gameData.jokerCount || 0); i++) roles.push('جوکر');
  for (let i = 0; i < (gameData.sheriffCount || 0); i++) roles.push('کلانتر');
  const shuffledRoles = roles.sort(() => Math.random() - 0.5);
  gameData.players = (gameData.players || []).map((player, index) => ({
    ...player,
    role: shuffledRoles[index]
  }));
  console.log(`Assigned roles: ${JSON.stringify(gameData.players)}`);
  return gameData.players;
}

async function startRound(gameData, word, env, chatId, godId, messagesToDelete) {
  console.log(`Starting new round with word: ${word.word}, id: ${word.id}`);
  await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
    .bind('current_word_id', word.id.toString())
    .run();
  gameData.players = assignNewRoles(gameData);
  await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
    .bind('game', JSON.stringify(gameData))
    .run();

  for (const player of gameData.players) {
    const message = player.role === 'شهروند' || player.role === 'جوکر'
      ? `نقش: ${player.role} - واژه رمز: ${word.word}`
      : `نقش: ${player.role} - راهنمایی: ${word.hint}`;
    const response = await sendMessage(player.userId, message, null, null, env);
    if (response && response.result) {
      messagesToDelete.push({
        chat_id: player.userId,
        message_id: response.result.message_id,
        delete_at: Date.now() + 120000
      });
      await env.D1.prepare('INSERT INTO messages_to_delete (chat_id, message_id, delete_at) VALUES (?, ?, ?)')
        .bind(player.userId, response.result.message_id, Date.now() + 120000)
        .run();
    }
  }
  const menuKeyboard = {
    inline_keyboard: [
      [{ text: 'بازیکنان', callback_data: 'players' }],
      [{ text: 'راند بعدی', callback_data: 'next_round' }],
      [{ text: 'پایان بازی', callback_data: 'end_game' }]
    ]
  };
  await sendMessage(godId, 'راند جدید شروع شد!', menuKeyboard, null, env);
  console.log(`Round started, gameData: ${JSON.stringify(gameData)}`);
  return true;
}

async function handleUpdate(update, env) {
  try {
    // بررسی وجود متغیرهای محیطی و پایگاه داده
    if (!env.D1) {
      console.error('D1 database is not configured in the environment');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) {
        await sendMessage(chatId, 'خطا: پایگاه داده در دسترس نیست. لطفاً با مدیر تماس بگیرید.', null, null, env);
      }
      return;
    }

    if (!env.TELEGRAM_TOKEN) {
      console.error('TELEGRAM_TOKEN is not configured in the environment');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) {
        await sendMessage(chatId, 'خطا: توکن تلگرام تنظیم نشده است. لطفاً با مدیر تماس بگیرید.', null, null, env);
      }
      return;
    }

    if (!env.MASTER_PASSWORD) {
      console.error('MASTER_PASSWORD is not configured in the environment');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) {
        await sendMessage(chatId, 'خطا: رمز مستر تنظیم نشده است. لطفاً با مدیر تماس بگیرید.', null, null, env);
      }
      return;
    }

    if (!env.WORDS_PROMPT) {
      console.error('WORDS_PROMPT is not configured in the environment');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) {
        await sendMessage(chatId, 'خطا: پرامپت واژگان تنظیم نشده است. لطفاً با مدیر تماس بگیرید.', null, null, env);
      }
      return;
    }

    // بررسی وجود جدول game
    const tableCheck = await env.D1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='game'").first();
    if (!tableCheck) {
      console.error('Table "game" does not exist in D1 database');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) {
        await sendMessage(chatId, 'خطا: جداول پایگاه داده تنظیم نشده‌اند. لطفاً با مدیر تماس بگیرید.', null, null, env);
      }
      return;
    }

    console.log('Received update:', JSON.stringify(update));
    if (!update.message && !update.callback_query) {
      console.log('No message or callback_query in update');
      const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
      if (chatId) await sendMessage(chatId, 'خطا: درخواست نامعتبر', null, null, env);
      return;
    }

    const chatId = update.message ? update.message.chat.id : update.callback_query.from.id;
    const userId = update.message ? update.message.from.id : update.callback_query.from.id;
    const text = update.message ? update.message.text : update.callback_query.data;
    const messageId = update.message ? update.message.message_id : update.callback_query.message.message_id;
    console.log(`Processing request: chat=${chatId}, user=${userId}, text=${text}, messageId=${messageId}`);

    // لود داده‌ها از D1
    console.log('Fetching game data from D1');
    let gameData = {};
    let usedWords = [];
    let messagesToDelete = [];
    let state = '';
    let godId = '';
    let pendingWordId = '';

    const gameResult = await env.D1.prepare('SELECT key, value FROM game WHERE key IN (?, ?, ?, ?, ?)')
      .bind('game', 'usedWords', 'state', 'god_id', 'pending_word_id')
      .all();
    for (const row of gameResult.results) {
      if (row.key === 'game') gameData = row.value ? JSON.parse(row.value) : {};
      if (row.key === 'usedWords') usedWords = row.value ? JSON.parse(row.value) : [];
      if (row.key === 'state') state = row.value || '';
      if (row.key === 'god_id') godId = row.value || '';
      if (row.key === 'pending_word_id') pendingWordId = row.value || '';
    }
    const messagesResult = await env.D1.prepare('SELECT chat_id, message_id, delete_at FROM messages_to_delete').all();
    messagesToDelete = messagesResult.results || [];

    // حذف پیام‌های قدیمی
    messagesToDelete = await cleanupMessages(messagesToDelete, env);

    // لود وضعیت و گاد
    console.log(`Current state: ${state}, god_id: ${godId}, gameData: ${JSON.stringify(gameData)}`);

    // پیام پیش‌فرض وقتی گاد نیست
    if (!godId && !state && text !== '/god' && text !== '/r') {
      await sendMessage(chatId, 'برای آغاز بازی دستور /god را بفرستید.', null, null, env);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    // دستور /god
    if (text === '/god') {
      console.log('Processing /god command');
      if (godId) {
        await sendMessage(chatId, 'یک گاد قبلاً فعال است. تا ریست بازی نمی‌توانید گاد شوید.', null, null, env);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      await sendMessage(chatId, 'لطفاً رمز مستر را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_master_password')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('god_id', userId.toString())
        .run();
      console.log(`State set to waiting_for_master_password, god_id: ${userId}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    // دستور /r
    if (text === '/r') {
      console.log('Processing /r command');
      const confirmKeyboard = {
        inline_keyboard: [[
          { text: 'بله', callback_data: 'confirm_reset' },
          { text: 'خیر', callback_data: 'cancel_reset' }
        ]]
      };
      await sendMessage(chatId, 'آیا مطمئنید که می‌خواهید بازی را ریست کنید؟', confirmKeyboard, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_reset_confirmation')
        .run();
      console.log(`State set to waiting_for_reset_confirmation`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    // مدیریت callbackهای اینلاین
    if (update.callback_query) {
      const data = update.callback_query.data;
      console.log(`Processing callback: ${data}`);
      if (data === 'confirm_reset') {
        await sendMessage(chatId, 'لطفاً رمز مستر را وارد کنید:', null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_reset_password')
          .run();
        console.log(`State set to waiting_for_reset_password`);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'cancel_reset') {
        await sendMessage(chatId, 'ریست بازی لغو شد.', null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', '')
          .run();
        console.log('Reset cancelled, state cleared');
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'players') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند لیست بازیکنان را ببیند.', null, null, env);
          return;
        }
        const players = gameData.players || [];
        await sendMessage(chatId, `${players.length} بازیکن از ${gameData.totalPlayers || 0} بازیکن نقش گرفته‌اند.`, null, null, env);
        return;
      }
      if (data === 'next_round') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند راند بعدی را شروع کند.', null, null, env);
          return;
        }
        if (!gameData.players || gameData.players.length === 0) {
          await sendMessage(chatId, 'هیچ بازیکنی در بازی نیست.', null, null, env);
          return;
        }
        const word = await getRandomWord(usedWords, env);
        if (!word) {
          await sendMessage(chatId, 'خطا: واژه‌ای برای راند جدید باقی نمانده است. لطفاً واژگان را به‌روزرسانی کنید.', null, null, env);
          return;
        }
        const confirmKeyboard = {
          inline_keyboard: [[
            { text: 'تأیید', callback_data: 'confirm_round' },
            { text: 'رد', callback_data: 'reject_word' }
          ]]
        };
        const escapedWord = escapeMarkdownV2(word.word);
        const escapedHint = escapeMarkdownV2(word.hint);
        await sendMessage(godId, `واژه رمز: ||${escapedWord}||\nراهنمایی: ${escapedHint}`, confirmKeyboard, 'MarkdownV2', env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_round_confirmation')
          .run();
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('pending_word_id', word.id.toString())
          .run();
        console.log(`Sent word and hint to god: word=${escapedWord}, hint=${escapedHint}, waiting for round confirmation`);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'end_game') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند بازی را پایان دهد.', null, null, env);
          return;
        }
        const confirmKeyboard = {
          inline_keyboard: [[
            { text: 'بله', callback_data: 'confirm_reset' },
            { text: 'خیر', callback_data: 'cancel_reset' }
          ]]
        };
        await sendMessage(chatId, 'آیا مطمئنید که می‌خواهید بازی را پایان دهید؟', confirmKeyboard, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_reset_confirmation')
          .run();
        console.log(`State set to waiting_for_reset_confirmation`);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'god_menu') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند به منوی گاد دسترسی داشته باشد.', null, null, env);
          return;
        }
        const godMenuKeyboard = {
          inline_keyboard: [
            [{ text: 'تنظیم بازی', callback_data: 'setup_game' }],
            [{ text: 'واژگان', callback_data: 'words_menu' }]
          ]
        };
        await sendMessage(chatId, 'لطفاً گزینه مورد نظر را انتخاب کنید:', godMenuKeyboard, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'god_menu')
          .run();
        return;
      }
      if (data === 'words_menu') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند به منوی واژگان دسترسی داشته باشد.', null, null, env);
          return;
        }
        const wordsMenuKeyboard = {
          inline_keyboard: [
            [{ text: 'ارسال پرامپت', callback_data: 'send_prompt' }],
            [{ text: 'ویرایش واژگان', callback_data: 'edit_words' }],
            [{ text: 'بازگشت', callback_data: 'god_menu' }]
          ]
        };
        await sendMessage(chatId, 'لطفاً گزینه مورد نظر را انتخاب کنید:', wordsMenuKeyboard, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'words_menu')
          .run();
        return;
      }
      if (data === 'send_prompt') {
        await sendMessage(chatId, env.WORDS_PROMPT, null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'words_menu')
          .run();
        return;
      }
      if (data === 'edit_words') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند واژگان را ویرایش کند.', null, null, env);
          return;
        }
        await sendMessage(chatId, 'لطفاً لیست واژگان را در قالب JSON بفرستید:', null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_words_json')
          .run();
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('god_id', userId.toString())
          .run();
        console.log(`State set to waiting_for_words_json, god_id: ${userId}`);
        return;
      }
      if (data === 'setup_game') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند بازی را تنظیم کند.', null, null, env);
          return;
        }
        await sendMessage(chatId, 'رمز بازی را وارد کنید:', null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_game_password')
          .run();
        return;
      }
      if (data === 'confirm_roles') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند نقش‌ها را تأیید کند.', null, null, env);
          return;
        }
        console.log('Processing confirm_roles');
        gameData.players = [];
        const word = await getRandomWord(usedWords, env);
        if (!word) {
          await sendMessage(chatId, 'خطا: واژه‌ای برای شروع بازی باقی نمانده است. لطفاً واژگان را به‌روزرسانی کنید.', null, null, env);
          console.error('No word available for confirm_roles');
          return;
        }
        const confirmKeyboard = {
          inline_keyboard: [[
            { text: 'تأیید', callback_data: 'confirm_round' },
            { text: 'رد', callback_data: 'reject_word' }
          ]]
        };
        const escapedWord = escapeMarkdownV2(word.word);
        const escapedHint = escapeMarkdownV2(word.hint);
        await sendMessage(godId, `واژه رمز: ||${escapedWord}||\nراهنمایی: ${escapedHint}`, confirmKeyboard, 'MarkdownV2', env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_round_confirmation')
          .run();
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('pending_word_id', word.id.toString())
          .run();
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('game', JSON.stringify(gameData))
          .run();
        console.log(`Sent word and hint to god: word=${escapedWord}, hint=${escapedHint}, waiting for round confirmation, gameData: ${JSON.stringify(gameData)}`);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'confirm_round') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند راند را شروع کند.', null, null, env);
          return;
        }
        console.log('Processing confirm_round');
        const wordIdResult = await env.D1.prepare('SELECT value FROM game WHERE key = ?')
          .bind('pending_word_id')
          .first();
        const wordId = wordIdResult ? wordIdResult.value : null;
        if (!wordId) {
          await sendMessage(chatId, 'خطا: واژه انتخاب‌شده پیدا نشد.', null, null, env);
          console.error('No pending_word_id found');
          return;
        }
        const words = await loadWords(env);
        const word = words.find(w => w.id.toString() === wordId);
        if (!word) {
          await sendMessage(chatId, 'خطا: واژه پیدا نشد.', null, null, env);
          console.error(`Word not found for id: ${wordId}`);
          return;
        }
        usedWords.push(word.id);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('usedWords', JSON.stringify(usedWords))
          .run();
        const success = await startRound(gameData, word, env, chatId, godId, messagesToDelete);
        if (success) {
          await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
            .bind('state', 'game_started')
            .run();
          console.log(`Game started, gameData: ${JSON.stringify(gameData)}`);
        } else {
          console.error('Failed to start round');
        }
        await deleteMessage(chatId, messageId, env);
        return;
      }
      if (data === 'reject_word') {
        if (userId.toString() !== godId) {
          await sendMessage(chatId, 'فقط گاد می‌تواند واژه را رد کند.', null, null, env);
          return;
        }
        console.log('Processing reject_word');
        const wordIdResult = await env.D1.prepare('SELECT value FROM game WHERE key = ?')
          .bind('pending_word_id')
          .first();
        const wordId = wordIdResult ? wordIdResult.value : null;
        if (!wordId) {
          await sendMessage(chatId, 'خطا: واژه‌ای برای رد کردن وجود ندارد.', null, null, env);
          console.error('No pending_word_id found for reject_word');
          return;
        }
        usedWords.push(wordId);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('usedWords', JSON.stringify(usedWords))
          .run();
        const newWord = await getRandomWord(usedWords, env);
        if (!newWord) {
          await sendMessage(chatId, 'خطا: واژه دیگری برای انتخاب باقی نمانده است. لطفاً واژگان را به‌روزرسانی کنید.', null, null, env);
          console.error('No word available for reject_word');
          return;
        }
        const confirmKeyboard = {
          inline_keyboard: [[
            { text: 'تأیید', callback_data: 'confirm_round' },
            { text: 'رد', callback_data: 'reject_word' }
          ]]
        };
        const escapedWord = escapeMarkdownV2(newWord.word);
        const escapedHint = escapeMarkdownV2(newWord.hint);
        await sendMessage(godId, `واژه رمز: ||${escapedWord}||\nراهنمایی: ${escapedHint}`, confirmKeyboard, 'MarkdownV2', env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_round_confirmation')
          .run();
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('pending_word_id', newWord.id.toString())
          .run();
        console.log(`Rejected word id: ${wordId}, sent new word: ${escapedWord}, hint: ${escapedHint}`);
        await deleteMessage(chatId, messageId, env);
        return;
      }
    }

    // مدیریت مراحل بازی
    if (state === 'waiting_for_master_password') {
      if (text !== env.MASTER_PASSWORD) {
        await sendMessage(chatId, 'رمز مستر اشتباه است. دوباره تلاش کنید.', null, null, env);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      const godMenuKeyboard = {
        inline_keyboard: [
          [{ text: 'تنظیم بازی', callback_data: 'setup_game' }],
          [{ text: 'واژگان', callback_data: 'words_menu' }]
        ]
      };
      await sendMessage(chatId, 'به منوی گاد خوش آمدید. گزینه مورد نظر را انتخاب کنید:', godMenuKeyboard, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'god_menu')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('god_id', userId.toString())
        .run();
      console.log(`Master password confirmed, god_id: ${userId}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_reset_password') {
      if (text !== env.MASTER_PASSWORD) {
        await sendMessage(chatId, 'رمز مستر اشتباه است. دوباره تلاش کنید.', null, null, env);
        await deleteMessage(chatId, messageId, env);
        return;
      }
      await env.D1.prepare('DELETE FROM game').run();
      await env.D1.prepare('DELETE FROM messages_to_delete').run();
      await sendMessage(chatId, 'بازی با موفقیت ریست شد.', null, null, env);
      console.log('Game reset successfully');
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_words_json' && userId.toString() === godId) {
      try {
        const newWords = JSON.parse(text);
        if (!Array.isArray(newWords) || newWords.some(w => !w.id || !w.word || !w.hint)) {
          await sendMessage(chatId, 'فرمت JSON نامعتبر است. لطفاً لیست واژگان را در قالب درست بفرستید.', null, null, env);
          return;
        }
        await env.D1.prepare('DELETE FROM words').run();
        const stmt = env.D1.prepare('INSERT INTO words (id, word, hint) VALUES (?, ?, ?)');
        for (const word of newWords) {
          await stmt.bind(word.id, word.word, word.hint).run();
        }
        await sendMessage(chatId, 'واژگان با موفقیت به‌روزرسانی شد.', null, null, env);
        const wordsMenuKeyboard = {
          inline_keyboard: [
            [{ text: 'ارسال پرامپت', callback_data: 'send_prompt' }],
            [{ text: 'ویرایش واژگان', callback_data: 'edit_words' }],
            [{ text: 'بازگشت', callback_data: 'god_menu' }]
          ]
        };
        await sendMessage(chatId, 'به منوی واژگان بازگشتید. گزینه مورد نظر را انتخاب کنید:', wordsMenuKeyboard, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'words_menu')
          .run();
        await deleteMessage(chatId, messageId, env);
        return;
      } catch (e) {
        await sendMessage(chatId, 'خطا در پردازش JSON. لطفاً فرمت را بررسی کنید و دوباره بفرستید.', null, null, env);
        return;
      }
    }

    if (state === 'waiting_for_game_password') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند رمز بازی را تنظیم کند.', null, null, env);
        return;
      }
      gameData.gamePassword = text;
      await sendMessage(chatId, 'تعداد کل بازیکن‌ها را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_total_players')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Game password set: ${text}, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_total_players') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند تعداد بازیکن‌ها را تنظیم کند.', null, null, env);
        return;
      }
      const totalPlayers = parseInt(text);
      if (isNaN(totalPlayers) || totalPlayers < 1) {
        await sendMessage(chatId, 'لطفاً یک عدد معتبر وارد کنید.', null, null, env);
        return;
      }
      gameData.totalPlayers = totalPlayers;
      await sendMessage(chatId, 'تعداد جاسوس‌ها را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_spies')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Total players set: ${totalPlayers}, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_spies') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند تعداد جاسوس‌ها را تنظیم کند.', null, null, env);
        return;
      }
      gameData.spyCount = parseInt(text);
      await sendMessage(chatId, 'تعداد شهروندها را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_citizens')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Spy count set: ${gameData.spyCount}, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_citizens') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند تعداد شهروندها را تنظیم کند.', null, null, env);
        return;
      }
      gameData.citizenCount = parseInt(text);
      await sendMessage(chatId, 'تعداد جوکرها را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_jokers')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Citizen count set: ${gameData.citizenCount}, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_jokers') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند تعداد جوکرها را تنظیم کند.', null, null, env);
        return;
      }
      gameData.jokerCount = parseInt(text);
      await sendMessage(chatId, 'تعداد کلانترها را وارد کنید:', null, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_sheriffs')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Joker count set: ${gameData.jokerCount}, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'waiting_for_sheriffs') {
      if (userId.toString() !== godId) {
        await sendMessage(chatId, 'فقط گاد می‌تواند تعداد کلانترها را تنظیم کند.', null, null, env);
        return;
      }
      gameData.sheriffCount = parseInt(text);
      const total = (gameData.spyCount || 0) + (gameData.citizenCount || 0) + (gameData.jokerCount || 0) + (gameData.sheriffCount || 0);
      if (total !== gameData.totalPlayers) {
        await sendMessage(chatId, 'تعداد نقش‌ها با تعداد بازیکن‌ها مطابقت ندارد. لطفاً دوباره تنظیم کنید.', null, null, env);
        await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
          .bind('state', 'waiting_for_spies')
          .run();
        await deleteMessage(chatId, messageId, env);
        return;
      }
      const confirmKeyboard = {
        inline_keyboard: [[{ text: 'تأیید', callback_data: 'confirm_roles' }]]
      };
      await sendMessage(chatId, `تعداد نقش‌ها:\nجاسوس: ${gameData.spyCount}\nشهروند: ${gameData.citizenCount}\nجوکر: ${gameData.jokerCount}\nکلانتر: ${gameData.sheriffCount}\nآیا تأیید می‌کنید؟`, confirmKeyboard, null, env);
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('state', 'waiting_for_role_confirmation')
        .run();
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Roles set, waiting for confirmation, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    if (state === 'game_started' && text === gameData.gamePassword) {
      console.log(`Processing game password: ${text}, gameData: ${JSON.stringify(gameData)}`);
      if (!gameData.players) gameData.players = [];
      if (gameData.players.length >= gameData.totalPlayers) {
        await sendMessage(chatId, 'ظرفیت بازی پر شده است.', null, null, env);
        return;
      }
      if (gameData.players.some(p => p.userId === userId)) {
        await sendMessage(chatId, 'شما قبلاً نقش گرفته‌اید.', null, null, env);
        return;
      }

      const roles = [];
      for (let i = 0; i < (gameData.spyCount || 0); i++) roles.push('جاسوس');
      for (let i = 0; i < (gameData.citizenCount || 0); i++) roles.push('شهروند');
      for (let i = 0; i < (gameData.jokerCount || 0); i++) roles.push('جوکر');
      for (let i = 0; i < (gameData.sheriffCount || 0); i++) roles.push('کلانتر');
      const shuffledRoles = roles.sort(() => Math.random() - 0.5);
      const playerRole = shuffledRoles[gameData.players.length];

      const wordIdResult = await env.D1.prepare('SELECT value FROM game WHERE key = ?')
        .bind('current_word_id')
        .first();
      const wordId = wordIdResult ? wordIdResult.value : null;
      const words = await loadWords(env);
      const word = words.find(w => w.id.toString() === wordId);
      if (!word) {
        await sendMessage(chatId, 'خطا: واژه‌ای برای تخصیص باقی نمانده است.', null, null, env);
        return;
      }

      const message = playerRole === 'شهروند' || playerRole === 'جوکر'
        ? `نقش: ${playerRole} - واژه رمز: ${word.word}`
        : `نقش: ${playerRole} - راهنمایی: ${word.hint}`;
      const response = await sendMessage(chatId, message, null, null, env);
      if (response && response.result) {
        messagesToDelete.push({
          chat_id: chatId,
          message_id: response.result.message_id,
          delete_at: Date.now() + 120000
        });
        await env.D1.prepare('INSERT INTO messages_to_delete (chat_id, message_id, delete_at) VALUES (?, ?, ?)')
          .bind(chatId, response.result.message_id, Date.now() + 120000)
          .run();
      }
      gameData.players.push({ userId, role: playerRole });
      await env.D1.prepare('INSERT OR REPLACE INTO game (key, value) VALUES (?, ?)')
        .bind('game', JSON.stringify(gameData))
        .run();
      console.log(`Player added, gameData: ${JSON.stringify(gameData)}`);
      await deleteMessage(chatId, messageId, env);
      return;
    }

    await sendMessage(chatId, 'هیچ بازی فعالی وجود ندارد یا رمز اشتباه است.', null, null, env);
  } catch (e) {
    console.error(`Update Error: ${e.message}\nStack: ${e.stack}`);
    const chatId = update.message ? update.message.chat.id : update.callback_query ? update.callback_query.from.id : null;
    if (chatId) {
      await sendMessage(chatId, 'خطا در پردازش درخواست. لطفاً دوباره تلاش کنید.', null, null, env);
    }
  }
}

export default {
  async fetch(request, env) {
    console.log('Received request:', request.method, request.url);
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error(`Error processing webhook: ${error.message}\nStack: ${error.stack}`);
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    }
    return new Response('Webhook endpoint for Telegram bot', { status: 200 });
  }
};
