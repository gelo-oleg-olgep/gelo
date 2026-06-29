const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./gelo.db');

// ===== СОЗДАНИЕ ТАБЛИЦ =====
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    email TEXT UNIQUE,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER,
    to_user INTEGER,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const codes = {};

function detectType(input) {
  input = input.trim();
  if (input.includes('@') && input.includes('.')) return 'email';
  return 'phone';
}

// ============================================================
// ============== АВТОРИЗАЦИЯ ==================================
// ============================================================

app.post('/send-code', (req, res) => {
  const { identifier, action } = req.body;

  if (!action || (action !== 'login' && action !== 'register')) {
    return res.json({ success: false, error: 'Неизвестное действие' });
  }

  if (!identifier || identifier.trim() === '') {
    return res.json({ success: false, error: 'Введите номер или email' });
  }

  const type = detectType(identifier);
  let query = 'SELECT * FROM users WHERE ';
  let params = [];

  if (type === 'phone') {
    query += 'phone = ?';
    params.push(identifier);
  } else {
    query += 'email = ?';
    params.push(identifier);
  }

  db.get(query, params, (err, user) => {
    if (err) {
      console.error('❌ Ошибка проверки:', err);
      return res.json({ success: false, error: 'Ошибка базы данных' });
    }

    if (action === 'login') {
      const code = '123456';
      codes[identifier] = code;
      console.log(`📱 Код для ${identifier} (вход): ${code}`);
      return res.json({
        success: true,
        message: 'Код отправлен! (заглушка: 123456)',
        code: code
      });
    }

    if (action === 'register') {
      if (user) {
        return res.json({
          success: false,
          error: type === 'phone' 
            ? 'На этот номер уже зарегистрирован аккаунт' 
            : 'На этот email уже зарегистрирован аккаунт'
        });
      }

      const code = '123456';
      codes[identifier] = code;
      console.log(`📱 Код для ${identifier} (регистрация): ${code}`);
      return res.json({
        success: true,
        message: 'Код отправлен! (заглушка: 123456)',
        code: code
      });
    }
  });
});

app.post('/verify-code', (req, res) => {
  const { identifier, code, action } = req.body;

  if (!identifier || !code) {
    return res.json({ success: false, error: 'Заполните все поля' });
  }

  if (!action || (action !== 'login' && action !== 'register')) {
    return res.json({ success: false, error: 'Неизвестное действие' });
  }

  if (codes[identifier] !== code) {
    return res.json({ success: false, error: 'Неверный код' });
  }

  delete codes[identifier];

  const type = detectType(identifier);
  let query = 'SELECT * FROM users WHERE ';
  let params = [];

  if (type === 'phone') {
    query += 'phone = ?';
    params.push(identifier);
  } else {
    query += 'email = ?';
    params.push(identifier);
  }

  db.get(query, params, (err, user) => {
    if (err) {
      console.error('❌ Ошибка базы данных:', err);
      return res.json({ success: false, error: 'Ошибка базы данных' });
    }

    if (user) {
      return res.json({
        success: true,
        action: 'login',
        user: {
          id: user.id,
          phone: user.phone,
          email: user.email,
          username: user.username
        }
      });
    }

    res.json({
      success: true,
      action: 'register_needed',
      type: type
    });
  });
});

