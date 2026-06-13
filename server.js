const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ─── Supabase Setup ──────────────────────────────────────────
const SUPABASE_URL = 'https://vrsldgrrcbxbihxlnupv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyc2xkZ3JyY2J4YmloeGxudXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNTAzNzIsImV4cCI6MjA5NjkyNjM3Mn0.Iox01jAKVHqvyZ9TdiNGftFd0uUowwf_rw9JUhMeXAI';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── App Setup ───────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(session({
  secret: 'chat-app-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Expose Supabase config to client ────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY });
});

// ─── Avatar Colors ───────────────────────────────────────────
const avatarColors = [
  '#6C5CE7', '#A29BFE', '#00B894', '#00CEC9', '#FDCB6E',
  '#E17055', '#D63031', '#E84393', '#0984E3', '#74B9FF',
  '#55EFC4', '#FF7675', '#FD79A8', '#636E72', '#B2BEC3'
];

function getRandomColor() {
  return avatarColors[Math.floor(Math.random() * avatarColors.length)];
}

// ─── API Routes ──────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username harus 3-20 karakter' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password minimal 4 karakter' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
  }

  // Check if username exists
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .ilike('username', username)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'Username sudah dipakai' });
  }

  const userId = uuidv4();
  const avatarColor = getRandomColor();

  const { error } = await supabase.from('users').insert({
    id: userId,
    username,
    password: bcrypt.hashSync(password, 10),
    avatar_color: avatarColor
  });

  if (error) {
    return res.status(500).json({ error: 'Gagal mendaftar: ' + error.message });
  }

  req.session.user = { id: userId, username, avatarColor };
  res.json({ success: true, user: { id: userId, username, avatarColor } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .ilike('username', username)
    .maybeSingle();

  if (!user) {
    return res.status(401).json({ error: 'Username tidak ditemukan' });
  }
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Password salah' });
  }

  req.session.user = { id: user.id, username: user.username, avatarColor: user.avatar_color };
  res.json({ success: true, user: { id: user.id, username: user.username, avatarColor: user.avatar_color } });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check session
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Get global messages
app.get('/api/messages/global', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('is_global', true)
    .order('created_at', { ascending: true })
    .limit(200);

  res.json(data || []);
});

// Get private messages
app.get('/api/messages/private/:targetUserId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const myId = req.session.user.id;
  const targetId = req.params.targetUserId;

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('is_global', false)
    .or(`and(sender_id.eq.${myId},receiver_id.eq.${targetId}),and(sender_id.eq.${targetId},receiver_id.eq.${myId})`)
    .order('created_at', { ascending: true })
    .limit(200);

  res.json(data || []);
});

// Send message
app.post('/api/messages', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { content, receiverId, receiverUsername, isGlobal } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
  }

  const msg = {
    id: uuidv4(),
    sender_id: req.session.user.id,
    sender_username: req.session.user.username,
    receiver_id: isGlobal ? null : receiverId,
    receiver_username: isGlobal ? null : receiverUsername,
    content: content.trim(),
    is_global: !!isGlobal
  };

  const { data, error } = await supabase.from('messages').insert(msg).select().single();

  if (error) {
    return res.status(500).json({ error: 'Gagal mengirim pesan' });
  }

  res.json(data);
});

// Get all users (for online list — simplified)
app.get('/api/users', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { data } = await supabase
    .from('users')
    .select('id, username, avatar_color')
    .neq('id', req.session.user.id)
    .order('username');

  res.json(data || []);
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Chat server running at http://localhost:${PORT}`);
  console.log(`📡 Database: Supabase Realtime\n`);
});
