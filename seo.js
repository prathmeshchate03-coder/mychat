// JenChat SEO & Blog Manager - Zero Dependencies
const fs = require('fs');
const path = require('path');

// Mock blog data for initial content
const BLOG_POSTS = {
  'how-to-create-private-chat-room': {
    title: 'How to Create a Private Chat Room in JenChat',
    description: 'Learn how to easily set up an encrypted, private room for secure messaging with your friends using JenChat.',
    keywords: 'private chat, secure messaging, guest chat, anonymous chat room',
    content: '<h1>How to Create a Private Chat Room</h1><p>Creating a private space is easy. Simply use the prefix "p-" when creating a room name (e.g., p-mysecretroom). The first person to enter becomes the room owner and gains kick privileges.</p>'
  },
  'benefits-of-anonymous-chatting': {
    title: 'The Benefits of Anonymous Online Chatting',
    description: 'Discover why anonymous chatting environments offer better freedom of expression and secure casual spaces.',
    keywords: 'anonymous chat, identity protection, guest login, chat online',
    content: '<h1>The Benefits of Anonymous Chatting</h1><p>Anonymous chatting allows users to share ideas freely without personal data tracking. With no registration required, your privacy is fully protected from the start.</p>'
  }
};

function getMetaTags(pageData) {
  return `
  <title>${pageData.title}</title>
  <meta name="description" content="${pageData.description}">
  <meta name="keywords" content="${pageData.keywords}">
  <meta property="og:title" content="${pageData.title}">
  <meta property="og:description" content="${pageData.description}">
  <meta name="robots" content="index, follow">
  `;
}

module.exports = { BLOG_POSTS, getMetaTags };