app.post('/register', (req, res) => {
  const { identifier, username } = req.body;

  if (!identifier || !username) {
    return res.json({ success: false, error: 'Заполните все поля' });
  }

  const type = detectType(identifier);
  let phone = null;
  let email = null;

  if (type === 'phone') {
    phone = identifier;
  } else {
    email = identifier;
  }

  db.get(
    'SELECT * FROM users WHERE phone = ? OR email = ?',
    [phone, email],
    (err, existingUser) => {
      if (err) {
        console.error('❌ Ошибка проверки:', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      if (existingUser) {
        return res.json({ success: false, error: 'Этот номер или email уже зарегистрирован' });
      }

      db.run(
        'INSERT INTO users (phone, email, username) VALUES (?, ?, ?)',
        [phone, email, username],
        function(err) {
          if (err) {
            console.error('❌ Ошибка вставки:', err);
            return res.json({ success: false, error: 'Ошибка базы данных: ' + err.message });
          }

          console.log('✅ Пользователь создан:', { id: this.lastID, phone, email, username });
          res.json({
            success: true,
            user: {
              id: this.lastID,
              phone: phone,
              email: email,
              username: username
            }
          });
        }
      );
    }
  );
});

// ============================================================
// ============== ПРОФИЛЬ ======================================
// ============================================================

app.post('/api/update-profile', (req, res) => {
  const { userId, username } = req.body;

  if (!userId || !username) {
    return res.json({ success: false, error: 'Заполните все поля' });
  }

  db.run(
    'UPDATE users SET username = ? WHERE id = ?',
    [username, userId],
    function(err) {
      if (err) {
        console.error('❌ Ошибка обновления профиля:', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      res.json({ success: true, message: 'Имя обновлено!' });
    }
  );
});

// ============================================================
// ============== ЧАТЫ (УПРОЩЁННЫЕ) ============================
// ============================================================

// --- ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ ---
app.get('/api/users', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.json({ success: false, error: 'Не указан пользователь' });
  }

  db.all(
    'SELECT id, username, phone, email FROM users WHERE id != ? ORDER BY username ASC',
    [userId],
    (err, rows) => {
      if (err) {
        console.error('❌ Ошибка получения пользователей:', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      res.json({ success: true, users: rows });
    }
  );
});

// --- ПОЛУЧИТЬ СПИСОК ЧАТОВ (УПРОЩЁННО) ---
app.get('/api/chats', (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.json({ success: false, error: 'Не указан пользователь' });
  }

  // Шаг 1: Получаем всех пользователей, с которыми есть сообщения
  db.all(
    `SELECT DISTINCT 
      CASE 
        WHEN from_user = ? THEN to_user 
        ELSE from_user 
      END as other_id
    FROM messages
    WHERE from_user = ? OR to_user = ?`,
    [userId, userId, userId],
    (err, rows) => {
      if (err) {
        console.error('❌ Ошибка получения чатов (шаг 1):', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      if (!rows || rows.length === 0) {
        return res.json({ success: true, chats: [] });
      }

      const ids = rows.map(r => r.other_id);
      const placeholders = ids.map(() => '?').join(',');

      // Шаг 2: Получаем данные пользователей
      db.all(
        `SELECT id, username, phone, email FROM users WHERE id IN (${placeholders})`,
        ids,
        (err2, users) => {
          if (err2) {
            console.error('❌ Ошибка получения пользователей чатов:', err2);
            return res.json({ success: false, error: 'Ошибка базы данных' });
          }

          if (!users || users.length === 0) {
            return res.json({ success: true, chats: [] });
          }

          // Шаг 3: Для каждого пользователя получаем последнее сообщение
          const results = [];
          let completed = 0;

          users.forEach(u => {
            db.get(
              `SELECT content, created_at FROM messages 
               WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
               ORDER BY created_at DESC LIMIT 1`,
              [userId, u.id, u.id, userId],
              (err3, lastMsg) => {
                if (err3) {
                  console.error('❌ Ошибка получения последнего сообщения:', err3);
                }
                results.push({
                  other_user_id: u.id,
                  username: u.username,
                  phone: u.phone,
                  email: u.email,
                  last_message: lastMsg ? lastMsg.content : null,
                  last_time: lastMsg ? lastMsg.created_at : null
                });
                completed++;
                if (completed === users.length) {
                  // Сортируем по времени
                  results.sort((a, b) => {
                    if (!a.last_time) return 1;
                    if (!b.last_time) return -1;
                    return new Date(b.last_time) - new Date(a.last_time);
                  });
                  res.json({ success: true, chats: results });
                }
              }
            );
          });
        }
      );
    }
  );
});

// --- ОТПРАВКА СООБЩЕНИЯ ---
app.post('/api/send-message', (req, res) => {
  const { from_user, to_user, content } = req.body;

  if (!from_user || !to_user || !content) {
    return res.json({ success: false, error: 'Заполните все поля' });
  }

  db.run(
    'INSERT INTO messages (from_user, to_user, content) VALUES (?, ?, ?)',
    [from_user, to_user, content],
    function(err) {
      if (err) {
        console.error('❌ Ошибка отправки сообщения:', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      res.json({
        success: true,
        message: {
          id: this.lastID,
          from_user,
          to_user,
          content,
          created_at: new Date().toISOString()
        }
      });
    }
  );
});

// --- ПОЛУЧИТЬ СООБЩЕНИЯ ---
app.get('/api/messages', (req, res) => {
  const { user1, user2 } = req.query;

  if (!user1 || !user2) {
    return res.json({ success: false, error: 'Не указаны пользователи' });
  }

  db.all(
    `SELECT * FROM messages 
     WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
     ORDER BY created_at ASC`,
    [user1, user2, user2, user1],
    (err, rows) => {
      if (err) {
        console.error('❌ Ошибка получения сообщений:', err);
        return res.json({ success: false, error: 'Ошибка базы данных' });
      }

      res.json({ success: true, messages: rows });
    }
  );
});

// ============================================================
// ============== WEBSOCKET ====================================
// ============================================================

wss.on('connection', (ws) => {
  console.log('🔥 Новый пользователь в Gelo');
  ws.on('message', (message) => {
    console.log('📩 Сообщение:', message.toString());
  });
});

// ============================================================
// ============== ЗАПУСК =======================================
// ============================================================

const PORT = process.env.PORT || 3001;

console.log('🚀 Сервер запускается...');

server.listen(PORT, () => {
  console.log(`🚀 Gelo запущен на http://localhost:${PORT}`);
  console.log(`📡 Сервер слушает порт ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Необработанная ошибка:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Необработанное отклонение:', err);
});