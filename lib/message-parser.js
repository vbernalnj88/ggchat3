// Message parser for gooning.games chat
class ChatMessageParser {
  constructor() {
    this.messageCache = new Map();
  }

  /**
   * Extract session ID from URL
   * URL format: https://gooning.games/play/mindcontrol/c80b01c7-a1a1-4aea-90c7-89e13dbc247f?spy=1
   */
  extractSessionId(url) {
    const match = url.match(/\/play\/[^\/]+\/([a-f0-9-]{36})/i);
    return match ? match[1] : null;
  }

  /**
   * Parse all messages from the chat history container
   */
  parseChatHistory(container) {
    const messages = [];
    const messageRows = container.querySelectorAll('[id], [data-message-id]');
    
    let lastFullMessage = null;

    messageRows.forEach((row) => {
      const messageId = row.id || row.getAttribute('data-message-id');
      if (!messageId) return;

      // Check if this is a continuation message (has mt-1 class, no profile-area)
      const isContinuation = row.classList.contains('mt-1') || !row.querySelector('.profile-area');
      
      // Check if this is a task/question card
      const isTask = row.classList.contains('task-card') || row.querySelector('.task-container');

      let messageData = null;

      if (isTask) {
        messageData = this.parseTaskMessage(row);
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

  /**
   * Parse a full message with profile area
   */
  parseFullMessage(row) {
    const profileArea = row.querySelector('.profile-area');
    const messageContent = row.querySelector('.message-content');
    
    if (!messageContent) return null;

    let username = '';
    let avatarUrl = '';

    if (profileArea) {
      const usernameEl = profileArea.querySelector('.username');
      const avatarEl = profileArea.querySelector('.avatar');
      
      if (usernameEl) {
        username = usernameEl.textContent.trim();
      }
      if (avatarEl) {
        avatarUrl = avatarEl.src || avatarEl.getAttribute('src');
      }
    }

    // Fallback: check for user-badge in task cards
    if (!username) {
      const userBadge = row.querySelector('.user-badge');
      if (userBadge) {
        username = userBadge.textContent.trim();
      }
    }

    const content = this.extractMessageContent(messageContent);
    const timestamp = this.extractTimestamp(row);

    return {
      id: row.id || row.getAttribute('data-message-id'),
      type: 'message',
      author: username,
      avatar: avatarUrl,
      content: content,
      timestamp: timestamp,
      rawHtml: row.outerHTML,
      continuations: []
    };
  }

  /**
   * Parse a continuation message (linked to previous full message)
   */
  parseContinuationMessage(row, lastFullMessage) {
    const messageContent = row.querySelector('.message-content');
    if (!messageContent) return null;

    const content = this.extractMessageContent(messageContent);
    const timestamp = this.extractTimestamp(row);

    const continuationData = {
      id: row.id || row.getAttribute('data-message-id'),
      type: 'continuation',
      content: content,
      timestamp: timestamp,
      rawHtml: row.outerHTML,
      linkedTo: lastFullMessage ? lastFullMessage.id : null,
      linkedAuthor: lastFullMessage ? lastFullMessage.author : 'Unknown'
    };

    return continuationData;
  }

  /**
   * Parse a task or question card message
   */
  parseTaskMessage(row) {
    const taskContainer = row.querySelector('.task-container');
    const profileArea = row.querySelector('.profile-area');
    
    let username = '';
    let avatarUrl = '';

    if (profileArea) {
      const usernameEl = profileArea.querySelector('.username');
      const userBadge = profileArea.querySelector('.user-badge');
      const avatarEl = profileArea.querySelector('.avatar');
      
      if (usernameEl) {
        username = usernameEl.textContent.trim();
      } else if (userBadge) {
        username = userBadge.textContent.trim();
      }
      
      if (avatarEl) {
        avatarUrl = avatarEl.src || avatarEl.getAttribute('src');
      }
    }

    let title = '';
    let body = '';

    if (taskContainer) {
      const titleEl = taskContainer.querySelector('h3');
      if (titleEl) {
        title = titleEl.textContent.trim();
      }
      
      const bodyElements = taskContainer.querySelectorAll('p');
      body = Array.from(bodyElements).map(el => el.textContent.trim()).join('\n');
    }

    const timestamp = this.extractTimestamp(row);

    return {
      id: row.id || row.getAttribute('data-message-id'),
      type: 'task',
      author: username,
      avatar: avatarUrl,
      title: title,
      content: body,
      timestamp: timestamp,
      rawHtml: row.outerHTML
    };
  }

  /**
   * Extract text content from message content element
   */
  extractMessageContent(contentEl) {
    const paragraphs = contentEl.querySelectorAll('p');
    if (paragraphs.length > 0) {
      return Array.from(paragraphs).map(p => p.textContent.trim()).join('\n');
    }
    return contentEl.textContent.trim();
  }

  /**
   * Extract timestamp from message row
   */
  extractTimestamp(row) {
    // Try to find timestamp in various locations
    const timeEl = row.querySelector('time, .timestamp, [class*="time"]');
    if (timeEl) {
      return timeEl.textContent.trim() || timeEl.getAttribute('datetime');
    }
    return new Date().toISOString();
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatMessageParser;
}
