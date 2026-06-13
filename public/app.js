// ═══════════ ChatKuy — Supabase Realtime Client ═══════════

(() => {
  'use strict';

  // ─── State ─────────────────────────────────────────
  let currentUser = null;
  let supabaseClient = null;
  let realtimeChannel = null;
  let activeChat = { type: 'global', userId: null, username: null };
  let unreadCounts = { global: 0 };
  let allUsers = [];
  let selectedFile = null;
  let uploadedFileUrl = null;
  let progressInterval = null;
  let replyingTo = null;
  let editingMessage = null;
  let contextMenuLastShown = 0;

  // ─── DOM Elements ──────────────────────────────────
  const $ = (sel) => document.querySelector(sel);

  const authScreen = $('#auth-screen');
  const chatScreen = $('#chat-screen');
  const loginForm = $('#login-form');
  const registerForm = $('#register-form');
  const loginError = $('#login-error');
  const registerError = $('#register-error');
  const chatMessages = $('#chat-messages');
  const chatWelcome = $('#chat-welcome');
  const messageInput = $('#message-input');
  const sendBtn = $('#send-btn');
  const chatTitle = $('#chat-title');
  const chatStatus = $('#chat-status');
  const chatAvatar = $('#chat-avatar');
  const onlineUsersList = $('#online-users-list');
  const onlineCount = $('#online-count');
  const typingIndicator = $('#typing-indicator');
  const typingUsername = $('#typing-username');
  const sidebar = $('#sidebar');
  const globalChatBtn = $('#global-chat-btn');
  const globalUnread = $('#global-unread');
  const myUsername = $('#my-username');
  const myAvatar = $('#my-avatar');
  const fileInput = $('#file-input');
  const attachBtn = $('#attach-btn');
  const uploadPreview = $('#upload-preview');
  const previewName = $('#preview-name');
  const previewSize = $('#preview-size');
  const cancelUploadBtn = $('#cancel-upload-btn');
  const uploadProgressFill = $('#upload-progress-fill');

  const replyPreviewPanel = $('#reply-preview-panel');
  const replyPreviewSender = $('#reply-preview-sender');
  const replyPreviewText = $('#reply-preview-text');
  const cancelReplyBtn = $('#cancel-reply-btn');

  const editModeIndicator = $('#edit-mode-indicator');
  const editModeText = $('#edit-mode-text');
  const cancelEditBtn = $('#cancel-edit-btn');

  const imageModal = $('#image-modal');
  const imageModalImg = $('#image-modal-img');
  const imageModalCaption = $('#image-modal-caption');

  const contextMenu = $('#context-menu');
  const ctxReply = $('#ctx-reply');
  const ctxEdit = $('#ctx-edit');
  const ctxDelete = $('#ctx-delete');

  // ─── Auth Switching ────────────────────────────────
  $('#show-register').addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.classList.remove('active');
    registerForm.classList.add('active');
    loginError.textContent = '';
  });

  $('#show-login').addEventListener('click', (e) => {
    e.preventDefault();
    registerForm.classList.remove('active');
    loginForm.classList.add('active');
    registerError.textContent = '';
  });

  // ─── Login ─────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.classList.add('loading');
    loginError.textContent = '';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#login-username').value.trim(),
          password: $('#login-password').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentUser = data.user;
      await enterChat();
    } catch (err) {
      loginError.textContent = err.message;
    } finally {
      btn.classList.remove('loading');
    }
  });

  // ─── Register ──────────────────────────────────────
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#register-btn');
    btn.classList.add('loading');
    registerError.textContent = '';

    const password = $('#register-password').value;
    const confirm = $('#register-confirm').value;

    if (password !== confirm) {
      registerError.textContent = 'Password tidak sama';
      btn.classList.remove('loading');
      return;
    }

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#register-username').value.trim(),
          password
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentUser = data.user;
      await enterChat();
    } catch (err) {
      registerError.textContent = err.message;
    } finally {
      btn.classList.remove('loading');
    }
  });

  // ─── Logout ────────────────────────────────────────
  $('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    if (realtimeChannel) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    currentUser = null;
    chatScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
    loginForm.classList.add('active');
    registerForm.classList.remove('active');
    $('#login-username').value = '';
    $('#login-password').value = '';
  });

  // ─── Enter Chat ────────────────────────────────────
  async function enterChat() {
    authScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');

    myUsername.textContent = currentUser.username;
    myAvatar.style.background = currentUser.avatarColor;
    myAvatar.textContent = currentUser.username[0].toUpperCase();

    // Request notification permission
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Init Supabase client
    await initSupabase();

    // Load users
    await loadUsers();

    // Switch to global chat
    switchChat('global');
  }

  // ─── Supabase Init ─────────────────────────────────
  async function initSupabase() {
    const res = await fetch('/api/config');
    const config = await res.json();

    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

    // Subscribe to new messages via Realtime (Postgres Changes)
    realtimeChannel = supabaseClient
      .channel('chat-messages')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            handleNewMessage(payload.new);
          } else if (payload.eventType === 'UPDATE') {
            handleUpdatedMessage(payload.new);
          }
        }
      )
      .subscribe();
  }

  // ─── Handle Realtime Message ───────────────────────
  function handleNewMessage(msg) {
    const isFromMe = msg.sender_id === currentUser.id;

    if (msg.is_global) {
      if (activeChat.type === 'global') {
        appendMessage(msg);
      } else {
        unreadCounts.global = (unreadCounts.global || 0) + 1;
        updateUnreadBadge('global');
      }
    } else {
      // Private message — check if it's for us
      const partnerId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;

      if (msg.sender_id !== currentUser.id && msg.receiver_id !== currentUser.id) {
        return; // Not our message
      }

      if (activeChat.type === 'private' && activeChat.userId === partnerId) {
        appendMessage(msg);
      } else {
        unreadCounts[partnerId] = (unreadCounts[partnerId] || 0) + 1;
        updateUnreadBadge(partnerId);
      }
    }

    // Play notification sound and show browser notification
    if (!isFromMe) {
      const isChatActive = msg.is_global 
        ? activeChat.type === 'global' 
        : (activeChat.type === 'private' && activeChat.userId === msg.sender_id);

      if (document.hidden || !isChatActive) {
        playNotificationSound();
        showBrowserNotification(msg);
      }
    }
  }

  // ─── Notification & Sound Utilities ────────────────
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      // Pleasant double-beep chime
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1); // A5

      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      console.error('Failed to play sound:', e);
    }
  }

  function showBrowserNotification(msg) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const title = msg.is_global 
      ? `Pesan baru di Chat Global` 
      : `Pesan pribadi dari ${msg.sender_username}`;

    let bodyText = msg.content || '';
    if (!bodyText && msg.file_url) {
      if (msg.file_type && msg.file_type.startsWith('image/')) {
        bodyText = '📷 Kirim Gambar';
      } else {
        bodyText = `📎 File: ${msg.file_name || 'Lampiran'}`;
      }
    }

    const options = {
      body: msg.is_global ? `${msg.sender_username}: ${bodyText}` : bodyText,
      tag: msg.is_global ? 'global' : `private-${msg.sender_id}`,
      renotify: true
    };

    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      if (msg.is_global) {
        switchChat('global');
      } else {
        const u = allUsers.find(user => user.id === msg.sender_id);
        const avatarColor = u ? u.avatar_color : '#6C5CE7';
        switchChat('private', msg.sender_id, msg.sender_username, avatarColor);
      }
    };
  }

  // Track rendered messages to avoid duplicates
  const renderedMessageIds = new Set();

  // ─── Load Users ────────────────────────────────────
  async function loadUsers() {
    const res = await fetch('/api/users');
    allUsers = await res.json();
    renderUsersList(allUsers);
  }

  // ─── Render Users List ─────────────────────────────
  function renderUsersList(users) {
    onlineCount.textContent = users.length;
    onlineUsersList.innerHTML = '';

    users.forEach(user => {
      const btn = document.createElement('button');
      btn.className = 'user-item';
      if (activeChat.type === 'private' && activeChat.userId === user.id) {
        btn.classList.add('active');
      }
      btn.dataset.userId = user.id;
      btn.dataset.username = user.username;

      const unread = unreadCounts[user.id] || 0;
      const badgeStyle = unread > 0 ? '' : 'display:none;';

      btn.innerHTML = `
        <div class="user-avatar" style="background:${user.avatar_color}">
          ${user.username[0].toUpperCase()}
        </div>
        <div class="user-info">
          <span class="user-name">${escapeHTML(user.username)}</span>
          <span class="user-status">Pengguna</span>
        </div>
        <span class="unread-badge" id="unread-${user.id}" style="${badgeStyle}">${unread}</span>
      `;

      btn.addEventListener('click', () => {
        switchChat('private', user.id, user.username, user.avatar_color);
        closeSidebar();
      });

      onlineUsersList.appendChild(btn);
    });
  }

  // ─── Switch Chat ───────────────────────────────────
  function switchChat(type, userId, username, avatarColor) {
    activeChat = { type, userId: userId || null, username: username || null };
    hideTyping();
    renderedMessageIds.clear();

    // Clear reply & edit states
    replyingTo = null;
    editingMessage = null;
    replyPreviewPanel.style.display = 'none';
    editModeIndicator.style.display = 'none';

    // Update sidebar active states
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    if (type === 'global') {
      globalChatBtn.classList.add('active');
      chatTitle.textContent = 'Chat Global';
      chatStatus.textContent = 'Semua pengguna';
      chatAvatar.style.background = 'linear-gradient(135deg, #6C5CE7, #A29BFE)';
      chatAvatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      unreadCounts.global = 0;
      updateUnreadBadge('global');
      loadGlobalMessages();
    } else {
      const userBtn = onlineUsersList.querySelector(`[data-user-id="${userId}"]`);
      if (userBtn) userBtn.classList.add('active');
      chatTitle.textContent = username;
      chatStatus.textContent = 'Chat pribadi';
      chatAvatar.style.background = avatarColor || '#6C5CE7';
      chatAvatar.innerHTML = `<span style="color:white;font-weight:700;font-size:1rem;">${username[0].toUpperCase()}</span>`;
      unreadCounts[userId] = 0;
      updateUnreadBadge(userId);
      loadPrivateMessages(userId);
    }

    chatMessages.innerHTML = '';
    messageInput.focus();
  }

  // ─── Load Messages ─────────────────────────────────
  async function loadGlobalMessages() {
    const res = await fetch('/api/messages/global');
    const messages = await res.json();
    renderMessages(messages);
  }

  async function loadPrivateMessages(targetUserId) {
    const res = await fetch(`/api/messages/private/${targetUserId}`);
    const messages = await res.json();
    renderMessages(messages);
  }

  // ─── Render Messages ──────────────────────────────
  function renderMessages(messages) {
    chatMessages.innerHTML = '';
    renderedMessageIds.clear();
    if (messages.length === 0) {
      chatWelcome.style.display = 'block';
      chatMessages.appendChild(chatWelcome);
      return;
    }
    chatWelcome.style.display = 'none';
    messages.forEach(msg => appendMessage(msg, false));
    scrollToBottom();
  }

  function appendMessage(msg, scroll = true) {
    if (renderedMessageIds.has(msg.id)) return;
    renderedMessageIds.add(msg.id);

    if (chatWelcome.style.display !== 'none') {
      chatWelcome.style.display = 'none';
    }

    const isMine = msg.sender_id === currentUser.id;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'sent' : 'received'}`;
    div.id = `msg-${msg.id}`;

    const time = new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const senderLabel = activeChat.type === 'global' && !isMine
      ? `<div class="msg-sender">${escapeHTML(msg.sender_username)}</div>` : '';

    let contentHTML = '';

    if (msg.is_deleted) {
      contentHTML = `
        <div class="message-deleted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          Pesan ini telah dihapus
        </div>
      `;
    } else {
      // Reply reference header
      if (msg.reply_to_id) {
        contentHTML += `
          <div class="msg-reply-ref" data-target-id="${msg.reply_to_id}">
            <div class="msg-reply-sender">${escapeHTML(msg.reply_to_username)}</div>
            <div class="msg-reply-text">${escapeHTML(msg.reply_to_content)}</div>
          </div>
        `;
      }

      if (msg.content) {
        contentHTML += `<div class="msg-text">${escapeHTML(msg.content)}</div>`;
      }

      if (msg.file_url) {
        if (msg.file_type && msg.file_type.startsWith('image/')) {
          contentHTML += `
            <div class="msg-image-wrap chat-preview-img-btn" style="cursor: pointer;">
              <img src="${msg.file_url}" alt="${escapeHTML(msg.file_name)}" class="msg-image">
            </div>
          `;
        } else {
          contentHTML += `
            <div class="msg-file-wrap">
              <div class="msg-file-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
              </div>
              <div class="msg-file-info">
                <span class="msg-file-name" title="${escapeHTML(msg.file_name)}">${escapeHTML(msg.file_name)}</span>
                <span class="msg-file-size">${formatBytes(msg.file_size)}</span>
              </div>
              <a href="${msg.file_url}" download="${escapeHTML(msg.file_name)}" target="_blank" class="msg-file-dl" title="Download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              </a>
            </div>
          `;
        }
      }
    }

    const editedBadge = msg.is_edited ? `<span class="msg-edited-badge">(diedit)</span>` : '';

    div.innerHTML = `
      ${senderLabel}
      ${contentHTML}
      <div class="msg-time">${time}${editedBadge}</div>
    `;

    // Add right-click listener
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, msg);
    });

    // Add long-press listeners for mobile
    let touchTimeout;
    div.addEventListener('touchstart', (e) => {
      touchTimeout = setTimeout(() => {
        showContextMenu(e, msg);
      }, 600);
    }, { passive: true });

    div.addEventListener('touchend', () => {
      clearTimeout(touchTimeout);
    });

    div.addEventListener('touchmove', () => {
      clearTimeout(touchTimeout);
    });

    chatMessages.appendChild(div);

    // Scroll reply reference click handler
    const replyRef = div.querySelector('.msg-reply-ref');
    if (replyRef) {
      replyRef.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = replyRef.dataset.targetId;
        const targetEl = document.getElementById(`msg-${targetId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.classList.add('highlight-pulse');
          setTimeout(() => {
            targetEl.classList.remove('highlight-pulse');
          }, 2000);
        } else {
          alert('Pesan asli tidak ditemukan di riwayat saat ini.');
        }
      });
    }

    // Image preview click handler
    const imgBtn = div.querySelector('.chat-preview-img-btn');
    if (imgBtn) {
      imgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openImagePreview(msg.file_url, msg.file_name);
      });
    }

    if (scroll) scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // ─── Unread Badge ──────────────────────────────────
  function updateUnreadBadge(id) {
    const count = unreadCounts[id] || 0;
    if (id === 'global') {
      globalUnread.textContent = count;
      globalUnread.style.display = count > 0 ? 'flex' : 'none';
    } else {
      const badge = document.getElementById(`unread-${id}`);
      if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? 'flex' : 'none';
      }
    }
  }

  // ─── Typing (via Supabase Broadcast) ───────────────
  function showTyping(username) {
    typingUsername.textContent = username;
    typingIndicator.style.display = 'flex';
  }
  function hideTyping() {
    typingIndicator.style.display = 'none';
  }

  // ─── Send Message ──────────────────────────────────
  async function sendMessage() {
    const content = messageInput.value.trim();
    if (!content && !uploadedFileUrl && !editingMessage) return;

    sendBtn.disabled = true;

    // Handle Edit Message
    if (editingMessage) {
      const editId = editingMessage.id;
      // Reset input immediately
      messageInput.value = '';
      messageInput.style.height = 'auto';
      editingMessage = null;
      editModeIndicator.style.display = 'none';

      try {
        const res = await fetch(`/api/messages/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        // Realtime will update the message block automatically
      } catch (err) {
        console.error('Failed to edit message:', err);
        alert('Gagal mengedit pesan: ' + err.message);
      } finally {
        updateSendButtonState();
      }
      return;
    }

    // Otherwise, handle new message (normal send or reply)
    messageInput.value = '';
    messageInput.style.height = 'auto';

    const tempFileUrl = uploadedFileUrl;
    const tempFile = selectedFile;
    const tempReplyTo = replyingTo;
    
    clearAttachment();
    replyingTo = null;
    replyPreviewPanel.style.display = 'none';

    try {
      const body = {
        content,
        isGlobal: activeChat.type === 'global',
        receiverId: activeChat.userId,
        receiverUsername: activeChat.username,
        fileUrl: tempFileUrl,
        fileName: tempFile ? tempFile.name : null,
        fileSize: tempFile ? tempFile.size : null,
        fileType: tempFile ? tempFile.type : null,
        replyToId: tempReplyTo ? tempReplyTo.id : null,
        replyToUsername: tempReplyTo ? tempReplyTo.username : null,
        replyToContent: tempReplyTo ? tempReplyTo.content : null
      };

      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const msg = await res.json();

      if (res.ok) {
        appendMessage(msg);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      updateSendButtonState();
    }
  }

  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    updateSendButtonState();

    // Auto-resize textarea
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  });

  // ─── File Attachment Handlers ───────────────────────
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  async function handleFileSelected(file) {
    if (!file) return;

    clearAttachment();

    selectedFile = file;
    previewName.textContent = file.name || 'Pasted File';
    previewSize.textContent = formatBytes(file.size);
    uploadPreview.style.display = 'block';
    uploadProgressFill.style.width = '0%';
    sendBtn.disabled = true;

    startProgressAnimation();

    try {
      // Determine file extension
      let ext = 'png';
      if (file.name && file.name.includes('.')) {
        ext = file.name.split('.').pop();
      } else if (file.type) {
        ext = file.type.split('/').pop();
      }
      const path = `attachments/${uuidv4()}.${ext}`;

      const { data, error } = await supabaseClient.storage
        .from('chat-attachments')
        .upload(path, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (error) throw error;

      const { data: urlData } = supabaseClient.storage
        .from('chat-attachments')
        .getPublicUrl(path);

      uploadedFileUrl = urlData.publicUrl;
      finishProgressAnimation();
      sendBtn.disabled = false;
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Gagal mengupload file: ' + err.message);
      clearAttachment();
    }
  }

  fileInput.addEventListener('change', () => {
    handleFileSelected(fileInput.files[0]);
  });

  messageInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let index in items) {
      const item = items[index];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        e.preventDefault();
        handleFileSelected(file);
        break;
      }
    }
  });

  cancelUploadBtn.addEventListener('click', () => {
    clearAttachment();
  });

  function clearAttachment() {
    clearInterval(progressInterval);
    selectedFile = null;
    uploadedFileUrl = null;
    fileInput.value = '';
    uploadPreview.style.display = 'none';
    uploadProgressFill.style.width = '0%';
    updateSendButtonState();
  }

  function startProgressAnimation() {
    clearInterval(progressInterval);
    let pct = 0;
    progressInterval = setInterval(() => {
      if (pct < 90) {
        pct += Math.random() * 12;
        uploadProgressFill.style.width = `${Math.min(pct, 90)}%`;
      }
    }, 80);
  }

  function finishProgressAnimation() {
    clearInterval(progressInterval);
    uploadProgressFill.style.width = '100%';
  }

  function updateSendButtonState() {
    if (editingMessage) {
      sendBtn.disabled = !messageInput.value.trim();
    } else {
      sendBtn.disabled = !messageInput.value.trim() && !uploadedFileUrl;
    }
  }

  // ─── Context Menu & Actions ─────────────────────────
  function showContextMenu(e, msg) {
    if (msg.is_deleted) return;
    contextMenuLastShown = Date.now();

    let x, y;
    if (e.touches && e.touches.length > 0) {
      x = e.touches[0].clientX;
      y = e.touches[0].clientY;
    } else {
      x = e.clientX;
      y = e.clientY;
    }

    contextMenu.dataset.activeMsgId = msg.id;
    contextMenu.dataset.activeMsgSenderId = msg.sender_id;
    contextMenu.dataset.activeMsgSenderUsername = msg.sender_username;
    
    let previewText = msg.content || '';
    if (!previewText && msg.file_url) {
      previewText = msg.file_type && msg.file_type.startsWith('image/') ? '📷 Gambar' : `📎 File: ${msg.file_name}`;
    }
    contextMenu.dataset.activeMsgPreview = previewText;

    const isMine = msg.sender_id === currentUser.id;
    if (isMine) {
      ctxEdit.style.display = 'flex';
      ctxDelete.style.display = 'flex';
    } else {
      ctxEdit.style.display = 'none';
      ctxDelete.style.display = 'none';
    }

    contextMenu.style.display = 'block';
    const menuWidth = contextMenu.offsetWidth;
    const menuHeight = contextMenu.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    if (x + menuWidth > windowWidth) {
      x = windowWidth - menuWidth - 10;
    }
    if (y + menuHeight > windowHeight) {
      y = windowHeight - menuHeight - 10;
    }

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    e.stopPropagation();
  }

  function handleUpdatedMessage(msg) {
    const msgEl = document.getElementById(`msg-${msg.id}`);
    if (!msgEl) return;

    if (msg.is_deleted) {
      msgEl.innerHTML = `
        <div class="message-deleted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          Pesan ini telah dihapus
        </div>
        <div class="msg-time">${new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</div>
      `;
      return;
    }

    if (msg.is_edited) {
      const textEl = msgEl.querySelector('.msg-text');
      if (textEl) {
        textEl.textContent = msg.content;
      }
      
      const timeEl = msgEl.querySelector('.msg-time');
      if (timeEl && !timeEl.querySelector('.msg-edited-badge')) {
        const badge = document.createElement('span');
        badge.className = 'msg-edited-badge';
        badge.textContent = '(diedit)';
        timeEl.appendChild(badge);
      }
    }
  }

  // Hide context menu on outer pointer actions
  document.addEventListener('pointerdown', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = 'none';
    }
  });

  // Action: Reply click
  ctxReply.addEventListener('click', () => {
    const id = contextMenu.dataset.activeMsgId;
    const username = contextMenu.dataset.activeMsgSenderUsername;
    const preview = contextMenu.dataset.activeMsgPreview;

    replyingTo = { id, username, content: preview };
    editingMessage = null;

    editModeIndicator.style.display = 'none';
    replyPreviewSender.textContent = `Balas ke ${username}`;
    replyPreviewText.textContent = preview;
    replyPreviewPanel.style.display = 'flex';

    messageInput.focus();
    contextMenu.style.display = 'none';
  });

  // Action: Edit click
  ctxEdit.addEventListener('click', () => {
    const id = contextMenu.dataset.activeMsgId;
    const msgEl = document.getElementById(`msg-${id}`);
    if (!msgEl) return;
    
    const textEl = msgEl.querySelector('.msg-text');
    const originalText = textEl ? textEl.textContent : '';

    if (!originalText) {
      alert('Hanya pesan teks yang dapat diedit.');
      contextMenu.style.display = 'none';
      return;
    }

    editingMessage = { id, content: originalText };
    replyingTo = null;

    replyPreviewPanel.style.display = 'none';
    editModeText.textContent = originalText;
    editModeIndicator.style.display = 'flex';

    messageInput.value = originalText;
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    messageInput.focus();
    
    contextMenu.style.display = 'none';
    updateSendButtonState();
  });

  // Action: Delete click
  ctxDelete.addEventListener('click', async () => {
    const id = contextMenu.dataset.activeMsgId;
    contextMenu.style.display = 'none';

    if (!confirm('Apakah Anda yakin ingin menghapus pesan ini?')) return;

    try {
      const res = await fetch(`/api/messages/${id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (err) {
      alert('Gagal menghapus pesan: ' + err.message);
    }
  });

  // Cancel reply & edit panels
  cancelReplyBtn.addEventListener('click', () => {
    replyingTo = null;
    replyPreviewPanel.style.display = 'none';
    updateSendButtonState();
  });

  cancelEditBtn.addEventListener('click', () => {
    editingMessage = null;
    editModeIndicator.style.display = 'none';
    messageInput.value = '';
    messageInput.style.height = 'auto';
    updateSendButtonState();
  });

  // ─── Image Preview Lightbox ─────────────────────────
  function openImagePreview(url, filename) {
    imageModalImg.src = url;
    imageModalCaption.textContent = filename || 'Gambar';
    imageModal.classList.add('active');
  }

  imageModal.addEventListener('click', () => {
    imageModal.classList.remove('active');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      imageModal.classList.remove('active');
    }
  });

  function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  function formatBytes(bytes, decimals = 2) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // ─── Sidebar Toggle (Mobile) ──────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  $('#sidebar-toggle').addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('active');
  });

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  }

  $('#sidebar-close').addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);

  globalChatBtn.addEventListener('click', () => {
    switchChat('global');
    closeSidebar();
  });

  // ─── Utilities ─────────────────────────────────────
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Auto-Login Check ─────────────────────────────
  (async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        await enterChat();
      }
    } catch (e) { /* not logged in */ }
  })();

})();
