// Content script for Chat Archiver extension
(function() {
  'use strict';

  // Username lookup map: displayName -> @username
  const usernameLookup = new Map();
  
  // Polling interval for checking profile modal (in ms)
  const PROFILE_MODAL_POLL_INTERVAL = 1000;
  
  // Track if polling is active
  let profileModalPollingActive = false;
  let profileModalPoller = null;

  // Import the parser (will be concatenated during build or loaded separately)
  class ChatMessageParser {
    constructor() {
      this.messageCache = new Map();
    }

    extractSessionId(url) {
      const match = url.match(/\/play\/[^\/]+\/([a-f0-9-]{36})/i);
      return match ? match[1] : null;
    }

    parseChatHistory(container) {
      const messages = [];
      // Find all message rows by data-message-id attribute
      const messageRows = container.querySelectorAll('[data-message-id]');
      
      let lastFullMessage = null;

      messageRows.forEach((row) => {
        const messageId = row.getAttribute('data-message-id');
        if (!messageId) return;

        // Check for continuation: has mt-1 class OR lacks avatar button
        const hasAvatar = row.querySelector('button[aria-label*="profile"]');
        const isContinuation = row.classList.contains('mt-1') || !hasAvatar;
        
        // Check for task/question card - treat as continuation if no real author
        const isTask = row.querySelector('[class*="Question"]') || 
                      row.querySelector('[class*="task-container"]') ||
                      row.querySelector('.border-l-4.border-blue-500');
        
        // If it's a task but has no real author (no avatar), treat as continuation
        const isTaskWithoutAuthor = isTask && !hasAvatar;

        let messageData = null;

        if (isTaskWithoutAuthor) {
          // Treat task without author as a continuation of the last message
          messageData = this.parseContinuationMessage(row, lastFullMessage, true);
        } else if (isContinuation) {
          messageData = this.parseContinuationMessage(row, lastFullMessage);
        } else {
          messageData = this.parseFullMessage(row);
          if (messageData) {
            lastFullMessage = messageData;
          }
        }

        if (messageData) {
          messages.push(messageData);
        }
      });

      return messages;
    }

    parseFullMessage(row) {
      // Find the main content area (the div after the avatar button)
      const contentArea = row.querySelector('div.min-w-0.flex-1');
      
      // Find username from the button in the flex wrapper, NOT from the reply mention
      // The real username is in a button with text-left class that's a direct child of the mb-1 flex div
      // NOT inside a group/reply button
      let usernameEl = null;
      let usernameButton = null;
      if (contentArea) {
        // Look for the mb-1 flex container that holds the real username
        // This is the div that contains the actual message author's name and timestamp
        const messageHeaderDiv = contentArea.querySelector('div.mb-1.flex.flex-wrap.items-baseline');
        
        if (messageHeaderDiv) {
          // The real username button is BEFORE the timestamp span in this container
          const usernameButton = messageHeaderDiv.querySelector('button.text-left');
          if (usernameButton) {
            usernameEl = usernameButton.querySelector('span.truncate') || usernameButton.querySelector('span.inline-flex');
          }
        }
        
        // Fallback: if we couldn't find via the header div, search all text-left buttons
        // but skip any that are inside group/reply or ARE group/reply
        if (!usernameEl) {
          const usernameButtons = contentArea.querySelectorAll('button.text-left');
          for (const btn of usernameButtons) {
            // Skip if this button IS a reply container or is inside one
            let isReplyButton = btn.classList && (btn.classList.contains('group\\/reply') || btn.classList.contains('group/reply'));
            
            if (!isReplyButton) {
              let parent = btn.parentElement;
              while (parent && parent !== contentArea) {
                if (parent.classList && (parent.classList.contains('group\\/reply') || parent.classList.contains('group/reply'))) {
                  isReplyButton = true;
                  break;
                }
                parent = parent.parentElement;
              }
            }
            
            if (!isReplyButton) {
              usernameEl = btn.querySelector('span.truncate') || btn.querySelector('span.inline-flex');
              if (usernameEl) break;
            }
          }
        }
      }
      
      // Fallback to direct truncate span if no button found
      if (!usernameEl && contentArea) {
        usernameEl = contentArea.querySelector(':scope > div.mb-1 > button.text-left span.truncate');
      }
      
      const username = usernameEl ? usernameEl.textContent.trim() : '';
      
      // Extract the permanent @username from the button or its parent link
      // This is the stable identifier that doesn't change when users change their display name
      let atUsername = '';
      if (usernameButton) {
        // Check if button has data-at-username or similar attribute
        atUsername = usernameButton.getAttribute('data-at-username') || 
                     usernameButton.getAttribute('data-username') ||
                     usernameButton.getAttribute('aria-label')?.match(/@([\w-]+)/)?.[1] || '';
        
        // If not on button, check if button is wrapped in an anchor tag with @username in href
        if (!atUsername) {
          const parentLink = usernameButton.closest('a[href]');
          if (parentLink) {
            const hrefMatch = parentLink.href.match(/@([\w-]+)/i);
            if (hrefMatch) {
              atUsername = hrefMatch[1];
            }
          }
        }
        
        // If still not found, check for @username in any parent element's attributes
        if (!atUsername) {
          let parent = usernameButton.parentElement;
          while (parent && parent !== contentArea) {
            const hrefAttr = parent.getAttribute('href');
            if (hrefAttr) {
              const hrefMatch = hrefAttr.match(/@([\w-]+)/i);
              if (hrefMatch) {
                atUsername = hrefMatch[1];
                break;
              }
            }
            parent = parent.parentElement;
          }
        }
      }
      
      // NEW: Try to get @username from our lookup map if we have the display name
      if (!atUsername && username) {
        const lookedUpUsername = usernameLookup.get(username);
        if (lookedUpUsername) {
          atUsername = lookedUpUsername;
          console.log('[Chat Archiver] Found @username from lookup:', username, '->', '@' + atUsername);
        }
      }
      
      // Use @username as the unique identifier if available, otherwise fall back to display username
      const uniqueAuthorId = atUsername || username;
      
      // Auto-inject @username badge if we found one via lookup and it's not already in the DOM
      if (atUsername && username && contentArea) {
        const messageHeaderDiv = contentArea.querySelector('div.mb-1.flex.flex-wrap.items-baseline');
        if (messageHeaderDiv) {
          const usernameButton = messageHeaderDiv.querySelector('button.text-left');
          if (usernameButton) {
            const usernameSpan = usernameButton.querySelector('span.truncate') || usernameButton.querySelector('span.inline-flex');
            if (usernameSpan) {
              const parentSpan = usernameSpan.parentElement;
              const existingBadge = parentSpan?.nextElementSibling?.classList?.contains('lm-username-badge') ? 
                                   parentSpan.nextElementSibling : null;
              
              if (!existingBadge) {
                const badge = document.createElement('span');
                badge.className = 'lm-username-badge';
                badge.textContent = '@' + atUsername;
                badge.style.cssText = `
                  margin-left: 6px;
                  padding: 2px 6px;
                  background: rgba(168, 85, 247, 0.15);
                  color: #d8b4fe;
                  border-radius: 4px;
                  font-size: 10px;
                  font-weight: 600;
                  letter-spacing: 0.02em;
                  white-space: nowrap;
                `;
                
                if (parentSpan) {
                  parentSpan.insertAdjacentElement('afterend', badge);
                }
              }
            }
          }
        }
      }
      
      // Find avatar from img or div with initials
      const avatarImg = row.querySelector('img[alt=""]');
      const avatarInitialsDiv = row.querySelector('div.flex.h-8.w-8');
      let avatarUrl = '';
      if (avatarImg) {
        avatarUrl = avatarImg.src || avatarImg.getAttribute('src') || '';
      } else if (avatarInitialsDiv) {
        // Use initials as placeholder
        avatarUrl = avatarInitialsDiv.textContent.trim();
      }
      
      // Find message content from p tag - use innerHTML to preserve emojis
      // But first check if this message is inside a reply button (task mention)
      const contentEl = row.querySelector('p.text-sm.text-gray-200');
      let content = '';
      if (contentEl) {
        // Check if this content element is inside a group/reply button (task/user mention)
        let isInsideReplyMention = false;
        let parent = contentEl.parentElement;
        while (parent && parent !== contentArea) {
          if (parent.classList && (parent.classList.contains('group\\/reply') || parent.classList.contains('group/reply'))) {
            isInsideReplyMention = true;
            break;
          }
          parent = parent.parentElement;
        }
        
        if (!isInsideReplyMention) {
          content = contentEl.innerHTML.trim();
        }
      }
      
      // Find timestamp
      const timestampEl = row.querySelector('span.tabular-nums');
      let timestamp;
      if (timestampEl) {
        const timestampText = timestampEl.textContent.trim();
        // Try to parse the timestamp string into a valid ISO date
        const parsedDate = new Date(timestampText);
        timestamp = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
      } else {
        timestamp = new Date().toISOString();
      }

      if (!username && !content) return null;

      return {
        id: row.getAttribute('data-message-id'),
        type: 'message',
        author: username,
        authorId: uniqueAuthorId,  // Stable identifier that doesn't change with display name
        atUsername: atUsername || null,  // The @username if found
        avatar: avatarUrl,
        content: content,
        timestamp: timestamp,
        rawHtml: row.outerHTML,
        continuations: []
      };
    }

    parseContinuationMessage(row, lastFullMessage, isTask = false) {
      // Continuation messages have pl-10 div with nested content
      const pl10Div = row.querySelector('.pl-10');
      const contentDiv = pl10Div ? pl10Div.querySelector('div') || pl10Div : row;
      
      // Try to find content in various ways
      let content = '';
      const contentP = contentDiv.querySelector('p');
      if (contentP) {
        content = contentP.innerHTML.trim(); // Use innerHTML to preserve emojis
      } else {
        // Get text content excluding badge elements
        const badgeEl = contentDiv.querySelector('[class*="Question"]');
        if (badgeEl) {
          // Extract content after the badge - use innerHTML for emojis
          const allText = contentDiv.innerHTML;
          const badgeHtml = badgeEl.outerHTML;
          // Remove the badge HTML and get remaining content
          content = allText.replace(badgeHtml, '').trim();
          // Strip any remaining HTML tags but keep emoji entities
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = content;
          content = tempDiv.textContent || tempDiv.innerText || '';
        } else {
          content = contentDiv.textContent.trim();
        }
      }
      
      const timestampEl = row.querySelector('span.tabular-nums');
      let timestamp;
      if (timestampEl) {
        const timestampText = timestampEl.textContent.trim();
        const parsedDate = new Date(timestampText);
        timestamp = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
      } else {
        timestamp = new Date().toISOString();
      }

      return {
        id: row.getAttribute('data-message-id'),
        type: isTask ? 'task-continuation' : 'continuation',
        content: content,
        timestamp: timestamp,
        rawHtml: row.outerHTML,
        linkedTo: lastFullMessage ? lastFullMessage.id : null,
        linkedAuthor: lastFullMessage ? lastFullMessage.author : 'Unknown'
      };
    }

    parseTaskMessage(row) {
      // Find author from the rounded pill badge or truncate span
      const authorBadge = row.querySelector('span.max-w-\\[10rem\\]');
      const usernameEl = row.querySelector('span.truncate');
      const username = authorBadge ? authorBadge.textContent.trim() : (usernameEl ? usernameEl.textContent.trim() : '');
      
      // Find avatar
      const avatarImg = row.querySelector('img[alt=""]');
      const avatarInitialsDiv = row.querySelector('div.flex.h-8.w-8');
      let avatarUrl = '';
      if (avatarImg) {
        avatarUrl = avatarImg.src || avatarImg.getAttribute('src') || '';
      } else if (avatarInitialsDiv) {
        avatarUrl = avatarInitialsDiv.textContent.trim();
      }
      
      // Find task/question title
      const questionBadge = row.querySelector('[class*="Question"]');
      const title = questionBadge ? 'Question' : 'Task';
      
      // Find task content - use innerHTML to preserve emojis
      const contentDiv = row.querySelector('.pl-10') || row;
      const contentP = contentDiv.querySelector('p');
      const content = contentP ? contentP.innerHTML.trim() : contentDiv.textContent.trim().replace(title, '').trim();
      
      const timestampEl = row.querySelector('span.tabular-nums');
      let timestamp;
      if (timestampEl) {
        const timestampText = timestampEl.textContent.trim();
        // Try to parse the timestamp string into a valid ISO date
        const parsedDate = new Date(timestampText);
        timestamp = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
      } else {
        timestamp = new Date().toISOString();
      }

      return {
        id: row.getAttribute('data-message-id'),
        type: 'task',
        author: username,
        avatar: avatarUrl,
        title: title,
        content: content,
        timestamp: timestamp,
        rawHtml: row.outerHTML
      };
    }
  }

  const parser = new ChatMessageParser();
  let syncButton = null;
  let isSyncing = false;

  // Find the chat history container
  function findChatHistory() {
    // Based on the provided HTML structure, look for the specific container
    // The messages are inside: div.absolute.inset-0.overflow-x-hidden.overflow-y-auto.p-3
    const selectors = [
      'div.absolute.inset-0.overflow-x-hidden.overflow-y-auto.p-3',
      '[class*="overflow-y-auto"]',
      '.chat-history',
      '[data-chat-overlay-control]',
      '[class*="chat"]'
    ];

    for (const selector of selectors) {
      const container = document.querySelector(selector);
      if (container) {
        // Return the container that holds the message rows
        // Messages are direct children with data-message-id
        return container;
      }
    }
    
    // Fallback: look for any div containing elements with data-message-id
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      if (div.querySelector('[data-message-id]')) {
        return div;
      }
    }
    
    return null;
  }

  // Create or get the sync button
  function createSyncButton() {
    if (syncButton) return syncButton;

    syncButton = document.createElement('button');
    syncButton.id = 'chat-archiver-sync';
    syncButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 8a6 6 0 1 1-1.7-4.2M14 2v4h-4"/>
      </svg>
      Sync Chat
    `;
    syncButton.style.cssText = `
      position: fixed;
      bottom: 100px;
      right: 380px;
      z-index: 9999;
      padding: 10px 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: all 0.2s ease;
    `;
    
    syncButton.addEventListener('mouseenter', () => {
      syncButton.style.transform = 'scale(1.05)';
      syncButton.style.boxShadow = '0 6px 16px rgba(0,0,0,0.4)';
    });
    
    syncButton.addEventListener('mouseleave', () => {
      syncButton.style.transform = 'scale(1)';
      syncButton.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    });

    syncButton.addEventListener('click', handleSyncClick);

    document.body.appendChild(syncButton);
    return syncButton;
  }

  // Handle sync button click
  async function handleSyncClick() {
    if (isSyncing) return;
    
    isSyncing = true;
    syncButton.disabled = true;
    syncButton.innerHTML = `
      <svg class="animate-spin" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="8 8"/>
      </svg>
      Syncing...
    `;

    try {
      const sessionId = parser.extractSessionId(window.location.href);
      console.log('[Chat Archiver] Session ID:', sessionId);
      
      if (!sessionId) {
        throw new Error('Could not extract session ID from URL');
      }

      const chatContainer = findChatHistory();
      console.log('[Chat Archiver] Chat container found:', !!chatContainer);
      
      if (!chatContainer) {
        throw new Error('Could not find chat history container');
      }

      // Debug: count message elements
      const allMessages = chatContainer.querySelectorAll('[data-message-id]');
      console.log('[Chat Archiver] Found message elements:', allMessages.length);
      
      const messages = parser.parseChatHistory(chatContainer);
      console.log('[Chat Archiver] Parsed messages:', messages);
      
      if (messages.length === 0) {
        console.warn('[Chat Archiver] No messages parsed! Check selectors.');
      }
      
      // Send to background script for storage and server sync
      const response = await chrome.runtime.sendMessage({
        action: 'syncChat',
        sessionId: sessionId,
        messages: messages,
        url: window.location.href,
        timestamp: new Date().toISOString()
      });

      showNotification(`Successfully synced ${messages.length} messages!`, 'success');
      console.log('[Chat Archiver] Sync complete:', response);
    } catch (error) {
      console.error('[Chat Archiver] Sync failed:', error);
      showNotification(`Sync failed: ${error.message}`, 'error');
    } finally {
      isSyncing = false;
      syncButton.disabled = false;
      syncButton.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 8a6 6 0 1 1-1.7-4.2M14 2v4h-4"/>
        </svg>
        Sync Chat
      `;
    }
  }

  // Show notification
  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      padding: 12px 20px;
      background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#667eea'};
      color: white;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transition = 'opacity 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Initialize
  function init() {
    console.log('[Chat Archiver] Initializing...');
    
    // Wait for page to load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(createSyncButton, 1000);
        startProfileModalPolling();
      });
    } else {
      setTimeout(createSyncButton, 1000);
      startProfileModalPolling();
    }

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'getChatData') {
        const sessionId = parser.extractSessionId(window.location.href);
        const chatContainer = findChatHistory();
        
        if (chatContainer) {
          const messages = parser.parseChatHistory(chatContainer);
          sendResponse({ success: true, sessionId, messages });
        } else {
          sendResponse({ success: false, error: 'Chat container not found' });
        }
      }
      return true;
    });
  }

  // Poll for profile modal and extract username mappings
  function startProfileModalPolling() {
    if (profileModalPollingActive) return;
    
    profileModalPollingActive = true;
    console.log('[Chat Archiver] Starting profile modal polling...');
    
    profileModalPoller = setInterval(() => {
      // Look for #mp-profile-heading anywhere on the page (more reliable than looking for modal)
      const profileHeading = document.querySelector('h3#mp-profile-heading');
      
      if (profileHeading) {
        // Extract display name from the heading span
        const displayNameEl = profileHeading.querySelector('span.min-w-0.whitespace-nowrap') || 
                              profileHeading.querySelector('span.truncate');
        const displayName = displayNameEl ? displayNameEl.textContent.trim() : '';
        
        // Extract @username from the href of the link following mp-profile-heading (most reliable)
        let atUsername = '';
        const profileLink = profileHeading.querySelector('a[href*="/profile/"]');
        if (profileLink) {
          const hrefMatch = profileLink.href.match(/\/profile\/([@\w-]+)/i);
          if (hrefMatch) {
            atUsername = hrefMatch[1].replace(/^@/, '');
          }
        }
        
        // Fallback: try to extract @username from the paragraph below the heading
        if (!atUsername) {
          // Look for the paragraph sibling that contains @username
          const usernameEl = profileHeading.parentElement?.querySelector('p.text-xs.text-gray-500') ||
                             profileHeading.closest('[class*="flex-col"]')?.querySelector('p.text-xs.text-gray-500');
          if (usernameEl) {
            const usernameText = usernameEl.textContent.trim();
            // Remove the @ symbol if present
            atUsername = usernameText.replace(/^@/, '');
          }
        }
        
        // Store the mapping if we have both values
        if (displayName && atUsername) {
          if (!usernameLookup.has(displayName) || usernameLookup.get(displayName) !== atUsername) {
            usernameLookup.set(displayName, atUsername);
            console.log('[Chat Archiver] Learned username mapping:', displayName, '->', '@' + atUsername);
            
            // Update any existing messages with this display name to show the @username
            updateMessagesWithUsername(displayName, atUsername);
          }
        }
      }
    }, PROFILE_MODAL_POLL_INTERVAL);
  }
  
  // Update messages in the chat to show @username next to display name
  function updateMessagesWithUsername(displayName, atUsername) {
    // Find all message rows with this display name
    const messageRows = document.querySelectorAll('[data-message-id]');
    
    messageRows.forEach((row) => {
      // Check if this message has the matching display name
      // Use the same selector logic as parseFullMessage to find the username
      const contentArea = row.querySelector('div.min-w-0.flex-1');
      let usernameEl = null;
      
      if (contentArea) {
        const messageHeaderDiv = contentArea.querySelector('div.mb-1.flex.flex-wrap.items-baseline');
        if (messageHeaderDiv) {
          const usernameButton = messageHeaderDiv.querySelector('button.text-left');
          if (usernameButton) {
            usernameEl = usernameButton.querySelector('span.truncate') || usernameButton.querySelector('span.inline-flex');
          }
        }
      }
      
      if (usernameEl && usernameEl.textContent.trim() === displayName) {
        // Check if we already added the @username badge
        const parentSpan = usernameEl.parentElement;
        const existingBadge = parentSpan?.querySelector('.lm-username-badge') || 
                             parentSpan?.nextElementSibling?.classList?.contains('lm-username-badge') ? 
                             parentSpan.nextElementSibling : null;
        
        if (!existingBadge) {
          // Create the @username badge
          const badge = document.createElement('span');
          badge.className = 'lm-username-badge';
          badge.textContent = '@' + atUsername;
          badge.style.cssText = `
            margin-left: 6px;
            padding: 2px 6px;
            background: rgba(168, 85, 247, 0.15);
            color: #d8b4fe;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.02em;
            white-space: nowrap;
          `;
          
          // Insert after the display name span's parent inline-flex
          if (parentSpan) {
            parentSpan.insertAdjacentElement('afterend', badge);
          }
        } else {
          // Update existing badge if username changed
          existingBadge.textContent = '@' + atUsername;
        }
      }
    });
  }

  // Stop profile modal polling
  function stopProfileModalPolling() {
    if (profileModalPoller) {
      clearInterval(profileModalPoller);
      profileModalPoller = null;
      profileModalPollingActive = false;
      console.log('[Chat Archiver] Stopped profile modal polling');
    }
  }

  init();
})();
