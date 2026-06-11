// Popup script for Chat Archiver extension
let currentView = 'users';
let currentUser = null;
let currentSessionId = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupImportButton();
  loadUsers();
});

// Setup navigation tabs
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const viewName = tab.getAttribute('data-view');
      switchView(viewName);
    });
  });
  
  // Setup back buttons
  const backToAllSessionsBtn = document.getElementById('back-to-all-sessions-btn');
  if (backToAllSessionsBtn) {
    backToAllSessionsBtn.addEventListener('click', showAllSessionsView);
  }
  
  const backToSessionsBtn = document.getElementById('back-to-sessions-btn');
  if (backToSessionsBtn) {
    backToSessionsBtn.addEventListener('click', backToSessions);
  }
  
  const backToUsersBtn = document.getElementById('back-to-users-btn');
  if (backToUsersBtn) {
    backToUsersBtn.addEventListener('click', backToUsers);
  }
}

// Setup import button
function setupImportButton() {
  const importBtn = document.getElementById('import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', importChatData);
  }
}

// Switch between views
function switchView(viewName) {
  // Update tab states
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-view') === viewName);
  });

  // Update view visibility
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });
  document.getElementById(`${viewName}-view`).classList.add('active');

  currentView = viewName;

  // Load data based on view
  if (viewName === 'users') {
    loadUsers();
  } else if (viewName === 'sessions') {
    // Only call showAllSessionsView if we're not already showing user sessions
    if (!currentUser) {
      showAllSessionsView();
    }
  } else if (viewName === 'profile' || viewName === 'messages') {
    // These views are loaded programmatically, no action needed here
  }
}

// Load all users
async function loadUsers() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getUsers' });
    
    if (response.success && response.users.length > 0) {
      const userList = document.getElementById('user-list');
      userList.innerHTML = '';

      response.users.forEach(user => {
        const li = document.createElement('li');
        li.className = 'user-item';
        
        // Check if userId is different from username (i.e., we have a @username)
        const hasAtUsername = user.userId && user.userId !== user.username && user.userId.startsWith('@');
        const displayName = user.username || user.userId;
        const atUsername = hasAtUsername ? user.userId : null;
        
        li.innerHTML = `
          <div class="user-name">
            ${escapeHtml(displayName)}
            ${atUsername ? `<span class="profile-field" title="@username">@${escapeHtml(atUsername.substring(1))}</span>` : ''}
            <span class="profile-field" title="Click to edit profile" data-edit-profile="${escapeHtml(user.userId)}">✏️</span>
          </div>
          <div class="user-meta">${user.sessions.length} session(s)</div>
        `;
        // Click on list item shows user sessions
        li.addEventListener('click', (e) => {
          // Don't trigger if clicking the edit button
          if (!e.target.hasAttribute('data-edit-profile')) {
            showUserSessions(user.userId);
          }
        });
        
        // Click on edit icon opens profile editor
        const editBtn = li.querySelector('[data-edit-profile]');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openUserProfile(user.userId);
          });
        }
        
        userList.appendChild(li);
      });
    } else {
      showEmptyState('user-list', 'No users found. Start syncing chats!');
    }
  } catch (error) {
    console.error('Error loading users:', error);
    showEmptyState('user-list', 'Error loading users');
  }
}

// Show all sessions (deprecated - use showAllSessionsView instead)
async function showAllSessions() {
  // This function is deprecated, use showAllSessionsView instead
  console.warn('showAllSessions is deprecated, use showAllSessionsView');
  showAllSessionsView();
}

