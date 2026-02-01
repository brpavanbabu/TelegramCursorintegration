/**
 * Password Security Module
 * Created by: Pavan Babu
 * 
 * Protects your bot from unauthorized access with:
 * - Password authentication
 * - Failed attempt tracking
 * - Automatic lockout after 3 failed attempts
 * - 5-minute lockout duration
 */

// Default password (change in config.json)
const DEFAULT_PASSWORD = 'SecureBot123';

// Security settings
const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION = 5 * 60 * 1000; // 5 minutes

// Store authenticated users and their states
const authenticatedUsers = new Map();

/**
 * Check if a user is authenticated
 * @param {number} chatId - Telegram chat ID
 * @returns {boolean} True if authenticated and not locked out
 */
function isAuthenticated(chatId, password = DEFAULT_PASSWORD) {
    const user = authenticatedUsers.get(chatId);
    if (!user) return false;
    
    // Check if user is locked out
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
        return false;
    }
    
    return user.isAuthenticated;
}

/**
 * Request password from user
 * @param {object} bot - Telegram bot instance
 * @param {number} chatId - Telegram chat ID
 * @returns {Promise<boolean>} True if request sent successfully
 */
async function requestPassword(bot, chatId) {
    let user = authenticatedUsers.get(chatId);
    if (!user) {
        user = { isAuthenticated: false, attempts: 0, lockoutUntil: null };
        authenticatedUsers.set(chatId, user);
    }
    
    // Check if locked out
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
        const remainingTime = Math.ceil((user.lockoutUntil - new Date()) / 1000 / 60);
        await bot.sendMessage(
            chatId,
            `🔒 *Account Locked*\n\n` +
            `You are locked out for ${remainingTime} more minute(s).\n\n` +
            `Too many failed password attempts. Please try again later.`,
            { parse_mode: 'Markdown' }
        );
        return false;
    }
    
    await bot.sendMessage(
        chatId,
        `🔑 *Password Required*\n\n` +
        `To execute commands, please enter the password.\n\n` +
        `💡 *Security Feature:*\n` +
        `• Protects your bot from unauthorized access\n` +
        `• 3 attempts allowed\n` +
        `• 5-minute lockout after failed attempts\n\n` +
        `Enter your password now:`,
        { parse_mode: 'Markdown' }
    );
    return true;
}

/**
 * Verify password entered by user
 * @param {object} bot - Telegram bot instance
 * @param {number} chatId - Telegram chat ID
 * @param {string} password - Password entered by user
 * @param {string} correctPassword - Correct password from config
 * @returns {Promise<boolean>} True if password is correct
 */
async function verifyPassword(bot, chatId, password, correctPassword = DEFAULT_PASSWORD) {
    let user = authenticatedUsers.get(chatId);
    if (!user) {
        user = { isAuthenticated: false, attempts: 0, lockoutUntil: null };
        authenticatedUsers.set(chatId, user);
    }
    
    // Check if locked out
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
        const remainingTime = Math.ceil((user.lockoutUntil - new Date()) / 1000 / 60);
        await bot.sendMessage(
            chatId,
            `🔒 *Account Locked*\n\n` +
            `You are locked out for ${remainingTime} more minute(s).`,
            { parse_mode: 'Markdown' }
        );
        return false;
    }
    
    // Verify password
    if (password === correctPassword) {
        user.isAuthenticated = true;
        user.attempts = 0;
        user.lockoutUntil = null;
        await bot.sendMessage(
            chatId,
            `✅ *Password Verified!*\n\n` +
            `You are now authenticated and can send commands.\n\n` +
            `🔒 Your bot is protected from unauthorized access.`,
            { parse_mode: 'Markdown' }
        );
        return true;
    } else {
        // Wrong password
        user.attempts++;
        
        if (user.attempts >= MAX_ATTEMPTS) {
            // Lock out user
            user.lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION);
            user.isAuthenticated = false;
            await bot.sendMessage(
                chatId,
                `❌ *Incorrect Password*\n\n` +
                `Too many failed attempts.\n` +
                `You are locked out for 5 minutes.\n\n` +
                `🔒 Security feature activated to protect from attackers.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            const remaining = MAX_ATTEMPTS - user.attempts;
            await bot.sendMessage(
                chatId,
                `❌ *Incorrect Password*\n\n` +
                `${remaining} attempt(s) remaining.\n\n` +
                `⚠️ After ${remaining} more failed attempts, you will be locked out for 5 minutes.`,
                { parse_mode: 'Markdown' }
            );
        }
        return false;
    }
}

/**
 * Logout user (revoke authentication)
 * @param {number} chatId - Telegram chat ID
 */
function logout(chatId) {
    const user = authenticatedUsers.get(chatId);
    if (user) {
        user.isAuthenticated = false;
    }
}

/**
 * Check if user is locked out
 * @param {number} chatId - Telegram chat ID
 * @returns {boolean} True if locked out
 */
function isLockedOut(chatId) {
    const user = authenticatedUsers.get(chatId);
    if (!user) return false;
    return user.lockoutUntil && user.lockoutUntil > new Date();
}

/**
 * Get lockout time remaining (in minutes)
 * @param {number} chatId - Telegram chat ID
 * @returns {number} Minutes remaining (0 if not locked out)
 */
function getLockoutTimeRemaining(chatId) {
    const user = authenticatedUsers.get(chatId);
    if (!user || !user.lockoutUntil) return 0;
    
    const remaining = user.lockoutUntil - new Date();
    if (remaining <= 0) return 0;
    
    return Math.ceil(remaining / 1000 / 60);
}

module.exports = {
    isAuthenticated,
    requestPassword,
    verifyPassword,
    logout,
    isLockedOut,
    getLockoutTimeRemaining,
    MAX_ATTEMPTS,
    LOCKOUT_DURATION
};
