// ---
// Title: Brand New Chat Server
// Author: Gemini
// Description: A completely new, from-scratch backend for a real-time chat application.
// This version uses a simplified and more robust broadcasting method to fix messaging issues.
// ---

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

app.use(express.static('public')); // Serve uploaded files

// --- Helper Functions ---
const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8').catch(() => '[]'));
const writeJson = async (filePath, data) => fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

// --- API Endpoints ---
app.get('/messages', async (req, res) => res.json(await readJson(MESSAGES_FILE)));

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

// Simple and reliable broadcast function
const broadcast = (data) => {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
};

wss.on('connection', ws => {
    console.log('Client connected.');

    ws.on('message', async (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'register':
                ws.username = data.username;
                break;

            case 'typing_start':
                broadcast({ type: 'user_typing', username: ws.username });
                break;

            case 'typing_stop':
                broadcast({ type: 'user_stop_typing', username: ws.username });
                break;

            case 'text_message':
            case 'image_message':
                const newMessage = {
                    id: uuidv4(),
                    username: ws.username,
                    timestamp: new Date().toISOString(),
                    type: data.type === 'text_message' ? 'text' : 'image',
                    content: data.content,
                };

                const messages = await readJson(MESSAGES_FILE);
                messages.push(newMessage);
                await writeJson(MESSAGES_FILE, messages);

                broadcast({ type: 'new_message', ...newMessage });
                break;
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.username || ''} disconnected.`);
        if (ws.username) {
            broadcast({ type: 'user_stop_typing', username: ws.username });
        }
    });
    ws.on('error', (err) => console.error('WebSocket error:', err));
});

// --- Server Initialization ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await writeJson(USERS_FILE, await readJson(USERS_FILE));
    await writeJson(MESSAGES_FILE, await readJson(MESSAGES_FILE));
    console.log(`Server is sparkling on port ${PORT}`);
});

