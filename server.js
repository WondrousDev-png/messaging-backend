// A simple messaging service backend using Node.js, Express, and WebSockets.
// All data is stored in local JSON files.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); 
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(cors()); 

// --- Setup for File Uploads ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Serve static files from 'public' directory, including uploads
app.use(express.static('public'));


// --- File Paths ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// --- Helper Functions to Manage JSON Data ---

/**
 * Ensures that the data and uploads directories and initial JSON files exist.
 */
async function initializeData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.access(USERS_FILE);
    } catch (error) {
        await fs.writeFile(USERS_FILE, JSON.stringify([]));
    }

    try {
        await fs.access(MESSAGES_FILE);
    } catch (error) {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify([]));
    }
    console.log('Data files and upload directory initialized.');
}

async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}


// --- API Endpoints ---

// Endpoint to get all current messages
app.get('/messages', async (req, res) => {
    const messages = await readJsonFile(MESSAGES_FILE);
    res.json(messages);
});

// Endpoint to register a new UNIQUE username
app.post('/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters long.' });
    }

    const users = await readJsonFile(USERS_FILE);
    if (users.find(u => u.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ success: false, message: 'Username is already taken. Please choose another.' });
    }

    users.push(username);
    await writeJsonFile(USERS_FILE, users);
    res.status(201).json({ success: true, message: 'Username registered successfully.' });
});

// Endpoint for handling file uploads
app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).send({ success: false, message: 'No file uploaded.' });
    }
    // The file is saved, now we return its path so the client can use it
    const filePath = `/uploads/${req.file.filename}`;
    res.status(201).send({ success: true, filePath: filePath });
});


// Create an HTTP server from the Express app
const server = http.createServer(app);

// --- WebSocket Server for Real-Time Chat ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('A new user connected!');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            let newMessage;
            
            // Determine message type and construct the message object
            if (data.type === 'chatMessage' && data.text) {
                newMessage = {
                    id: uuidv4(),
                    username: data.username,
                    type: 'text',
                    content: data.text,
                    timestamp: new Date().toISOString()
                };
            } else if (data.type === 'imageMessage' && data.filePath) {
                 newMessage = {
                    id: uuidv4(),
                    username: data.username,
                    type: 'image',
                    content: data.filePath,
                    timestamp: new Date().toISOString()
                };
            } else if (data.type === 'audioMessage' && data.filePath) {
                 newMessage = {
                    id: uuidv4(),
                    username: data.username,
                    type: 'audio',
                    content: data.filePath,
                    timestamp: new Date().toISOString()
                };
            }
            
            if (newMessage) {
                // Save the new message
                const messages = await readJsonFile(MESSAGES_FILE);
                messages.push(newMessage);
                await writeJsonFile(MESSAGES_FILE, messages);

                // Send the new message to EVERYONE connected
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) { // 1 means OPEN
                        client.send(JSON.stringify({ type: 'newChatMessage', ...newMessage }));
                    }
                });
            }
        } catch (error) {
            console.error('Failed to process message:', error);
        }
    });

    ws.on('close', () => console.log('A user disconnected.'));
    ws.on('error', (error) => console.error('WebSocket Error:', error));
});


// --- Start the Server ---
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    await initializeData(); // Make sure our data files are ready
    console.log(`Server is sparkling and running on port ${PORT}`);
});

