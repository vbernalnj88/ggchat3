// Background service worker for Chat Archiver extension
const SERVER_URL = 'http://localhost:7337';

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncChat') {
    handleSyncChat(request)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'getUsers') {
    handleGetUsers()
      .then(users => sendResponse({ success: true, users }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getUserSessions') {
    handleGetUserSessions(request.username)
      .then(sessions => sendResponse({ success: true, sessions }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getSessionMessages') {
    handleGetSessionMessages(request.sessionId)
      .then(sessionData => sendResponse({ success: true, messages: sessionData.messages }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'getUserProfile') {
    handleGetUserProfile(request.username)
      .then(profile => sendResponse({ success: true, profile }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'updateUserProfile') {
    handleUpdateUserProfile(request.username, request.profileData)
      .then(profile => sendResponse({ success: true, profile }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (request.action === 'importChatData') {
    handleImportChatData(request.data)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// Handle chat sync
async function handleSyncChat(data) {
  const { sessionId, messages, url, timestamp } = data;
  
  try {
    // Store in Chrome storage
    const storageKey = `session_${sessionId}`;
    const existingData = await chrome.storage.local.get([storageKey]);
    
    const storedMessages = existingData[storageKey] || { messages: [], users: new Set(), userAliases: {} };
    
    // Merge messages and track unique users by their stable authorId (@username)
    const allMessages = [...storedMessages.messages];
    const userSet = new Set(storedMessages.users || []);
    const userAliases = storedMessages.userAliases || {};  // Maps authorId -> display names
    
    messages.forEach(msg => {
      // Check if message already exists
      const exists = allMessages.some(m => m.id === msg.id);
      if (!exists) {
        allMessages.push(msg);
        
        // Use authorId (stable @username) if available, otherwise fall back to author (display name)
        const userId = msg.authorId || msg.author;
        if (userId) {
          userSet.add(userId);
          
          // Track the mapping between authorId and display name
          if (msg.authorId && msg.author) {
            if (!userAliases[msg.authorId]) {
              userAliases[msg.authorId] = new Set();
            }
            userAliases[msg.authorId].add(msg.author);
          }
        } else if (msg.author) {
          // Fallback for messages without authorId
          userSet.add(msg.author);
        }
      }
    });
    
    // Convert Sets to Arrays for storage
    const serializedUserAliases = {};
    Object.keys(userAliases).forEach(key => {
      serializedUserAliases[key] = Array.from(userAliases[key]);
    });
    
    const sessionData = {
      sessionId,
      url,
      lastSynced: timestamp,
      messages: allMessages,
      users: Array.from(userSet),
      userAliases: serializedUserAliases
    };
    
    await chrome.storage.local.set({ [storageKey]: sessionData });
    
    // Also store a list of all sessions
    const allSessions = await chrome.storage.local.get(['allSessions']);
    const sessionsList = allSessions.allSessions || [];
    
    if (!sessionsList.includes(sessionId)) {
      sessionsList.push(sessionId);
      await chrome.storage.local.set({ allSessions: sessionsList });
    }
    
    // Send to local server
    try {
      const serverResponse = await fetch(`${SERVER_URL}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionData)
      });
      
      if (serverResponse.ok) {
        console.log('[Chat Archiver] Server sync successful');
      } else {
        console.warn('[Chat Archiver] Server sync returned non-OK status');
      }
    } catch (serverError) {
      console.warn('[Chat Archiver] Server unavailable, data stored locally only:', serverError.message);
    }
    
    return {
      success: true,
      messageCount: allMessages.length,
      userCount: userSet.size
    };
  } catch (error) {
    console.error('[Chat Archiver] Sync failed:', error);
    throw error;
  }
}

// Get all users from all sessions
async function handleGetUsers() {
  try {
    const allSessions = await chrome.storage.local.get(['allSessions']);
    const sessionsList = allSessions.allSessions || [];
    
    const userSet = new Set();
    const userSessionsMap = new Map();
    const userDisplayNamesMap = new Map();  // Maps authorId to most recent display name
    
    for (const sessionId of sessionsList) {
      const sessionData = await chrome.storage.local.get([`session_${sessionId}`]);
      const data = sessionData[`session_${sessionId}`];
      
      if (data && data.users) {
        data.users.forEach(userId => {
          userSet.add(userId);
          if (!userSessionsMap.has(userId)) {
            userSessionsMap.set(userId, []);
          }
          userSessionsMap.get(userId).push({
            sessionId,
            lastSynced: data.lastSynced,
            messageCount: data.messages?.length || 0
          });
          
          // Track display names from userAliases
          if (data.userAliases && data.userAliases[userId]) {
            const aliases = data.userAliases[userId];
            // Use the most recent alias as the display name
            userDisplayNamesMap.set(userId, aliases[aliases.length - 1]);
          }
        });
      }
    }
    
    const users = Array.from(userSet).map(userId => ({
      userId,  // Stable @username identifier
      username: userDisplayNamesMap.get(userId) || userId,  // Display name (most recent alias or userId)
      sessions: userSessionsMap.get(userId) || []
    }));
    
    return users;
  } catch (error) {
    console.error('[Chat Archiver] Get users failed:', error);
    throw error;
  }
}

// Get sessions for a specific user (by userId or username)
async function handleGetUserSessions(username) {
  try {
    const allSessions = await chrome.storage.local.get(['allSessions']);
    const sessionsList = allSessions.allSessions || [];
    const userSessions = [];
    
    for (const sessionId of sessionsList) {
      const sessionData = await chrome.storage.local.get([`session_${sessionId}`]);
      const data = sessionData[`session_${sessionId}`];
      
      if (data && data.users && data.users.includes(username)) {
        userSessions.push({
          sessionId,
          url: data.url,
          lastSynced: data.lastSynced,
          messageCount: data.messages?.length || 0,
          participants: data.users
        });
      }
    }
    
    return userSessions;
  } catch (error) {
    console.error('[Chat Archiver] Get user sessions failed:', error);
    throw error;
  }
}

// Get messages for a specific session
async function handleGetSessionMessages(sessionId) {
  try {
    const sessionData = await chrome.storage.local.get([`session_${sessionId}`]);
    const data = sessionData[`session_${sessionId}`];
    
    if (!data) {
      throw new Error('Session not found');
    }
    
    return {
      sessionId: data.sessionId,
      url: data.url,
      lastSynced: data.lastSynced,
      messages: data.messages || [],
      participants: data.users || []
    };
  } catch (error) {
    console.error('[Chat Archiver] Get session messages failed:', error);
    throw error;
  }
}

// Get user profile (now accepts userId or username)
async function handleGetUserProfile(username) {
  try {
    const profiles = await chrome.storage.local.get(['userProfiles']);
    const allProfiles = profiles.userProfiles || {};
    
    // Try to get profile by userId first, then by username
    return allProfiles[username] || {
      username,
      alias: '',
      tags: '',
      gender: '',
      age: '',
      kinks: ''
    };
  } catch (error) {
    console.error('[Chat Archiver] Get user profile failed:', error);
    throw error;
  }
}

// Update user profile (now uses userId as key)
async function handleUpdateUserProfile(username, profileData) {
  try {
    const profiles = await chrome.storage.local.get(['userProfiles']);
    const allProfiles = profiles.userProfiles || {};
    
    // Use the provided username (which should be the stable userId) as the key
    allProfiles[username] = {
      ...allProfiles[username],
      username,
      ...profileData
    };
    
    await chrome.storage.local.set({ userProfiles: allProfiles });
    
    return allProfiles[username];
  } catch (error) {
    console.error('[Chat Archiver] Update user profile failed:', error);
    throw error;
  }
}

// Import chat data from manual entry
async function handleImportChatData(data) {
  try {
    const { sessionId, messages } = data;
    
    if (!sessionId || !messages) {
      throw new Error('Invalid import data');
    }
    
    // Store in Chrome storage
    const storageKey = `session_${sessionId}`;
    const existingData = await chrome.storage.local.get([storageKey]);
    
    const storedMessages = existingData[storageKey] || { messages: [], users: new Set(), userAliases: {} };
    
    const allMessages = [...storedMessages.messages];
    const userSet = new Set(storedMessages.users || []);
    const userAliases = storedMessages.userAliases || {};
    
    messages.forEach(msg => {
      const exists = allMessages.some(m => m.id === msg.id);
      if (!exists) {
        allMessages.push(msg);
        
        // Use authorId (stable @username) if available, otherwise fall back to author
        const userId = msg.authorId || msg.author;
        if (userId) {
          userSet.add(userId);
          
          // Track the mapping between authorId and display name
          if (msg.authorId && msg.author) {
            if (!userAliases[msg.authorId]) {
              userAliases[msg.authorId] = new Set();
            }
            userAliases[msg.authorId].add(msg.author);
          }
        } else if (msg.author) {
          userSet.add(msg.author);
        }
      }
    });
    
    // Convert Sets to Arrays for storage
    const serializedUserAliases = {};
    Object.keys(userAliases).forEach(key => {
      serializedUserAliases[key] = Array.from(userAliases[key]);
    });
    
    const sessionData = {
      sessionId,
      url: `manual-import-${sessionId}`,
      lastSynced: new Date().toISOString(),
      messages: allMessages,
      users: Array.from(userSet),
      userAliases: serializedUserAliases
    };
    
    await chrome.storage.local.set({ [storageKey]: sessionData });
    
    // Update sessions list
    const allSessions = await chrome.storage.local.get(['allSessions']);
    const sessionsList = allSessions.allSessions || [];
    
    if (!sessionsList.includes(sessionId)) {
      sessionsList.push(sessionId);
      await chrome.storage.local.set({ allSessions: sessionsList });
    }
    
    return {
      success: true,
      messageCount: allMessages.length,
      userCount: userSet.size
    };
  } catch (error) {
    console.error('[Chat Archiver] Import failed:', error);
    throw error;
  }
}