// Show sessions for a specific user (accepts userId which is the stable @username)
async function showUserSessions(userId) {
  currentUser = userId;
  
  // Switch to sessions view
  switchView('sessions');

  try {
    const response = await chrome.runtime.sendMessage({ 
      action: 'getUserSessions', 
      username: userId 
    });
    
    if (!response.success) {
      console.error('Failed to get user sessions:', response.error);
      alert('Error loading sessions: ' + response.error);
      return;
    }
    
    if (response.sessions.length === 0) {
      alert('No sessions found for this user');
      return;
    }
    
    // Clear previous content first
    document.getElementById('all-sessions').style.display = 'none';
    document.getElementById('user-sessions').style.display = 'block';
    document.getElementById('current-user').textContent = userId;

    const sessionList = document.getElementById('user-session-list');
    sessionList.innerHTML = '';

    // Remove any previously appended messages sections
    const existingMsgSections = document.querySelectorAll('#user-sessions > div[style*="margin-top"]');
    existingMsgSections.forEach(el => el.remove());

    response.sessions.forEach(session => {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.innerHTML = `
        <div class="session-title">Session: ${session.sessionId.substring(0, 8)}...</div>
        <div class="session-meta">
          ${session.messageCount} messages • ${new Date(session.lastSynced).toLocaleDateString()}
        </div>
        <div class="session-meta" style="margin-top: 4px;">
          ${session.participants.length} total participant(s)
        </div>
      `;
      li.addEventListener('click', () => showSessionMessages(session.sessionId));
      sessionList.appendChild(li);
    });
    
    // Add user's messages section below sessions
    const messagesSection = document.createElement('div');
    messagesSection.style.marginTop = '20px';
    messagesSection.style.borderTop = '1px solid rgba(255,255,255,0.1)';
    messagesSection.style.paddingTop = '12px';
    messagesSection.innerHTML = `<h4 style="font-size: 13px; color: #667eea; margin-bottom: 12px;">${userId}'s Messages</h4>`;
    
    const messageContainer = document.createElement('div');
    messageContainer.id = 'user-messages-container';
    messageContainer.style.maxHeight = '300px';
    messageContainer.style.overflowY = 'auto';
    messageContainer.innerHTML = '<div style="font-size: 12px; color: #666; padding: 12px;">Loading messages...</div>';
    messagesSection.appendChild(messageContainer);
    document.getElementById('user-sessions').appendChild(messagesSection);
    
    // Get all messages from all sessions for this user
    const allUserMessages = [];
    for (const session of response.sessions) {
      try {
        const sessionMsgs = await chrome.runtime.sendMessage({
          action: 'getSessionMessages',
          sessionId: session.sessionId
        });
        
        if (sessionMsgs.success && Array.isArray(sessionMsgs.messages)) {
          // Filter by authorId (stable @username) first, then fallback to author (display name)
          const userMsgs = sessionMsgs.messages.filter(m => m.authorId === userId || m.author === userId);
          userMsgs.forEach(m => {
            m._sessionId = session.sessionId; // Track which session
            allUserMessages.push(m);
          });
        }
      } catch (err) {
        console.error(`Error loading messages for session ${session.sessionId}:`, err);
      }
    }
    
    // Sort by timestamp
    allUserMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Update message container
    messageContainer.innerHTML = '';
    
    if (allUserMessages.length > 0) {
      // Group by session
      const messagesBySession = new Map();
      allUserMessages.forEach(msg => {
        if (!messagesBySession.has(msg._sessionId)) {
          messagesBySession.set(msg._sessionId, []);
        }
        messagesBySession.get(msg._sessionId).push(msg);
      });
      
      messagesBySession.forEach((msgs, sessionId) => {
        const sessionDiv = document.createElement('div');
        sessionDiv.style.marginBottom = '16px';
        sessionDiv.style.background = 'rgba(102, 126, 234, 0.1)';
        sessionDiv.style.borderRadius = '6px';
        sessionDiv.style.padding = '8px';
        sessionDiv.style.cursor = 'pointer';
        
        const sessionHeader = document.createElement('div');
        sessionHeader.style.fontSize = '11px';
        sessionHeader.style.color = '#667eea';
        sessionHeader.style.fontWeight = '600';
        sessionHeader.style.marginBottom = '8px';
        sessionHeader.textContent = `Session: ${sessionId.substring(0, 8)}... (${msgs.length} messages)`;
        sessionHeader.title = 'Click to view full session';
        sessionHeader.addEventListener('click', (e) => {
          e.stopPropagation();
          showSessionMessages(sessionId);
        });
        
        sessionDiv.appendChild(sessionHeader);
        
        msgs.forEach(msg => {
          const msgDiv = document.createElement('div');
          msgDiv.style.fontSize = '12px';
          msgDiv.style.padding = '4px 0';
          msgDiv.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
          msgDiv.style.color = '#d0d0d0';
          msgDiv.textContent = msg.content || msg.body || '';
          msgDiv.title = new Date(msg.timestamp).toLocaleString();
          sessionDiv.appendChild(msgDiv);
        });
        
        messageContainer.appendChild(sessionDiv);
      });
    } else {
      messageContainer.innerHTML = '<div style="font-size: 12px; color: #666; padding: 12px;">No messages found</div>';
    }
  } catch (error) {
    console.error('Error loading user sessions:', error);
    alert('Error loading sessions: ' + error.message);
  }
}

