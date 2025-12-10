# ANURAG Bot Panel

## Overview
A Facebook Messenger Group Bot Panel that allows users to control various group features like group name locking, nickname locking, and photo locking.

## Project Structure
- `index.js` - Main Express server with Socket.io for real-time communication
- `bot.js` - Facebook Messenger bot logic using ws3-fca library
- `public/index.html` - Frontend panel UI
- `users/` - Directory storing user appstates, logs, and locks (auto-created)

## Running the Application
The app runs on port 5000. Start with:
```bash
node index.js
```

## Bot Commands
- `/anurag` - Show help
- `/groupname on <name>` - Lock group name
- `/groupname off` - Unlock group name
- `/nicknames on <nick>` - Lock all nicknames
- `/nicknames off` - Unlock nicknames
- `/photolock on` - Lock current group photo
- `/photolock off` - Unlock group photo
- `/photolock reset` - Restore locked photo

## Dependencies
- express - Web server
- socket.io - Real-time WebSocket communication
- ws3-fca - Facebook Chat API wrapper
- https-proxy-agent - Proxy support

## Recent Changes
- 2024-12-10: Initial Replit environment setup
  - Added `"type": "module"` to package.json for ES modules
  - Changed port to 5000 for Replit compatibility
  - Removed conflicting Express keepalive server from bot.js
