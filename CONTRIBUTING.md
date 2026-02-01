# Contributing to Telegram + Cursor Integration

First off, thank you for considering contributing to this project! 🎉

## How Can I Contribute?

### Reporting Bugs

If you find a bug, please create an issue with:
- A clear, descriptive title
- Steps to reproduce the behavior
- Expected behavior vs actual behavior
- Your environment (OS, Node.js version, Cursor version)
- Screenshots if applicable

### Suggesting Enhancements

Feature requests are welcome! Please:
- Use a clear, descriptive title
- Provide a detailed description of the proposed feature
- Explain why this enhancement would be useful
- Include examples if possible

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code, ensure it works properly
3. Make sure your code follows the existing style
4. Update the README.md if needed
5. Write a clear commit message

## Development Setup

```bash
# Clone your fork
git clone https://github.com/brpavanbabu/telegram-cursor-integration.git
cd telegram-cursor-integration

# Install dependencies
npm install

# Create config for testing
node setup.js

# Start the bot
npm start
```

## Code Style

- Use meaningful variable names
- Add comments for complex logic
- Keep functions focused and small
- Use async/await for asynchronous code
- Handle errors gracefully

## Testing

Before submitting:
1. Test with your own Telegram bot
2. Try various commands (build, deploy, etc.)
3. Test context preservation across messages
4. Verify file tracking works

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 💙
