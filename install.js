#!/usr/bin/env node

/**
 * One-Command Installer for Telegram + Cursor Integration
 * Created by: Pavan Babu
 * 
 * This script does EVERYTHING:
 * - Checks Node.js
 * - Installs dependencies automatically
 * - Configures bot (interactive)
 * - Tests configuration
 * - Starts bot immediately
 */

const { exec, spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stderr, stdout });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function main() {
    console.clear();
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   🤖 Telegram + Cursor Integration - ONE-STEP INSTALL   ║');
    console.log('║                  Created by Pavan Babu                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('⚡ This will install and configure everything automatically!');
    console.log('');

    try {
        // Step 1: Check Node.js
        console.log('📋 Step 1/5: Checking Node.js...');
        try {
            const { stdout } = await execPromise('node --version');
            const version = stdout.trim();
            console.log(`✅ Node.js ${version} detected`);
        } catch (error) {
            console.log('❌ Node.js not found!');
            console.log('');
            console.log('Please install Node.js from: https://nodejs.org/');
            process.exit(1);
        }

        // Step 2: Check/Install Dependencies
        console.log('');
        console.log('📦 Step 2/5: Installing dependencies...');
        
        const packageJsonPath = path.join(__dirname, 'package.json');
        const nodeModulesPath = path.join(__dirname, 'node_modules');
        
        if (!fs.existsSync(packageJsonPath)) {
            console.log('⚠️  Creating package.json...');
            const packageJson = {
                name: "telegram-cursor-integration",
                version: "1.0.0",
                description: "Control Cursor IDE from Telegram with context preservation",
                main: "telegram-cursor-bot.js",
                author: "Pavan Babu",
                license: "MIT",
                dependencies: {
                    "node-telegram-bot-api": "^0.66.0",
                    "robotjs": "^0.6.0"
                }
            };
            fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        }

        if (!fs.existsSync(nodeModulesPath)) {
            console.log('📥 Installing npm packages (this may take a minute)...');
            try {
                await execPromise('npm install');
                console.log('✅ Dependencies installed successfully');
            } catch (error) {
                console.log('⚠️  Standard npm install had issues, trying with --force...');
                try {
                    await execPromise('npm install --force');
                    console.log('✅ Dependencies installed with --force');
                } catch (retryError) {
                    console.log('❌ Could not install dependencies');
                    console.log('Please run manually: npm install');
                    process.exit(1);
                }
            }
        } else {
            console.log('✅ Dependencies already installed');
        }

        // Step 3: Check config or create it
        console.log('');
        console.log('⚙️  Step 3/5: Configuration...');
        
        const configPath = path.join(__dirname, 'config.json');
        let config = null;

        if (fs.existsSync(configPath)) {
            console.log('📄 Found existing config.json');
            const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            if (existingConfig.telegramBotToken && existingConfig.workspacePath) {
                console.log('✅ Configuration looks good!');
                console.log(`   Bot Token: ${existingConfig.telegramBotToken.substring(0, 20)}...`);
                console.log(`   Workspace: ${existingConfig.workspacePath}`);
                console.log('');
                
                const useExisting = await question('Use existing configuration? (yes/no): ');
                if (useExisting.toLowerCase() === 'yes' || useExisting.toLowerCase() === 'y' || useExisting.trim() === '') {
                    config = existingConfig;
                }
            }
        }

        if (!config) {
            console.log('');
            console.log('🔧 Let\'s configure your bot (takes 30 seconds)...');
            console.log('');
            console.log('📱 First, create a Telegram bot:');
            console.log('   1. Open Telegram and search: @BotFather');
            console.log('   2. Send: /newbot');
            console.log('   3. Follow prompts and copy your bot token');
            console.log('');

            let botToken = await question('Paste your Telegram Bot Token: ');
            botToken = botToken.trim();

            if (!botToken || botToken.length < 20) {
                console.log('❌ Invalid bot token. Please try again.');
                process.exit(1);
            }

            console.log('');
            console.log('📁 Now, set your workspace path:');
            console.log(`   Current directory: ${__dirname}`);
            console.log('   (Press Enter to use current directory)');
            console.log('');

            let workspacePath = await question('Workspace path [press Enter for current]: ');
            workspacePath = workspacePath.trim();

            if (!workspacePath) {
                workspacePath = __dirname;
                console.log(`✅ Using: ${workspacePath}`);
            } else {
                workspacePath = workspacePath.replace(/^["']|["']$/g, '');
                if (process.platform === 'win32') {
                    workspacePath = workspacePath.replace(/\//g, '\\');
                }
            }

            // Create workspace if it doesn't exist
            if (!fs.existsSync(workspacePath)) {
                console.log('📁 Creating workspace directory...');
                fs.mkdirSync(workspacePath, { recursive: true });
            }

            console.log('');
            console.log('🔒 Security: Set a password to protect from attackers:');
            console.log('   This password is required to execute commands');
            console.log('   Prevents unauthorized access to your IDE');
            console.log('   (Press Enter to use default: SecureBot123)');
            console.log('');

            let password = await question('Enter password [or press Enter for default]: ');
            password = password.trim();

            if (!password) {
                password = 'SecureBot123';
                console.log('⚠️  Using default password. Consider changing it later in config.json');
            } else {
                console.log('✅ Custom password set!');
            }

            config = {
                telegramBotToken: botToken,
                workspacePath: workspacePath,
                password: password
            };

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
            console.log('✅ Configuration saved!');
        }

        // Step 4: Test Telegram connection
        console.log('');
        console.log('🧪 Step 4/5: Testing Telegram connection...');
        
        try {
            const TelegramBot = require('node-telegram-bot-api');
            const testBot = new TelegramBot(config.telegramBotToken, { polling: false });
            const me = await testBot.getMe();
            console.log(`✅ Connected to Telegram bot: @${me.username}`);
            console.log(`   Bot name: ${me.first_name}`);
            await testBot.close();
        } catch (error) {
            console.log('❌ Could not connect to Telegram');
            console.log(`   Error: ${error.message}`);
            console.log('   Please check your bot token and try again.');
            process.exit(1);
        }

        // Step 5: Check Cursor
        console.log('');
        console.log('🎯 Step 5/5: Checking Cursor IDE...');
        
        try {
            if (process.platform === 'win32') {
                await execPromise('where cursor');
                console.log('✅ Cursor IDE found in PATH');
            } else {
                await execPromise('which cursor');
                console.log('✅ Cursor IDE found in PATH');
            }
        } catch (error) {
            console.log('⚠️  Cursor not in PATH (this is OK if installed)');
            console.log('   The bot will attempt to launch Cursor anyway.');
        }

        // All done!
        console.log('');
        console.log('╔═══════════════════════════════════════════════════════════╗');
        console.log('║              ✅ INSTALLATION COMPLETE! ✅                 ║');
        console.log('╚═══════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('🎉 Your bot is ready to use!');
        console.log('');
        console.log('🔒 Security Setup Complete!');
        console.log(`   Password: ${config.password || 'SecureBot123'}`);
        console.log('   Keep this password secret!');
        console.log('');
        console.log('📱 Next steps:');
        console.log('   1. Find your bot on Telegram (search for the bot name)');
        console.log('   2. Send /start to your bot');
        console.log('   3. Enter your password when prompted');
        console.log('   4. Send any command like: "Build me a calculator"');
        console.log('');
        
        const startNow = await question('🚀 Start the bot now? (yes/no): ');
        
        if (startNow.toLowerCase() === 'yes' || startNow.toLowerCase() === 'y' || startNow.trim() === '') {
            console.log('');
            console.log('🤖 Starting bot...');
            console.log('============================================================');
            console.log('');
            
            rl.close();
            
            // Start the bot
            const botProcess = spawn('node', ['telegram-cursor-bot.js'], {
                stdio: 'inherit',
                shell: true
            });

            botProcess.on('error', (error) => {
                console.error('❌ Failed to start bot:', error.message);
                process.exit(1);
            });

        } else {
            console.log('');
            console.log('To start the bot later, run:');
            console.log('   node telegram-cursor-bot.js');
            console.log('');
            console.log('Or on Windows:');
            console.log('   .\\start-bot.ps1');
            console.log('');
            rl.close();
        }

    } catch (error) {
        console.error('');
        console.error('❌ Installation failed:', error.message);
        console.error('');
        console.error('Please report this issue on GitHub or try manual setup.');
        rl.close();
        process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Installation cancelled by user.');
    rl.close();
    process.exit(0);
});

main().catch(error => {
    console.error('Unexpected error:', error);
    rl.close();
    process.exit(1);
});
