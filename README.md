# 🤖 Telegram + Cursor Integration Bot

Control your Cursor IDE directly from Telegram! This bot allows you to send commands via Telegram and have them automatically executed in Cursor IDE with full context preservation, real-time status updates, and **password protection from attackers**.

**Created by: Pavan Babu**

## ✨ Features

- 🎯 **Direct Cursor Control**: Send commands from Telegram and they execute automatically in Cursor
- 🔒 **Password Protection**: Secure authentication protects you from attackers and unauthorized access
- 🧠 **Context Preservation**: Bot remembers your last 50 messages for intelligent context-aware responses
- 📊 **Real-time Status Updates**: Get progress updates as your commands execute
- 📁 **Automatic File Tracking**: Monitors workspace for new/modified files and reports them
- 🔄 **Queue Management**: Handles multiple commands without conflicts
- 🚀 **Zero Manual Steps**: Fully automated execution - no need to touch Cursor manually
- ⚡ **One-Command Install**: Everything automated - no hassle!

## 🔒 Security First!

This bot includes **password protection** to keep you safe:
- ✅ Password required before executing any command
- ✅ 3 failed attempts = 5-minute lockout
- ✅ Protects from unauthorized users and attackers
- ✅ Safe even if bot token is leaked

**See [SECURITY.md](SECURITY.md) for complete security documentation**

## 🚀 Quick Install (One Command!)

```bash
git clone https://github.com/brpavanbabu/telegram-cursor-integration.git
cd telegram-cursor-integration
node install.js
```

**That's it!** The installer will:
- ✅ Check Node.js
- ✅ Install all dependencies automatically
- ✅ Guide you through bot setup (30 seconds)
- ✅ Ask you to set a password for security
- ✅ Test everything
- ✅ Start the bot immediately

## 🎥 How It Works

1. **You**: Send a message to your Telegram bot (e.g., "Build me a todo app")
2. **Security**: Bot verifies you're authenticated (password required on first use)
3. **Bot**: Receives the command and sends it to Cursor IDE
4. **Cursor**: Processes the command using AI Agent mode (Ctrl+K)
5. **Bot**: Monitors progress and sends you updates
6. **You**: Get notified when files are created/modified with a "Work Finished 100%" message

## 📋 Prerequisites

