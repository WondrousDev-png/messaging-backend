const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cors());

// Serve static client
app.use(express.static(path.join(__dirname, 'public')));

// --- File Storage Setup ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// --- Helper Functions ---
const readJson = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return [];
  }
};
const writeJson = async (filePath, data) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

// In-memory messages store (kept in sync with messages.json)
let messages = [];

// --- API Endpoints ---
// Returns current messages (from memory)
app.get('/messages', async (req, res) => {
  res.json(messages);
});

// Optional REST endpoint to post messages
app.post('/messages', async (req, res) => {
  const { username, text, type = 'text' } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ message: 'text is required' });
  }
  const newMessage = {
    id: uuidv4(),
    username: username || 'anon',
    timestamp: new Date().toISOString(),
    type: type === 'image' ? 'image' : 'text',
    content: text,
  };
  messages.push(newMessage);
  try { await writeJson(MESSAGES_FILE, messages); } catch (e) { console.error('persist error', e); }
  broadcastMessages(); // send full updated list to all WS clients
  res.status(201).json(newMessage);
});

app.post('/register', async (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ message: 'Username must be at least 2 characters.' });
  }
  const users = await readJson(USERS_FILE);
  if (users.find(u => u.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ message: 'This username is already taken.' });
  }
  users.push(username);
  await writeJson(USERS_FILE, users);
  res.status(201).json({ success: true });
});

app.post('/upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  res.status(201).json({ success: true, filePath: `/uploads/${req.file.filename}` });
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

// Broadcast helper: sends the full messages array to all connected clients
const broadcastMessages = () => {
  const payload = JSON.stringify({ type: 'messages_update', messages });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (e) { /* ignore send errors */ }
    }
  });
};

wss.on('connection', ws => {
  console.log('Client connected.');

  // Send full message list on new connection
  try { ws.send(JSON.stringify({ type: 'messages_update', messages })); } catch (e) { /* ignore */ }

  ws.on('message', async (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    switch (data.type) {
      case 'register':
        ws.username = data.username;
        break;

      case 'typing_start':
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'user_typing', username: ws.username }));
          }
        });
        break;

      case 'typing_stop':
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'user_stop_typing', username: ws.username }));
          }
        });
        break;

      case 'text_message':
      case 'image_message': {
        const newMessage = {
          id: uuidv4(),
          username: ws.username || 'anon',
          timestamp: new Date().toISOString(),
          type: data.type === 'image_message' ? 'image' : 'text',
          content: data.content,
        };

        // update in-memory and persist
        messages.push(newMessage);
        try { await writeJson(MESSAGES_FILE, messages); } catch (err) { console.error('Persist error:', err); }

        // broadcast the full updated messages list so clients always refresh
        broadcastMessages();
        break;
      }

      case 'messages_fetch':
        try { ws.send(JSON.stringify({ type: 'messages_update', messages })); } catch (e) { /* ignore */ }
        break;

      default:
        // ignore unknown types
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Client ${ws.username || ''} disconnected.`);
    if (ws.username) {
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'user_stop_typing', username: ws.username }));
        }
      });
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
});

// Constant heartbeat: always push messages_update so clients refresh no matter what
setInterval(() => {
  broadcastMessages();
}, 1000);

// --- Server Initialization ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  // ensure user/messages files exist and load messages into memory
  await writeJson(USERS_FILE, await readJson(USERS_FILE));
  await writeJson(MESSAGES_FILE, await readJson(MESSAGES_FILE));
  messages = await readJson(MESSAGES_FILE);

  console.log(`Server is sparkling on port ${PORT}`);
});