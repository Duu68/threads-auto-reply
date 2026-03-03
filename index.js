require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const { APP_ID, APP_SECRET, REDIRECT_URI, WEBHOOK_VERIFY_TOKEN, PORT } = process.env;

// ─── OAuth: 導向 Threads 授權頁 ─────────────────────────────
app.get('/auth/login', (req, res) => {
  const scope = 'threads_basic,threads_content_publish,threads_manage_replies,threads_keyword_search,threads_manage_mentions';
  const url = `https://threads.net/oauth/authorize?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code`;
  res.redirect(url);
});

// ─── OAuth: 換 token ─────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // 換短期 token
    const tokenRes = await axios.post('https://graph.threads.net/oauth/access_token', {
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const shortToken = tokenRes.data.access_token;
    const threadsUserId = tokenRes.data.user_id;

    // 換長期 token
    const longTokenRes = await axios.get(`https://graph.threads.net/access_token`, {
      params: {
        grant_type: 'th_exchange_token',
        client_secret: APP_SECRET,
        access_token: shortToken
      }
    });

    const longToken = longTokenRes.data.access_token;

    // 取用戶資料
    const profileRes = await axios.get(`https://graph.threads.net/v1.0/me`, {
      params: { fields: 'id,username', access_token: longToken }
    });

    const { id, username } = profileRes.data;

    // 存入資料庫
    db.prepare(`
      INSERT INTO users (threads_user_id, username, access_token)
      VALUES (?, ?, ?)
      ON CONFLICT(threads_user_id) DO UPDATE SET access_token=excluded.access_token, username=excluded.username
    `).run(id, username, longToken);

    const user = db.prepare('SELECT * FROM users WHERE threads_user_id = ?').get(id);
    res.redirect(`/dashboard?user_id=${user.id}`);
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

// ─── API: 取規則 ─────────────────────────────────────────────
app.get('/api/rules/:userId', (req, res) => {
  const rules = db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY created_at DESC').all(req.params.userId);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.userId);
  res.json({ user, rules });
});

// ─── API: 新增規則 ───────────────────────────────────────────
app.post('/api/rules', (req, res) => {
  const { user_id, keyword, reply_text, match_type } = req.body;
  if (!user_id || !keyword || !reply_text) return res.status(400).json({ error: 'Missing fields' });

  const result = db.prepare('INSERT INTO rules (user_id, keyword, reply_text, match_type) VALUES (?, ?, ?, ?)').run(
    user_id, keyword.trim(), reply_text.trim(), match_type || 'contains'
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

// ─── API: 刪除規則 ───────────────────────────────────────────
app.delete('/api/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── API: 開關規則 ───────────────────────────────────────────
app.patch('/api/rules/:id/toggle', (req, res) => {
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(rule.enabled ? 0 : 1, req.params.id);
  res.json({ success: true, enabled: !rule.enabled });
});

// ─── API: 回覆紀錄 ───────────────────────────────────────────
app.get('/api/logs/:userId', (req, res) => {
  const logs = db.prepare('SELECT * FROM reply_logs WHERE user_id = ? ORDER BY replied_at DESC LIMIT 50').all(req.params.userId);
  res.json(logs);
});

// ─── Webhook: 驗證 ───────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// ─── Webhook: 接收留言事件 ───────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // 先回 200，再處理

  const body = req.body;
  if (body.object !== 'threads') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'mentions' && change.field !== 'replies') continue;

      const commentData = change.value;
      const commentId = commentData.id;
      const commentText = (commentData.text || '').toLowerCase();
      const threadOwnerId = commentData.replied_to?.id || commentData.media?.owner?.id;

      if (!commentText || !commentId) continue;

      // 找到這個 Threads 帳號對應的用戶
      const user = db.prepare('SELECT * FROM users WHERE threads_user_id = ?').get(entry.id);
      if (!user) continue;

      // 抓這個用戶的啟用規則
      const rules = db.prepare('SELECT * FROM rules WHERE user_id = ? AND enabled = 1').all(user.id);

      for (const rule of rules) {
        const keyword = rule.keyword.toLowerCase();
        let matched = false;

        if (rule.match_type === 'exact') {
          matched = commentText === keyword;
        } else {
          matched = commentText.includes(keyword);
        }

        if (matched) {
          try {
            // 發回覆
            await axios.post(`https://graph.threads.net/v1.0/me/threads`, {
              media_type: 'TEXT',
              text: rule.reply_text,
              reply_to_id: commentId
            }, { params: { access_token: user.access_token } });

            // 發佈
            // (Threads 需要先 create 再 publish)
            console.log(`Replied to ${commentId} with keyword: ${rule.keyword}`);

            // 記錄
            db.prepare('INSERT INTO reply_logs (user_id, comment_id, keyword_matched, reply_sent) VALUES (?, ?, ?, ?)').run(
              user.id, commentId, rule.keyword, rule.reply_text
            );

            break; // 一則留言只回一次
          } catch (err) {
            console.error('Reply error:', err.response?.data || err.message);
          }
        }
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`Threads Bot running on http://localhost:${PORT}`);
});