// Show all sessions view (called from HTML onclick)
function showAllSessionsView() {
  // Reset currentUser when showing all sessions
  currentUser = null;
  document.getElementById('all-sessions').style.display = 'block';
  document.getElementById('user-sessions').style.display = 'none';
  // Remove any previously appended messages sections
  const existingMsgSections = document.querySelectorAll('#user-sessions > div[style*="margin-top"]');
  existingMsgSections.forEach(el => el.remove());
  loadAllSessionsList();
}

// Load all sessions into the list
async function loadAllSessionsList() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getUsers' });
    
    if (!response.success) {
      console.error('Failed to get users:', response.error);
      showEmptyState('session-list', 'Error loading sessions');
      return;
    }
    
    const sessionList = document.getElementById('session-list');
    sessionList.innerHTML = '';

    const sessionMap = new Map();
    
    // Group sessions by ID
    response.users.forEach(user => {
      user.sessions.forEach(session => {
        if (!sessionMap.has(session.sessionId)) {
          sessionMap.set(session.sessionId, {
            sessionId: session.sessionId,
            lastSynced: session.lastSynced,
            messageCount: session.messageCount,
            participants: []
          });
        }
        // Use userId (stable @username) for participant tracking
        if (!sessionMap.get(session.sessionId).participants.includes(user.userId)) {
          sessionMap.get(session.sessionId).participants.push(user.userId);
        }
      });
    });

    if (sessionMap.size > 0) {
      sessionMap.forEach((session, sessionId) => {
        const li = document.createElement('li');
        li.className = 'session-item';
        li.innerHTML = `
          <div class="session-title">Session: ${sessionId.substring(0, 8)}...</div>
          <div class="session-meta">
            ${session.participants.length} participant(s) • ${session.messageCount} messages
          </div>
          <div class="session-meta" style="margin-top: 4px;">
            Participants: ${session.participants.slice(0, 5).join(', ')}${session.participants.length > 5 ? '...' : ''}
          </div>
        `;
        li.addEventListener('click', () => showSessionMessages(sessionId));
        sessionList.appendChild(li);
      });
    } else {
      showEmptyState('session-list', 'No sessions found. Start syncing chats!');
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
    showEmptyState('session-list', 'Error loading sessions: ' + error.message);
  }
}

