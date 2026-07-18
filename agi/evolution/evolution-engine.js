'use strict';

/**
 * Guarded self-evolution engine — evolution-AUGMENTED by design, never
 * evolution-native. The engine lets the system propose changes to its own
 * skills and adaptive prompt sections, but every proposal must survive a
 * pipeline the proposer cannot touch:
 *
 *   propose -> threat scan -> independent evaluation -> policy/approval -> commit
 *
 * Hard separations that prevent the classic self-evolution failure modes:
 *  - Optimizer-optimizee collapse: governance modules (policy, RBAC, audit,
 *    verification, the engine itself) are protected targets — proposals
 *    against them are rejected outright, so the optimizer can never rewrite
 *    its own evaluator.
 *  - Lamarckian propagation: content is threat-scanned (injection phrases,
 *    process/exec primitives, exfiltration patterns) before evaluation, so
 *    session-acquired exploits cannot be encoded into the base prompt/skills.
 *  - Evolutionary hijacking: evaluators are fixed at construction time and
 *    every commit is policy-gated (high risk => human approval) and recorded
 *    in the hash-chained lineage with full rollback.
 */

const crypto = require('crypto');
const { forAll } = require('../verification/property-testing');
const { scoreTestSuite, compileFunction } = require('../verification/mutation-testing');

const PROTECTED_TARGETS = [
    'policy', 'rbac', 'audit', 'approvals', 'verification', 'evolution', 'egress'
];

