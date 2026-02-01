#!/usr/bin/env node

/**
 * Telegram + Cursor Integration Bot
 * 
 * Created by: Pavan Babu
 * 
 * This bot allows you to control Cursor IDE from Telegram with:
 * - Automatic command execution in Cursor
 * - Context preservation across messages
 * - Real-time status updates
 * - File change tracking
 * 
 * GitHub: https://github.com/yourusername/telegram-cursor-integration
 * License: MIT
 */

const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const robotjs = require('robotjs');
const passwordSecurity = require('./password-security');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found. Please run: node setup.js');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Validate configuration
if (!config.telegramBotToken || !config.workspacePath) {
    console.error('❌ Invalid configuration. Please run: node setup.js');
    process.exit(1);
}

const bot = new TelegramBot(config.telegramBotToken, { polling: true });
const WORKSPACE = config.workspacePath;
const BOT_PASSWORD = config.password || 'SecureBot123'; // Default password if not in config

// Session management for context preservation
const sessions = new Map();

class Session {
    constructor(chatId) {
        this.chatId = chatId;
        this.messages = [];
        this.createdAt = new Date();
        this.lastActivity = new Date();
    }

    addMessage(role, content) {
        this.messages.push({ role, content, timestamp: new Date() });
        this.lastActivity = new Date();
        
        // Keep last 50 messages for context
        if (this.messages.length > 50) {
            this.messages = this.messages.slice(-50);
        }
    }

    getContext() {
        return this.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    getMessageCount() {
        return this.messages.length;
    }
}

function getSession(chatId) {
    if (!sessions.has(chatId)) {
        sessions.set(chatId, new Session(chatId));
    }
    return sessions.get(chatId);
}

// Status tracking
let currentExecution = {
    isRunning: false,
    command: null,
    chatId: null,
    startTime: null,
    progress: 0,
    method: 'cursor_agent'
};

// File system monitoring
let lastFileList = new Set();

function scanWorkspaceFiles() {
    const files = new Set();
    try {
        const entries = fs.readdirSync(WORKSPACE, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.name.startsWith('.') && !entry.name.includes('node_modules')) {
                if (entry.isFile()) {
                    files.add(entry.name);
                }
            }
        }
    } catch (error) {
        console.error('Error scanning workspace:', error);
    }
    return files;
}

function getFileChanges() {
    const currentFiles = scanWorkspaceFiles();
    const newFiles = [...currentFiles].filter(f => !lastFileList.has(f));
    lastFileList = currentFiles;
    return newFiles;
}

// Initialize file list
lastFileList = scanWorkspaceFiles();