// Show messages for a session
async function showSessionMessages(sessionId) {
  currentSessionId = sessionId;
  
  try {
    const response = await chrome.runtime.sendMessage({ 
      action: 'getSessionMessages', 
      sessionId: sessionId 
    });
    
    if (!response.success) {
      alert('Error loading messages: ' + (response.error || 'Unknown error'));
      return;
    }
    
    switchView('messages');
    
    const container = document.getElementById('message-container');
    container.innerHTML = '';

    const messages = Array.isArray(response.messages) ? response.messages : [];
    
    if (messages.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages in this session</div>';
      return;
    }

    // Get user profiles for inline display
    const profiles = await loadUserProfiles(messages.map(m => m.author).filter(Boolean));

    // Process messages to group continuations with their parent messages
    const processedMessages = [];
    let lastMessage = null;
    
    for (const msg of messages) {
      // Treat both 'continuation' and 'task-continuation' types as continuations
      if ((msg.type === 'continuation' || msg.type === 'task-continuation') && lastMessage) {
        // Append continuation content to the last message
        lastMessage.content = (lastMessage.content || '') + '\n' + (msg.content || msg.body || '');
        // Update timestamp if continuation is newer
        if (new Date(msg.timestamp) > new Date(lastMessage.timestamp)) {
          lastMessage.timestamp = msg.timestamp;
        }
      } else {
        // Regular message, add to processed list
        processedMessages.push(msg);
        lastMessage = msg;
      }
    }

    processedMessages.forEach(msg => {
      const div = document.createElement('div');
      div.className = 'message-item';
      
      let typeBadge = '';
      if (msg.type === 'task') {
        typeBadge = '<span class="message-type-badge badge-task">Task</span>';
      }

      const authorDisplay = msg.author || 'Unknown';
      const authorId = msg.authorId || null;
      
      // DEBUG LOGGING
      console.log('[Popup Debug] Message author info:', {
        authorDisplay: authorDisplay,
        authorId: authorId,
        atUsername: msg.atUsername,
        fullMessage: msg
      });
      
      const profile = profiles[authorDisplay] || {};
      const inlineInfo = [];
      
      if (profile.age) inlineInfo.push(profile.age);
      if (profile.gender) inlineInfo.push(profile.gender);
      
      const inlineHtml = inlineInfo.length > 0 
        ? `<span class="profile-field">${inlineInfo.join(' • ')}</span>` 
        : '';
      
      // Check if authorId is different from author (i.e., we have a @username)
      // authorId is the stable @username without the '@' prefix
      const hasAtUsername = authorId && authorId !== authorDisplay;
      const atUsernameHtml = hasAtUsername 
        ? `<span class="profile-field" title="@username">@${escapeHtml(authorId)}</span>` 
        : '';

      div.innerHTML = `
        <div class="message-header">
          <span class="message-author" data-username="${escapeHtml(authorDisplay)}" data-userid="${escapeHtml(authorId || '')}">
            ${escapeHtml(authorDisplay)}${atUsernameHtml}${inlineHtml}${typeBadge}
          </span>
          <span class="message-timestamp">${formatTimestamp(msg.timestamp)}</span>
        </div>
        <div class="message-content" style="white-space: pre-wrap;">${escapeHtml(msg.content || msg.body || '')}</div>
      `;

      // Add click handler for username
      const authorEl = div.querySelector('.message-author');
      if (authorEl) {
        authorEl.addEventListener('click', (e) => {
          e.stopPropagation();
          // Use authorId (stable @username) if available, otherwise fall back to author display name
          const username = authorEl.getAttribute('data-userid') || authorEl.getAttribute('data-username');
          openUserProfile(username);
        });
      }

      container.appendChild(div);
    });
  } catch (error) {
    console.error('Error loading session messages:', error);
    alert('Error loading messages: ' + error.message);
  }
}

// Load user profiles
async function loadUserProfiles(usernames) {
  const profiles = {};
  
  for (const username of [...new Set(usernames)]) {
    try {
      const response = await chrome.runtime.sendMessage({ 
        action: 'getUserProfile', 
        username: username 
      });
      
      if (response.success) {
        profiles[username] = response.profile;
      }
    } catch (error) {
      console.error(`Error loading profile for ${username}:`, error);
    }
  }
  
  return profiles;
}

// Open user profile editor
async function openUserProfile(username) {
  try {
    const response = await chrome.runtime.sendMessage({ 
      action: 'getUserProfile', 
      username: username 
    });
    
    if (response.success) {
      const profile = response.profile;
      
      document.getElementById('profile-username').textContent = username;
      document.getElementById('profile-alias').value = profile.alias || '';
      document.getElementById('profile-tags').value = profile.tags || '';
      document.getElementById('profile-gender').value = profile.gender || '';
      document.getElementById('profile-age').value = profile.age || '';
      document.getElementById('profile-kinks').value = profile.kinks || '';
      
      switchView('profile');
    }
  } catch (error) {
    console.error('Error loading user profile:', error);
    alert('Error loading profile');
  }
}

// Back to users from profile
function backToUsers() {
  switchView('users');
}

// Back to sessions from messages
function backToSessions() {
  if (currentUser) {
    document.getElementById('all-sessions').style.display = 'none';
    document.getElementById('user-sessions').style.display = 'block';
  } else {
    showAllSessionsView();
  }
}

