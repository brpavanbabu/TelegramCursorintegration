'use strict';

/**
 * Orchestrator — multi-agent task routing and lifecycle management.
 *
 * Responsibilities:
 *  - capability-based routing of tasks to registered agents
 *  - bounded concurrency with a FIFO queue (backpressure instead of pile-up)
 *  - task lifecycle state machine: queued -> running -> completed|failed
 *  - lifecycle events on the bus (task.queued, task.completed, ...) so
 *    channels (Telegram, HTTP, cron) can observe without coupling
 */

const crypto = require('crypto');

class Orchestrator {
    /**
     * @param {object} deps { eventBus, audit, metrics, logger }
     * @param {object} [options] { maxConcurrent, maxQueueSize }
     */
    constructor(deps = {}, options = {}) {
        this.eventBus = deps.eventBus || null;
        this.audit = deps.audit || null;
        this.metrics = deps.metrics || null;
        this.logger = deps.logger || null;
        this.maxConcurrent = options.maxConcurrent || 2;
        this.maxQueueSize = options.maxQueueSize || 100;
        this.agents = new Map(); // id -> Agent
        this.tasks = new Map();  // id -> task record
        this.queue = [];
        this.running = 0;
    }

    registerAgent(agent) {
        if (this.agents.has(agent.id)) {
            throw new Error(`Agent ${agent.id} is already registered`);
        }
        this.agents.set(agent.id, agent);
        return this;
    }

    /** Picks the least-loaded agent that advertises the required capability. */
    selectAgent(requiredCapability) {
        const candidates = [...this.agents.values()].filter(a =>
            !requiredCapability || a.capabilities.includes(requiredCapability)
        );
        if (!candidates.length) return null;
        const load = new Map(candidates.map(a => [a.id, 0]));
        for (const task of this.tasks.values()) {
            if (task.status === 'running' && load.has(task.agentId)) {
                load.set(task.agentId, load.get(task.agentId) + 1);
            }
        }
        return candidates.sort((a, b) => load.get(a.id) - load.get(b.id))[0];
    }

    async emit(topic, payload) {
        if (this.eventBus) await this.eventBus.publish(topic, payload);
    }

    /**
     * @param {object} spec { description, capability?, requestedBy?, metadata? }
     * @returns {{taskId: string, done: Promise<object>}}
     */
    submitTask(spec) {
        if (!spec || !spec.description) {
            throw new Error('Task requires a description');
        }
        if (this.queue.length >= this.maxQueueSize) {
            throw new Error('Task queue is full — try again later');
        }
        const agent = this.selectAgent(spec.capability);
        if (!agent) {
            throw new Error(
                spec.capability
                    ? `No agent registered with capability "${spec.capability}"`
                    : 'No agents registered'
            );
        }

        const taskId = crypto.randomBytes(6).toString('hex');
        const task = {
            id: taskId,
            description: spec.description,
            capability: spec.capability || null,
            requestedBy: spec.requestedBy || 'system',
            metadata: spec.metadata || {},
            agentId: agent.id,
            status: 'queued',
            submittedAt: Date.now(),
            result: null
        };
        this.tasks.set(taskId, task);
        if (this.audit) {
            this.audit.record({
                actor: task.requestedBy,
                action: 'task.submitted',
                details: { taskId, agentId: agent.id, capability: task.capability }
            });
        }

        const done = new Promise((resolve) => {
            this.queue.push({ task, agent, resolve });
        });
        this.emit('task.queued', { taskId, agentId: agent.id });
        this.pump();
        return { taskId, done };
    }

    pump() {
        while (this.running < this.maxConcurrent && this.queue.length) {
            const { task, agent, resolve } = this.queue.shift();
            this.running += 1;
            task.status = 'running';
            task.startedAt = Date.now();
            this.emit('task.started', { taskId: task.id, agentId: agent.id });

            agent.run(task)
                .then(result => {
                    task.status = result.status === 'completed' ? 'completed' : 'failed';
                    task.result = result;
                })
                .catch(err => {
                    task.status = 'failed';
                    task.result = { status: 'error', output: err.message, steps: [] };
                    if (this.logger) {
                        this.logger.error('Task crashed', { taskId: task.id, error: err.message });
                    }
                })
                .then(() => {
                    task.finishedAt = Date.now();
                    this.running -= 1;
                    if (this.metrics) {
                        this.metrics.increment('orchestrator_tasks_total', { status: task.status });
                        this.metrics.observe('task_duration_ms', task.finishedAt - task.startedAt);
                    }
                    if (this.audit) {
                        this.audit.record({
                            actor: task.agentId,
                            action: 'task.finished',
                            decision: task.status === 'completed' ? 'allow' : null,
                            details: { taskId: task.id, status: task.status }
                        });
                    }
                    this.emit(`task.${task.status}`, {
                        taskId: task.id,
                        result: task.result,
                        durationMs: task.finishedAt - task.startedAt
                    });
                    resolve(task.result);
                    this.pump();
                });
        }
    }

    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }

    stats() {
        const byStatus = {};
        for (const task of this.tasks.values()) {
            byStatus[task.status] = (byStatus[task.status] || 0) + 1;
        }
        return {
            agents: this.agents.size,
            queued: this.queue.length,
            running: this.running,
            tasks: byStatus
        };
    }
}

module.exports = { Orchestrator };
