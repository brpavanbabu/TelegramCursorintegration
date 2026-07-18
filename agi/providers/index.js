'use strict';

/**
 * Model provider abstraction. The runtime talks to a Provider interface so
 * the underlying LLM (Anthropic API, a local model, or the existing
 * Cursor-automation path) is swappable per environment.
 */

class Provider {
    /**
     * @param {Array<{role: 'user'|'assistant', content: string}>} messages
     * @param {object} [options] { system, maxTokens, temperature }
     * @returns {Promise<{text: string, usage: object}>}
     */
    // eslint-disable-next-line no-unused-vars
    async complete(messages, options = {}) {
        throw new Error('Provider.complete must be implemented');
    }
}

/**
 * Anthropic Messages API provider (uses Node 18+ global fetch, no SDK).
 */
class AnthropicProvider extends Provider {
    constructor(options = {}) {
        super();
        this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
        this.model = options.model || 'claude-sonnet-5';
        this.baseUrl = options.baseUrl || 'https://api.anthropic.com';
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        if (!this.apiKey) {
            throw new Error('AnthropicProvider requires an API key (ANTHROPIC_API_KEY)');
        }
    }

    async complete(messages, options = {}) {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: options.model || this.model,
                max_tokens: options.maxTokens || 2048,
                system: options.system,
                messages
            })
        });
        if (!response.ok) {
            const body = await response.text();
            const err = new Error(`Anthropic API error ${response.status}: ${body.slice(0, 300)}`);
            err.status = response.status;
            err.retryable = response.status === 429 || response.status >= 500;
            throw err;
        }
        const data = await response.json();
        return {
            text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
            usage: data.usage || {}
        };
    }
}

/**
 * Deterministic scripted provider for tests and offline development.
 * Feed it a queue of responses (strings or functions of the messages).
 */
class MockProvider extends Provider {
    constructor(responses = []) {
        super();
        this.responses = [...responses];
        this.calls = [];
    }

    enqueue(response) {
        this.responses.push(response);
        return this;
    }

    async complete(messages, options = {}) {
        this.calls.push({ messages, options });
        if (!this.responses.length) {
            throw new Error('MockProvider: no scripted responses left');
        }
        const next = this.responses.shift();
        const text = typeof next === 'function' ? next(messages, options) : next;
        return { text, usage: { input_tokens: 0, output_tokens: 0 } };
    }
}

module.exports = { Provider, AnthropicProvider, MockProvider };