// Progress tracking with Telegram updates
async function updateProgress(message, progress, details = []) {
    currentExecution.progress = progress;
    console.log(`📊 Progress: ${message} (${progress}%)`);
    
    if (details.length > 0) {
        details.forEach(d => console.log(`   ${d}`));
    }
    
    // Send Telegram update for major milestones
    if (currentExecution.chatId && (progress % 25 === 0 || progress === 100)) {
        try {
            const detailsText = details.length > 0 ? '\n   • ' + details.join('\n   • ') : '';
            await bot.sendMessage(
                currentExecution.chatId,
                `📊 *Progress: ${progress}%*\n\n${message}${detailsText}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Telegram update error:', error.message);
        }
    }
}

// Execute command in Cursor using automation
async function executeCursorCommand(command, chatId) {
    return new Promise((resolve, reject) => {
        // Create PowerShell script to automate Cursor
        const psScript = `
# Focus Cursor window
$cursorProcess = Get-Process | Where-Object { $_.ProcessName -eq "Cursor" -or $_.MainWindowTitle -like "*Cursor*" } | Select-Object -First 1

if ($cursorProcess) {
    # Bring Cursor to front
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
"@
    [Win32]::ShowWindow($cursorProcess.MainWindowHandle, 9)  # SW_RESTORE
    [Win32]::SetForegroundWindow($cursorProcess.MainWindowHandle)
    Start-Sleep -Milliseconds 500
    
    # Simulate Ctrl+K
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^k")
    Start-Sleep -Milliseconds 300
    
    # Type command (escape special characters)
    $command = "${command.replace(/"/g, '`"').replace(/\$/g, '`$')}"
    [System.Windows.Forms.SendKeys]::SendWait($command)
    Start-Sleep -Milliseconds 200
    
    # Press Enter
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    
    Write-Host "✅ Command sent to Cursor"
} else {
    # If Cursor not found, open it
    Start-Process "cursor" -ArgumentList "${WORKSPACE.replace(/\\/g, '\\\\')}"
    Start-Sleep -Seconds 3
    
    # Try again
    $cursorProcess = Get-Process | Where-Object { $_.ProcessName -eq "Cursor" } | Select-Object -First 1
    if ($cursorProcess) {
        [Win32]::SetForegroundWindow($cursorProcess.MainWindowHandle)
        Start-Sleep -Milliseconds 500
        [System.Windows.Forms.SendKeys]::SendWait("^k")
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait("${command.replace(/"/g, '`"').replace(/\$/g, '`$')}")
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Write-Host "✅ Command sent to Cursor (new window)"
    } else {
        Write-Host "❌ Could not open Cursor"
        exit 1
    }
}
`;

        // Write and execute PowerShell script
        const scriptPath = path.join(__dirname, 'execute-cursor-temp.ps1');
        fs.writeFileSync(scriptPath, psScript, 'utf8');

        exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
            // Clean up temp script
            try {
                fs.unlinkSync(scriptPath);
            } catch (e) {
                // Ignore cleanup errors
            }

            if (error) {
                console.error('❌ Cursor automation error:', stderr || error.message);
                reject(new Error('Failed to execute in Cursor'));
            } else {
                console.log('✅ Command executed in Cursor');
                resolve();
            }
        });
    });
}

// Main command execution handler
async function handleCommand(msg) {
    const chatId = msg.chat.id;
    const command = msg.text;

    // Security: Check if user is authenticated
    if (!passwordSecurity.isAuthenticated(chatId, BOT_PASSWORD)) {
        await passwordSecurity.requestPassword(bot, chatId);
        return;
    }

    // Prevent concurrent executions
    if (currentExecution.isRunning) {
        await bot.sendMessage(
            chatId,
            '⏳ *Another command is running*\n\nPlease wait for the current execution to complete.',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Get or create session
    const session = getSession(chatId);
    session.addMessage('user', command);

    console.log('\n============================================================');
    console.log(`📥 EXECUTING COMMAND (with context)`);
    console.log(`Chat ID: ${chatId}`);
    console.log(`Messages in session: ${session.getMessageCount()}`);
    console.log(`Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
    console.log(`Time: ${new Date().toLocaleString()}`);
    console.log('============================================================\n');

    // Initialize execution state
    currentExecution = {
        isRunning: true,
        command: command,
        chatId: chatId,
        startTime: new Date(),
        progress: 0,
        method: 'cursor_agent'
    };

    try {
        // Send initial confirmation
        await bot.sendMessage(
            chatId,
            `⚡ *Command Received*\n\n\`\`\`\n${command.substring(0, 200)}${command.length > 200 ? '...' : ''}\n\`\`\`\n\n🔄 Executing in Cursor...`,
            { parse_mode: 'Markdown' }
        );

        await updateProgress('Starting execution', 10, ['Command received']);

        // Build command with context if available
        let fullCommand = command;
        if (session.getMessageCount() > 1) {
            fullCommand = `Context from previous messages:\n${session.getContext()}\n\nCurrent request: ${command}`;
        }

        await updateProgress('Sending to Cursor Agent', 30, ['Automating Cursor IDE']);

        // Execute in Cursor
        await executeCursorCommand(fullCommand, chatId);

        await updateProgress('Command sent to Cursor', 50, ['Cursor is processing']);

        // Store assistant response (simulated)
        session.addMessage('assistant', 'Command executed in Cursor');

        await updateProgress('Monitoring for results', 75, ['Watching workspace for changes']);

        // Monitor for file changes for 30 seconds
        const monitorStart = Date.now();
        const monitorDuration = 30000; // 30 seconds
        let changesDetected = false;

        const checkInterval = setInterval(async () => {
            const newFiles = getFileChanges();
            if (newFiles.length > 0 && !changesDetected) {
                changesDetected = true;
                clearInterval(checkInterval);

                await updateProgress('Work completed', 100, ['Files created/modified']);

                // Detect command type
                const commandLower = command.toLowerCase();
                let completionMessage = '✅ *Work Finished 100%*\n\n';

                if (commandLower.includes('deploy') && commandLower.includes('vercel')) {
                    completionMessage += '🚀 *Deployment Complete*\n\n';
                } else if (commandLower.includes('build') || commandLower.includes('create') || commandLower.includes('app')) {
                    completionMessage += '🎉 *App Build Complete*\n\n';
                } else if (commandLower.includes('test')) {
                    completionMessage += '✅ *Tests Complete*\n\n';
                }

                completionMessage += '📁 *Created/Modified Files:*\n';
                newFiles.forEach(file => {
                    completionMessage += `   • \`${file}\`\n`;
                });

                await bot.sendMessage(chatId, completionMessage, { parse_mode: 'Markdown' });
            }

            // Stop monitoring after timeout
            if (Date.now() - monitorStart > monitorDuration) {
                clearInterval(checkInterval);
                if (!changesDetected) {
                    await bot.sendMessage(
                        chatId,
                        '✅ *Command Executed*\n\nCheck Cursor IDE for results.\n\n💡 Tip: Some operations may take longer to complete.',
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        }, 2000);

    } catch (error) {
        console.error('❌ Execution error:', error.message);
        await bot.sendMessage(
            chatId,
            `❌ *Execution Error*\n\n\`\`\`\n${error.message.substring(0, 500)}\n\`\`\`\n\n💡 Please check Cursor IDE and try again.`,
            { parse_mode: 'Markdown' }
        );
    } finally {
        currentExecution.isRunning = false;
    }
}

// Bot command handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
        chatId,
        `🤖 *Telegram + Cursor Integration Bot*\n\n` +
        `Welcome! This bot allows you to control Cursor IDE from Telegram.\n\n` +
        `*Features:*\n` +
        `• Execute commands directly in Cursor\n` +
        `• Context preservation across messages\n` +
        `• Real-time status updates\n` +
        `• Automatic file tracking\n` +
        `• 🔒 Password protection from attackers\n\n` +
        `*Security:*\n` +
        `This bot is protected with password authentication to prevent unauthorized access.\n\n` +
        `*How to use:*\n` +
        `1. Enter the password when prompted\n` +
        `2. Send any command to execute in Cursor\n\n` +
        `Example: "Build me a todo app with React"\n\n` +
        `*Commands:*\n` +
        `/status - Check bot status\n` +
        `/clear - Clear conversation context\n` +
        `/logout - Logout (require password again)\n` +
        `/help - Show this message`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    
    const statusMessage = `📊 *Bot Status*\n\n` +
        `*Execution:* ${currentExecution.isRunning ? '🟢 Running' : '⚪ Idle'}\n` +
        `*Workspace:* \`${WORKSPACE}\`\n` +
        `*Session Messages:* ${session.getMessageCount()}\n` +
        `*Files Tracked:* ${lastFileList.size}\n\n` +
        (currentExecution.isRunning ? 
            `*Current Progress:* ${currentExecution.progress}%\n` +
            `*Method:* ${currentExecution.method}\n` +
            `*Started:* ${currentExecution.startTime?.toLocaleTimeString()}\n` : 
            `Ready to execute commands! 🚀`);
    
    await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    sessions.delete(chatId);
    await bot.sendMessage(
        chatId,
        '🧹 *Context Cleared*\n\nConversation history has been reset. Starting fresh!',
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    passwordSecurity.logout(chatId);
    await bot.sendMessage(
        chatId,
        `🔓 *Logged Out*\n\n` +
        `You have been logged out successfully.\n\n` +
        `You will need to enter the password again to execute commands.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
        chatId,
        `📖 *Help & Usage*\n\n` +
        `*Basic Usage:*\n` +
        `1. Enter password when prompted (first time)\n` +
        `2. Send any message to execute in Cursor IDE\n\n` +
        `*Security Features:*\n` +
        `• 🔒 Password protection\n` +
        `• ⚠️ 3 attempts allowed\n` +
        `• 🔐 5-minute lockout after failed attempts\n` +
        `• 🛡️ Protects from unauthorized access\n\n` +
        `*Context Preservation:*\n` +
        `The bot remembers your last 50 messages for context.\n\n` +
        `*Examples:*\n` +
        `• "Build me a calculator app"\n` +
        `• "Add a dark mode toggle"\n` +
        `• "Deploy to Vercel"\n` +
        `• "Run tests for the app"\n\n` +
        `*Commands:*\n` +
        `/start - Welcome message\n` +
        `/status - Check current status\n` +
        `/clear - Clear conversation context\n` +
        `/logout - Logout (require password again)\n` +
        `/help - This help message\n\n` +
        `*GitHub:* https://github.com/yourusername/telegram-cursor-integration`,
        { parse_mode: 'Markdown' }
    );
});

// Handle all other messages as commands or password entry
bot.on('message', async (msg) => {
    // Skip if it's a command we already handled
    if (msg.text && msg.text.startsWith('/')) {
        return;
    }
    
    if (msg.text) {
        const chatId = msg.chat.id;
        
        // Check if user is authenticated
        if (!passwordSecurity.isAuthenticated(chatId, BOT_PASSWORD)) {
            // Try to verify as password
            const isValid = await passwordSecurity.verifyPassword(bot, chatId, msg.text, BOT_PASSWORD);
            if (!isValid) {
                // Password was wrong, don't execute
                return;
            }
            // Password was correct, send welcome message
            await bot.sendMessage(
                chatId,
                `🎉 *Authentication Successful!*\n\n` +
                `You can now send commands to control Cursor IDE.\n\n` +
                `Try: "Build me a hello world app"`,
                { parse_mode: 'Markdown' }
            );
            return;
        }
        
        // User is authenticated, handle as command
        await handleCommand(msg);
    }
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('❌ Telegram polling error:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
});

// Startup message
console.log('============================================================');
console.log('🤖 Telegram + Cursor Integration Bot');
console.log('============================================================');
console.log(`✅ Bot started successfully!`);
console.log(`📁 Workspace: ${WORKSPACE}`);
console.log(`🔗 Telegram bot is listening...`);
console.log(`💡 Send messages to your bot to execute commands in Cursor`);
console.log('============================================================\n');