const THREAT_PATTERNS = [
    { id: 'prompt-injection', pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i },
    { id: 'process-exec', pattern: /child_process|execSync|spawnSync|\bprocess\.binding\b/ },
    { id: 'dynamic-eval', pattern: /\beval\s*\(|new\s+Function\s*\(/ },
    { id: 'destructive-shell', pattern: /rm\s+-rf|mkfs|dd\s+if=/ },
    { id: 'remote-exec', pattern: /curl[^|\n]*\|\s*(ba|z)?sh|wget[^|\n]*\|\s*(ba|z)?sh/ },
    { id: 'credential-harvest', pattern: /(api[_-]?key|password|secret|bearer)\s*[:=]\s*['"][^'"]+['"]/i },
    { id: 'self-elevation', pattern: /approve\s*\(|policyEngine|defaultEffect|protectedTargets/ }
];

class EvolutionEngine {
    /**
     * @param {object} deps { policyEngine, approvalManager, audit, memory, logger, metrics }
     * @param {object} [options]
     * @param {string[]} [options.protectedTargets] extra immutable target names
     * @param {number} [options.minMutationScore] required mutant kill rate for skills (default 0.6)
     * @param {number} [options.propertyRuns] PBT runs per invariant (default 200)
     */
    constructor(deps = {}, options = {}) {
        this.policyEngine = deps.policyEngine || null;
        this.approvalManager = deps.approvalManager || null;
        this.audit = deps.audit || null;
        this.memory = deps.memory || null;
        this.logger = deps.logger || null;
        this.metrics = deps.metrics || null;

        this.protectedTargets = [...PROTECTED_TARGETS, ...(options.protectedTargets || [])];
        this.minMutationScore = options.minMutationScore !== undefined ? options.minMutationScore : 0.6;
        this.propertyRuns = options.propertyRuns || 200;

        this.proposals = new Map();     // id -> proposal
        this.promptSections = new Map(); // section name -> content (adaptive prompt plane)
        this.lineage = [];              // committed generations, hash-chained
        this.generation = 0;
        this.lastHash = 'GENESIS';
    }

    static hash(content) {
        return crypto.createHash('sha256').update(String(content)).digest('hex');
    }

    scanThreats(content) {
        const text = String(content);
        return THREAT_PATTERNS.filter(t => t.pattern.test(text)).map(t => t.id);
    }

    recordAudit(action, decision, details) {
        if (this.audit) {
            this.audit.record({ actor: 'evolution-engine', action, decision, details });
        }
    }

    /**
     * @param {object} spec
     * @param {'skill'|'prompt'} spec.kind
     * @param {string} spec.target skill name or prompt section name
     * @param {string} spec.content function source (skill) or section text (prompt)
     * @param {string} [spec.rationale]
     * @param {string} [spec.proposedBy]
     * @param {object} [spec.validation] for skills:
     *        { testSuite: (fn)=>void, properties: [{generators, property}] }
     */
    propose(spec) {
        const { kind, target, content } = spec;
        if (!['skill', 'prompt'].includes(kind)) {
            throw new Error(`Unknown proposal kind: ${kind}`);
        }
        if (!target || !content) throw new Error('Proposal requires target and content');

        const normalizedTarget = String(target).toLowerCase();
        if (this.protectedTargets.some(p => normalizedTarget === p || normalizedTarget.startsWith(p + '.'))) {
            this.recordAudit('evolution.propose', 'deny', { target, reason: 'protected_target' });
            if (this.metrics) this.metrics.increment('evolution_proposals_total', { outcome: 'protected' });
            throw new Error(`Target "${target}" is protected — the evolution plane cannot modify governance or verification modules`);
        }

        const threats = this.scanThreats(content);
        if (threats.length) {
            this.recordAudit('evolution.propose', 'deny', { target, reason: 'threat_scan', threats });
            if (this.metrics) this.metrics.increment('evolution_proposals_total', { outcome: 'threat_blocked' });
            throw new Error(`Proposal blocked by threat scan: ${threats.join(', ')}`);
        }

        const proposal = {
            id: crypto.randomBytes(6).toString('hex'),
            kind,
            target,
            content,
            rationale: spec.rationale || '',
            proposedBy: spec.proposedBy || 'unknown',
            validation: spec.validation || {},
            status: 'proposed',
            evaluation: null,
            createdAt: Date.now()
        };
        this.proposals.set(proposal.id, proposal);
        this.recordAudit('evolution.propose', null, { proposalId: proposal.id, kind, target, proposedBy: proposal.proposedBy });
        if (this.metrics) this.metrics.increment('evolution_proposals_total', { outcome: 'accepted' });
        return proposal;
    }

    /**
     * Independent evaluation gate. The proposer supplies tests/properties but
     * cannot alter how they are judged: skills must compile, pass their test
     * suite with a sufficient mutant kill rate, and satisfy every declared
     * property invariant under adversarial input generation.
     */
    evaluate(proposalId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
        const report = { checks: [], passed: false };

        if (proposal.kind === 'prompt') {
            const ok = proposal.content.length <= 4000;
            report.checks.push({ check: 'prompt_length', ok });
            report.passed = ok;
        } else {
            let fn = null;
            try {
                fn = compileFunction(proposal.content);
                report.checks.push({ check: 'compiles', ok: true });
            } catch (err) {
                report.checks.push({ check: 'compiles', ok: false, error: err.message });
            }

            if (fn) {
                const { testSuite, properties = [] } = proposal.validation;
                if (testSuite) {
                    const mutation = scoreTestSuite(proposal.content, testSuite);
                    report.checks.push({
                        check: 'mutation_score',
                        ok: mutation.originalPassed && mutation.score >= this.minMutationScore,
                        score: mutation.score,
                        total: mutation.total,
                        survivors: mutation.survivors.slice(0, 5)
                    });
                } else {
                    report.checks.push({ check: 'mutation_score', ok: false, error: 'skill proposals require a test suite' });
                }
                for (let i = 0; i < properties.length; i++) {
                    const { generators, property } = properties[i];
                    const result = forAll(generators, (...args) => property(fn, ...args), { runs: this.propertyRuns });
                    report.checks.push({
                        check: `property_${i}`,
                        ok: result.ok,
                        counterexample: result.counterexample
                    });
                }
                report.passed = report.checks.every(c => c.ok);
            }
        }

        proposal.evaluation = report;
        proposal.status = report.passed ? 'evaluated' : 'rejected';
        this.recordAudit('evolution.evaluate', report.passed ? 'allow' : 'deny', {
            proposalId, passed: report.passed,
            failed: report.checks.filter(c => !c.ok).map(c => c.check)
        });
        return report;
    }

    /**
     * Policy-gated commit. Evolution commits are treated as high-risk actions:
     * under the default policy pack they require human approval. On approval
     * the change is applied and appended to the hash-chained lineage.
     */
    async commit(proposalId, ctx = {}) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
        if (proposal.status !== 'evaluated') {
            throw new Error(`Proposal ${proposalId} has not passed evaluation (status: ${proposal.status})`);
        }

        if (this.policyEngine) {
            const verdict = this.policyEngine.evaluate({
                agentId: ctx.agentId || 'evolution-engine',
                tool: 'evolution.commit',
                riskLevel: 'high',
                args: { kind: proposal.kind, target: proposal.target }
            });
            if (verdict.decision === 'deny') {
                this.recordAudit('evolution.commit', 'deny', { proposalId, reason: verdict.reason });
                throw new Error(`Policy denied evolution commit: ${verdict.reason}`);
            }
            if (verdict.decision === 'require_approval') {
                if (!this.approvalManager) {
                    throw new Error('Evolution commit requires approval but no approval channel is configured');
                }
                const { approved, reason } = await this.approvalManager.requestApproval({
                    agentId: 'evolution-engine',
                    tool: 'evolution.commit',
                    riskLevel: 'high',
                    args: { proposalId, kind: proposal.kind, target: proposal.target, rationale: proposal.rationale }
                });
                if (!approved) {
                    proposal.status = 'denied';
                    throw new Error(`Evolution commit not approved: ${reason}`);
                }
            }
        }

        const previous = this.currentContent(proposal.kind, proposal.target);
        this.apply(proposal);

        const body = {
            generation: ++this.generation,
            proposalId: proposal.id,
            kind: proposal.kind,
            target: proposal.target,
            contentHash: EvolutionEngine.hash(proposal.content),
            previousContent: previous,
            prevHash: this.lastHash,
            committedAt: Date.now()
        };
        const entry = { ...body, hash: EvolutionEngine.hash(JSON.stringify(body)) };
        this.lastHash = entry.hash;
        this.lineage.push(entry);
        proposal.status = 'committed';
        this.recordAudit('evolution.commit', 'allow', {
            proposalId, generation: entry.generation, kind: proposal.kind, target: proposal.target
        });
        if (this.metrics) this.metrics.increment('evolution_commits_total', { kind: proposal.kind });
        return entry;
    }

    currentContent(kind, target) {
        if (kind === 'prompt') return this.promptSections.get(target) || null;
        if (this.memory && this.memory.procedural) {
            const skill = this.memory.procedural.get(target);
            return skill ? skill.source : null;
        }
        return null;
    }

    apply(proposal) {
        if (proposal.kind === 'prompt') {
            this.promptSections.set(proposal.target, proposal.content);
        } else if (this.memory && this.memory.procedural) {
            this.memory.procedural.register({
                name: proposal.target,
                description: proposal.rationale || proposal.target,
                source: proposal.content
            });
        }
    }

    /** Reverts the most recent generation for a target using stored lineage. */
    rollback(generation) {
        const entry = this.lineage.find(e => e.generation === generation);
        if (!entry) throw new Error(`Unknown generation: ${generation}`);
        if (entry.kind === 'prompt') {
            if (entry.previousContent === null) this.promptSections.delete(entry.target);
            else this.promptSections.set(entry.target, entry.previousContent);
        } else if (this.memory && this.memory.procedural) {
            if (entry.previousContent !== null) {
                this.memory.procedural.register({ name: entry.target, source: entry.previousContent, description: 'rollback' });
            } else {
                this.memory.procedural.remove(entry.target);
            }
        }
        this.recordAudit('evolution.rollback', 'allow', { generation, target: entry.target });
        return entry;
    }

    /** Verifies the lineage hash chain (tamper evidence for the evolution history). */
    verifyLineage() {
        let prevHash = 'GENESIS';
        for (const entry of this.lineage) {
            const { hash, ...body } = entry;
            if (body.prevHash !== prevHash || EvolutionEngine.hash(JSON.stringify(body)) !== hash) {
                return { valid: false, brokenAt: entry.generation };
            }
            prevHash = hash;
        }
        return { valid: true, brokenAt: null };
    }
}

module.exports = { EvolutionEngine, PROTECTED_TARGETS, THREAT_PATTERNS };
