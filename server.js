// A simple messaging service backend using Node.js, Express, and WebSockets.
// All data is stored in local JSON files.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); // <-- ADD THIS LINE

const app = express();
app.use(express.json());
app.use(cors()); // <-- AND ADD THIS LINE. This enables CORS for all requests.

// You can still keep this line if you want to be able to visit your Render URL directly
app.use(express.static('public'));


// --- File Paths ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// --- Helper Functions to Manage JSON Data ---

/**
 * Ensures that the data directory and initial JSON files exist.
 * This function creates the files if they are missing.
 */
async function initializeDataFiles() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true }); // Create 'data' folder if it doesn't exist
        await fs.access(USERS_FILE);
    } catch (error) {
        await fs.writeFile(USERS_FILE, JSON.stringify([])); // Create empty users file
    }

    try {
        await fs.access(MESSAGES_FILE);
    } catch (error) {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify([])); // Create empty messages file
    }
    console.log('Data files initialized.');
}

async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading from ${filePath}:`, error);
        return [];
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error writing to ${filePath}:`, error);
    }
}


// --- API Endpoints ---
// These are like a menu that the front-end can order from.

// Endpoint to get all current messages
app.get('/messages', async (req, res) => {
    const messages = await readJsonFile(MESSAGES_FILE);
    res.json(messages);
});

// Endpoint to register a new username
app.post('/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim().length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters long.' });
    }

    const users = await readJsonFile(USERS_FILE);
    if (users.includes(username)) {
        // If username is taken, it's not a critical error, we can let the user log in.
        return res.status(200).json({ success: true, message: 'Welcome back!' });
    }

    users.push(username);
    await writeJsonFile(USERS_FILE, users);
    res.status(201).json({ success: true, message: 'Username registered successfully.' });
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

            if (data.type === 'chatMessage' && data.text) {
                const newMessage = {
                    id: uuidv4(),
                    username: data.username,
                    text: data.text,
                    timestamp: new Date().toISOString()
                };
                
                // Save the new message
                const messages = await readJsonFile(MESSAGES_FILE);
                messages.push(newMessage);
                await writeJsonFile(MESSAGES_FILE, messages);

                // Send the new message to EVERYONE connected
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) { // 1 means the connection is OPEN
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
    await initializeDataFiles(); // Make sure our data files are ready
    console.log(`Server is sparkling and running on port ${PORT}`);
});