- **Windows 10/11** (for automation features)
- **Node.js** (v14 or higher) - [Download here](https://nodejs.org/)
- **Cursor IDE** - [Download here](https://cursor.sh/)
- **Telegram Account** - Create a bot with [@BotFather](https://t.me/botfather)

## 📖 Detailed Setup (If Needed)

### Option 1: Automatic (Recommended)

```bash
node install.js
```

### Option 2: Manual Setup

```bash
# Install dependencies
npm install

# Run setup wizard
node setup.js

# Start bot
node telegram-cursor-bot.js
```

### Option 3: Windows Quick Start

```powershell
.\start-bot.ps1
```

## 💬 Usage

### First Time: Authentication

1. **Start your bot** on Telegram
2. Send `/start`
3. **Bot asks for password**
4. Enter the password you set during installation
5. Bot says: "✅ Password Verified!"
6. **Now you can send commands!**

### Example Commands

**Build a web app:**
```
Build me a portfolio website with HTML, CSS, and JavaScript
```

**Create a Python script:**
```
Create a Python script that organizes files by extension
```

**Add features with context:**
```
You: Build me a todo app
Bot: ✅ Creating app...

You: Add user authentication
Bot: ✅ Adding auth (remembers it's for the todo app)

You: Deploy it to Vercel
Bot: ✅ Deploying todo app with auth
```

### Bot Commands

- `/start` - Welcome message and introduction
- `/status` - Check bot status and current execution
- `/clear` - Clear conversation context (start fresh)
- `/logout` - Logout (require password again)
- `/help` - Show help message

## 🔧 Configuration

The `install.js` script creates a `config.json` file with:

```json
{
  "telegramBotToken": "YOUR_BOT_TOKEN",
  "workspacePath": "C:\\Users\\YourName\\Projects",
  "password": "YourSecurePassword"
}
```

**⚠️ Important**: Keep `config.json` private! It contains your bot token and password.

## 📁 Project Structure

```
telegram-cursor-integration/
├── telegram-cursor-bot.js      # Main bot (context-aware, fully automated, password-protected)
├── password-security.js         # Security module (protects from attackers)
├── install.js                   # One-command installer ⚡
├── setup.js                     # Alternative setup wizard
├── start-bot.ps1               # Windows start script
├── config.json                  # Your configuration (auto-generated, keep private!)
├── config.example.json          # Example configuration
├── package.json                 # Dependencies
├── README.md                    # This file
├── QUICK_START.md              # 5-minute guide
├── SECURITY.md                  # Security features documentation
├── CONTRIBUTING.md             # Contribution guidelines
├── CREDITS.md                  # Credits to Pavan Babu
├── LICENSE                     # MIT License
└── .gitignore                  # Git ignore rules
```

## 🐛 Troubleshooting

### "Node.js not found"
Install from: https://nodejs.org/

### "Bot not responding"
1. Check if bot is running: `node telegram-cursor-bot.js`
2. Verify bot token in `config.json`
3. Make sure you're messaging the correct bot

### "Password not working"
1. Check your password in `config.json`
2. Default password is `SecureBot123` if not set
3. Use `/logout` and try again

### "Commands not executing"
1. Ensure you've entered the password correctly
2. Ensure Cursor IDE is installed
3. Try opening Cursor manually first
4. Check `config.json` workspace path is correct

### "npm install fails"
```bash
npm install --force
```

### Still having issues?
- Check [GitHub Issues](https://github.com/brpavanbabu/telegram-cursor-integration/issues)
- Create a new issue with details

## 🎯 Real-World Examples

### 1. Build & Deploy from Your Phone (Securely!)

```
☕ You (at coffee shop): "Build me a landing page"
🔒 Bot: "Password Required"
☕ You: [enters password]
✅ Bot: "Password Verified! Creating landing page..."

📱 You: "Add a contact form with validation"
✅ Bot: Added (remembers context)

🚀 You: "Deploy to Vercel"
✅ Bot: Deployed! https://your-site.vercel.app
```

### 2. Protected from Attackers

```
😈 Attacker: [somehow finds your bot]
😈 Attacker: "Delete all files"
🔒 Bot: "Password Required"
😈 Attacker: "password"
❌ Bot: "Incorrect Password (2 attempts remaining)"
😈 Attacker: "admin"
❌ Bot: "Incorrect Password (1 attempt remaining)"
😈 Attacker: "123456"
🔒 Bot: "Account Locked for 5 minutes"
✅ Your files are safe!
```

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md)

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 🙏 Credits

**Created by Pavan Babu**

See [CREDITS.md](CREDITS.md) for full credits and acknowledgments.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Free to use, modify, and distribute!

## 🌟 Why This Project?

This bot solves a real problem: **securely controlling your IDE from anywhere**. Whether you're away from your desk, on your phone, or just want to automate repetitive tasks, this bot makes it seamless **and secure**.

### What Makes It Special?

- 🔒 **Actually secure** - Password protection keeps attackers out
- 🧠 **Actually remembers context** - Not just a dumb command relay
- 🚀 **Truly automated** - No manual Ctrl+K needed
- ⚡ **Hassle-free setup** - One command and you're running
- 📱 **Mobile-friendly** - Control from your phone
- 🎯 **Production-ready** - Built to work reliably

## 💬 Support

- 🔒 [Security Documentation](SECURITY.md)
- 🐛 [Report a Bug](https://github.com/brpavanbabu/telegram-cursor-integration/issues)
- 💡 [Request a Feature](https://github.com/brpavanbabu/telegram-cursor-integration/issues)
- ⭐ Star this repo if you find it useful!

---

<div align="center">

**⭐ Star this repo if you find it useful! ⭐**

Made with ❤️ by **Pavan Babu**

*For developers who love automation and security*

</div>
