'use strict';

/**
 * Three-tier agent memory:
 *
 *  - Working memory:  bounded per-session message window (what the agent is
 *    doing right now). Mirrors the original bot's 50-message context.
 *  - Episodic memory: append-only record of completed tasks and outcomes,
 *    optionally persisted as JSONL so knowledge survives restarts.
 *  - Semantic memory: keyword-indexed facts with relevance-scored recall.
 */

const fs = require('fs');

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
    'is', 'are', 'was', 'be', 'it', 'this', 'that', 'at', 'by', 'from'
]);

function tokenize(text) {
    return String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

class WorkingMemory {
    constructor(maxMessages = 50) {
        this.maxMessages = maxMessages;
        this.messages = [];
    }

    add(role, content) {
        this.messages.push({ role, content, timestamp: Date.now() });
        if (this.messages.length > this.maxMessages) {
            this.messages = this.messages.slice(-this.maxMessages);
        }
    }

    getContext() {
        return this.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    clear() { this.messages = []; }
    size() { return this.messages.length; }
}

class EpisodicMemory {
    constructor(options = {}) {
        this.episodes = [];
        this.maxEpisodes = options.maxEpisodes || 1000;
        this.filePath = options.filePath || null;
        if (this.filePath && fs.existsSync(this.filePath)) {
            this.episodes = fs.readFileSync(this.filePath, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(line => JSON.parse(line))
                .slice(-this.maxEpisodes);
        }
    }

    record(episode) {
        const entry = { timestamp: Date.now(), ...episode };
        this.episodes.push(entry);
        if (this.episodes.length > this.maxEpisodes) this.episodes.shift();
        if (this.filePath) {
            fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
        }
        return entry;
    }

    recent(limit = 10) {
        return this.episodes.slice(-limit);
    }
}

class SemanticMemory {
    constructor() {
        this.facts = []; // { id, text, tokens, metadata }
        this.nextId = 1;
    }

    store(text, metadata = {}) {
        const fact = { id: this.nextId++, text, tokens: tokenize(text), metadata };
        this.facts.push(fact);
        return fact.id;
    }

    /** Token-overlap relevance search (swap for embeddings in production). */
    recall(query, limit = 5) {
        const queryTokens = new Set(tokenize(query));
        return this.facts
            .map(fact => {
                const overlap = fact.tokens.filter(t => queryTokens.has(t)).length;
                const score = fact.tokens.length
                    ? overlap / Math.sqrt(fact.tokens.length)
                    : 0;
                return { ...fact, score };
            })
            .filter(f => f.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    forget(id) {
        this.facts = this.facts.filter(f => f.id !== id);
    }
}

class MemoryManager {
    constructor(options = {}) {
        this.working = new WorkingMemory(options.workingMaxMessages || 50);
        this.episodic = new EpisodicMemory({
            maxEpisodes: options.episodicMaxEpisodes,
            filePath: options.episodicFilePath
        });
        this.semantic = new SemanticMemory();
    }

    /** Builds the memory portion of an agent prompt for a given task. */
    buildContext(taskDescription) {
        const parts = [];
        const facts = this.semantic.recall(taskDescription, 5);
        if (facts.length) {
            parts.push('Relevant knowledge:\n' + facts.map(f => `- ${f.text}`).join('\n'));
        }
        const recent = this.episodic.recent(3);
        if (recent.length) {
            parts.push('Recent task outcomes:\n' + recent
                .map(e => `- ${e.goal || e.summary || 'task'}: ${e.outcome || 'unknown'}`)
                .join('\n'));
        }
        const working = this.working.getContext();
        if (working) {
            parts.push('Conversation so far:\n' + working);
        }
        return parts.join('\n\n');
    }
}

module.exports = { MemoryManager, WorkingMemory, EpisodicMemory, SemanticMemory, tokenize };
