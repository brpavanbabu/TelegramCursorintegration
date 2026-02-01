#!/usr/bin/env node

/**
 * Telegram + Cursor Integration - Setup Wizard
 * Created by: Pavan Babu
 * 
 * This script helps you configure the bot for first-time use.
 */

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

async function main() {
    console.log('============================================================');
    console.log('🤖 Telegram + Cursor Integration - Setup Wizard');
    console.log('============================================================\n');

    console.log('This wizard will help you set up your bot configuration.\n');

    // Check if config already exists
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        console.log('⚠️  config.json already exists!\n');
        const overwrite = await question('Do you want to overwrite it? (yes/no): ');
        if (overwrite.toLowerCase() !== 'yes' && overwrite.toLowerCase() !== 'y') {
            console.log('\n✅ Setup cancelled. Your existing config is safe.');
            rl.close();
            return;
        }
        console.log('');
    }

    // Step 1: Get Telegram Bot Token
    console.log('📱 Step 1: Telegram Bot Token');
    console.log('   To get a bot token:');
    console.log('   1. Open Telegram and search for @BotFather');
    console.log('   2. Send /newbot and follow instructions');
    console.log('   3. Copy the bot token you receive\n');

    let botToken = await question('Enter your Telegram Bot Token: ');
    botToken = botToken.trim();

    if (!botToken || botToken.length < 20) {
        console.log('\n❌ Invalid bot token. Please run setup again with a valid token.');
        rl.close();
        return;
    }

    // Step 2: Get Workspace Path
    console.log('\n📁 Step 2: Workspace Path');
    console.log('   This is the folder where your projects are located.');
    console.log('   Example: C:\\Users\\YourName\\Projects\n');

    let workspacePath = await question('Enter your workspace path: ');
    workspacePath = workspacePath.trim();

    // Remove quotes if user added them
    workspacePath = workspacePath.replace(/^["']|["']$/g, '');

    // Normalize path for Windows
    if (process.platform === 'win32') {
        workspacePath = workspacePath.replace(/\//g, '\\');
    }

    // Check if path exists
    if (!fs.existsSync(workspacePath)) {
        console.log('\n⚠️  Warning: Workspace path does not exist.');
        const create = await question('Do you want to create it? (yes/no): ');
        if (create.toLowerCase() === 'yes' || create.toLowerCase() === 'y') {
            try {
                fs.mkdirSync(workspacePath, { recursive: true });
                console.log('✅ Workspace directory created.');
            } catch (error) {
                console.log(`\n❌ Failed to create directory: ${error.message}`);
                console.log('Please create it manually and run setup again.');
                rl.close();
                return;
            }
        }
    }

    // Step 3: Create config.json
    console.log('\n💾 Step 3: Saving Configuration');

    const config = {
        telegramBotToken: botToken,
        workspacePath: workspacePath
    };

    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.log('✅ Configuration saved to config.json');
    } catch (error) {
        console.log(`\n❌ Failed to save configuration: ${error.message}`);
        rl.close();
        return;
    }

    // Step 4: Check dependencies
    console.log('\n📦 Step 4: Checking Dependencies');

    const packageJsonPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        console.log('⚠️  package.json not found.');
        console.log('Please run: npm init -y && npm install');
    } else {
        const nodeModulesPath = path.join(__dirname, 'node_modules');
        if (!fs.existsSync(nodeModulesPath)) {
            console.log('⚠️  node_modules not found.');
            console.log('Please run: npm install');
        } else {
            console.log('✅ Dependencies appear to be installed');
        }
    }

    // Step 5: Done!
    console.log('\n============================================================');
    console.log('🎉 Setup Complete!');
    console.log('============================================================');
    console.log('\n📋 Next Steps:\n');
    console.log('   1. Make sure Cursor IDE is installed');
    console.log('   2. Run: node telegram-cursor-bot.js');
    console.log('   3. Open Telegram and send /start to your bot');
    console.log('   4. Send any command to test it!\n');
    console.log('📖 For more info, see README.md');
    console.log('🐛 Issues? Check: https://github.com/yourusername/telegram-cursor-integration/issues\n');
    console.log('============================================================\n');

    rl.close();
}

main().catch(error => {
    console.error('\n❌ Setup failed:', error.message);
    rl.close();
    process.exit(1);
});