// Save user profile
document.getElementById('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('profile-username').textContent;
  const profileData = {
    alias: document.getElementById('profile-alias').value,
    tags: document.getElementById('profile-tags').value,
    gender: document.getElementById('profile-gender').value,
    age: document.getElementById('profile-age').value,
    kinks: document.getElementById('profile-kinks').value
  };
  
  try {
    const response = await chrome.runtime.sendMessage({ 
      action: 'updateUserProfile', 
      username: username,
      profileData: profileData
    });
    
    if (response.success) {
      alert('Profile saved successfully!');
      backToUsers();
    } else {
      alert('Error saving profile: ' + response.error);
    }
  } catch (error) {
    console.error('Error saving profile:', error);
    alert('Error saving profile');
  }
});

// Import chat data
async function importChatData() {
  console.log('[Import] importChatData called');
  const text = document.getElementById('import-text').value.trim();
  let sessionId = document.getElementById('import-session-id').value.trim();
  
  console.log('[Import] Text length:', text.length);
  console.log('[Import] Session ID:', sessionId);
  
  if (!text) {
    alert('Please paste some chat text to import');
    return;
  }
  
  // Generate session ID if not provided
  if (!sessionId) {
    sessionId = generateUUID();
    console.log('[Import] Generated session ID:', sessionId);
  }
  
  try {
    const messages = parseImportedText(text, sessionId);
    console.log('[Import] Parsed messages:', messages.length);
    
    if (messages.length === 0) {
      alert('No messages could be parsed from the input. Please check the format.');
      return;
    }
    
    const response = await chrome.runtime.sendMessage({ 
      action: 'importChatData',
      data: {
        sessionId: sessionId,
        messages: messages
      }
    });
    
    console.log('[Import] Response:', response);
    
    if (response.success) {
      alert(`Successfully imported ${response.messageCount} messages from ${response.userCount} user(s)!`);
      document.getElementById('import-text').value = '';
      document.getElementById('import-session-id').value = '';
      switchView('users');
    } else {
      alert('Error importing: ' + response.error);
    }
  } catch (error) {
    console.error('[Import] Error importing chat:', error);
    alert('Error importing chat data: ' + error.message);
  }
}

// Parse imported text format: "username:time message" or "username:time\nmessage"
function parseImportedText(text, sessionId) {
  console.log('[Parse] Starting to parse text');
  const messages = [];
  const lines = text.split('\n');
  let currentMessage = null;
  let messageIdCounter = 0;
  
  // Regex to match username:time pattern
  const messagePattern = /^([^:]+):\s*(.+?)$/;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    const match = trimmedLine.match(messagePattern);
    
    if (match) {
      // Save previous message if exists
      if (currentMessage) {
        messages.push(currentMessage);
      }
      
      // Start new message
      const username = match[1].trim();
      const timeOrContent = match[2].trim();
      
      // Check if this is just a time (e.g., "08 PM") or actual content
      const isTimeOnly = /^\d{1,2}\s*(AM|PM|am|pm)/i.test(timeOrContent);
      
      currentMessage = {
        id: `${sessionId}-${messageIdCounter++}`,
        type: 'message',
        author: username,
        content: isTimeOnly ? '' : timeOrContent,
        timestamp: new Date().toISOString(),
        rawHtml: ''
      };
    } else if (currentMessage) {
      // This is a continuation of the previous message
      if (currentMessage.content) {
        currentMessage.content += '\n' + trimmedLine;
      } else {
        currentMessage.content = trimmedLine;
      }
    }
  }
  
  // Don't forget the last message
  if (currentMessage) {
    messages.push(currentMessage);
  }
  
  console.log('[Parse] Parsed', messages.length, 'messages');
  return messages;
}

// Helper functions
function escapeHtml(text) {
  if (!text) return '';
  // Don't escape if it's already plain text with emojis
  // Just escape dangerous HTML characters but preserve emojis
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'No date';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    console.warn('Invalid timestamp:', timestamp);
    return 'Invalid Date';
  }
  return date.toLocaleString();
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function showEmptyState(elementId, message) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8zm7.5-4a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1H7V4.5a.5.5 0 0 1 .5-.5z"/>
        </svg>
        <p>${message}</p>
      </div>
    `;
  }
}

// Make functions globally available (not needed anymore since we use addEventListener)
// window.showUserSessions = showUserSessions;
// window.showAllSessionsView = showAllSessionsView;
// window.showSessionMessages = showSessionMessages;
// window.backToUsers = backToUsers;
// window.backToSessions = backToSessions;
// window.importChatData = importChatData;
