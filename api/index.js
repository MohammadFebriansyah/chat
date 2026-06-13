const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ─── Supabase Setup ──────────────────────────────────────────
const SUPABASE_URL = 'https://vrsldgrrcbxbihxlnupv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyc2xkZ3JyY2J4YmloeGxudXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNTAzNzIsImV4cCI6MjA5NjkyNjM3Mn0.Iox01jAKVHqvyZ9TdiNGftFd0uUowwf_rw9JUhMeXAI';
const JWT_SECRET = 'chatkuy-jwt-secret-key-2024';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── App Setup ───────────────────────────────────────────────
const app = express();

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Auth Middleware ─────────────────────────────────────────
function getUserFromToken(req) {
  const token = req.cookies?.token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setToken(res, user) {
  const token = jwt.sign(
    { id: user.id, username: user.username, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

// ─── Avatar Colors ───────────────────────────────────────────
const avatarColors = [
  '#6C5CE7', '#A29BFE', '#00B894', '#00CEC9', '#FDCB6E',
  '#E17055', '#D63031', '#E84393', '#0984E3', '#74B9FF',
  '#55EFC4', '#FF7675', '#FD79A8', '#636E72', '#B2BEC3'
];

function getRandomColor() {
  return avatarColors[Math.floor(Math.random() * avatarColors.length)];
}

// ─── Expose Supabase config to client ────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY });
});

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

  const user = { id: userId, username, avatarColor, avatarUrl: null };
  setToken(res, user);
  res.json({ success: true, user });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const { data: dbUser } = await supabase
    .from('users')
    .select('*')
    .ilike('username', username)
    .maybeSingle();

  if (!dbUser) {
    return res.status(401).json({ error: 'Username tidak ditemukan' });
  }
  if (!bcrypt.compareSync(password, dbUser.password)) {
    return res.status(401).json({ error: 'Password salah' });
  }

  const user = { id: dbUser.id, username: dbUser.username, avatarColor: dbUser.avatar_color, avatarUrl: dbUser.avatar_url };
  setToken(res, user);
  res.json({ success: true, user });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Check session
app.get('/api/me', (req, res) => {
  const user = getUserFromToken(req);
  if (user) {
    res.json({ user: { id: user.id, username: user.username, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl } });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Get global messages
app.get('/api/messages/global', async (req, res) => {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('is_global', true)
    .order('created_at', { ascending: true })
    .limit(200);

  res.json(data || []);
});

// Get private messages
app.get('/api/messages/private/:targetUserId', async (req, res) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const myId = user.id;
  const targetId = req.params.targetUserId;

  const { data } = await supabase
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
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const {
    content,
    receiverId,
    receiverUsername,
    isGlobal,
    fileUrl,
    fileName,
    fileSize,
    fileType,
    replyToId,
    replyToUsername,
    replyToContent
  } = req.body;

  if ((!content || !content.trim()) && !fileUrl) {
    return res.status(400).json({ error: 'Pesan atau file tidak boleh kosong' });
  }

  const msg = {
    id: uuidv4(),
    sender_id: user.id,
    sender_username: user.username,
    receiver_id: isGlobal ? null : receiverId,
    receiver_username: isGlobal ? null : receiverUsername,
    content: content ? content.trim() : null,
    is_global: !!isGlobal,
    file_url: fileUrl || null,
    file_name: fileName || null,
    file_size: fileSize || null,
    file_type: fileType || null,
    reply_to_id: replyToId || null,
    reply_to_username: replyToUsername || null,
    reply_to_content: replyToContent || null
  };

  const { data, error } = await supabase.from('messages').insert(msg).select().single();

  if (error) {
    return res.status(500).json({ error: 'Gagal mengirim pesan: ' + error.message });
  }

  res.json(data);
});

// Edit message
app.put('/api/messages/:id', async (req, res) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Isi pesan tidak boleh kosong' });
  }

  // Fetch message to verify owner
  const { data: existing, error: fetchErr } = await supabase
    .from('messages')
    .select('sender_id, is_deleted')
    .eq('id', req.params.id)
    .maybeSingle();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  }
  if (existing.sender_id !== user.id) {
    return res.status(403).json({ error: 'Anda tidak diizinkan mengubah pesan ini' });
  }
  if (existing.is_deleted) {
    return res.status(400).json({ error: 'Pesan yang sudah dihapus tidak bisa diubah' });
  }

  const { data, error } = await supabase
    .from('messages')
    .update({
      content: content.trim(),
      is_edited: true
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Gagal mengubah pesan: ' + error.message });
  }

  res.json(data);
});

// Soft delete message
app.delete('/api/messages/:id', async (req, res) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Fetch message to verify owner
  const { data: existing, error: fetchErr } = await supabase
    .from('messages')
    .select('sender_id, is_deleted')
    .eq('id', req.params.id)
    .maybeSingle();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  }
  if (existing.sender_id !== user.id) {
    return res.status(403).json({ error: 'Anda tidak diizinkan menghapus pesan ini' });
  }
  if (existing.is_deleted) {
    return res.status(400).json({ error: 'Pesan ini sudah dihapus' });
  }

  const { data, error } = await supabase
    .from('messages')
    .update({
      content: 'Pesan ini telah dihapus',
      file_url: null,
      file_name: null,
      file_size: null,
      file_type: null,
      is_deleted: true
    })
     .eq('id', req.params.id)
     .select()
     .single();

  if (error) {
    return res.status(500).json({ error: 'Gagal menghapus pesan: ' + error.message });
  }

  res.json(data);
});

// Get all users
app.get('/api/users', async (req, res) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { data } = await supabase
    .from('users')
    .select('id, username, avatar_color, avatar_url')
    .neq('id', user.id)
    .order('username');

  res.json(data || []);
});

// Update profile
app.put('/api/profile', async (req, res) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { username, password, avatarUrl } = req.body;

  if (username && (username.trim().length < 3 || username.trim().length > 20)) {
    return res.status(400).json({ error: 'Username harus berukuran 3 hingga 20 karakter' });
  }

  const updateData = {};
  if (username) {
    const trimmed = username.trim();
    if (trimmed.toLowerCase() !== user.username.toLowerCase()) {
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .ilike('username', trimmed)
        .maybeSingle();

      if (existing) {
        return res.status(400).json({ error: 'Username sudah digunakan oleh orang lain' });
      }
    }
    updateData.username = trimmed;
  }

  if (password && password.length >= 4) {
    updateData.password = bcrypt.hashSync(password, 10);
  } else if (password) {
    return res.status(400).json({ error: 'Password baru minimal 4 karakter' });
  }

  if (avatarUrl !== undefined) {
    updateData.avatar_url = avatarUrl;
  }

  const { data, error } = await supabase
    .from('users')
    .update(updateData)
    .eq('id', user.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Gagal memperbarui profil: ' + error.message });
  }

  const updatedUser = {
    id: user.id,
    username: data.username,
    avatarColor: data.avatar_color,
    avatarUrl: data.avatar_url
  };
  setToken(res, updatedUser);

  res.json({ success: true, user: updatedUser });
});

// ─── Start Server (local dev) ────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀 Chat server running at http://localhost:${PORT}`);
    console.log(`📡 Database: Supabase Realtime\n`);
  });
}

// Export for Vercel serverless
module.exports = app;
