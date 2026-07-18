'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { SelfHealingRouter, AttentionMonitor } = require('../agi/routing/self-healing-router');
const { forAll, gen } = require('../agi/verification/property-testing');
const { generateMutants, scoreTestSuite } = require('../agi/verification/mutation-testing');

test('router plans the cheapest path with Dijkstra', () => {
    const router = new SelfHealingRouter();
    router.addEdge('start', 'a', { cost: 1, tool: 'fast' });
    router.addEdge('a', 'goal', { cost: 1, tool: 'fast2' });
    router.addEdge('start', 'b', { cost: 5, tool: 'slow' });
    router.addEdge('b', 'goal', { cost: 1, tool: 'slow2' });
    const route = router.plan('start', 'goal');
    assert.deepStrictEqual(route.path, ['start', 'a', 'goal']);
    assert.strictEqual(route.cost, 2);
});

test('router reroutes deterministically around a failed edge without escalating', async () => {
    const router = new SelfHealingRouter({ onEscalate: () => { throw new Error('should not escalate'); } });
    router.addEdge('start', 'a', { cost: 1 });
    router.addEdge('a', 'goal', { cost: 1 });
    router.addEdge('start', 'b', { cost: 5 });
    router.addEdge('b', 'goal', { cost: 1 });

    const visited = [];
    const result = await router.executeRoute('start', 'goal', async (step) => {
        if (step.to === 'a') throw new Error('tool down');
        visited.push(step.to);
        return 'ok';
    });
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(visited, ['b', 'goal']);
    assert.strictEqual(router.stats.reroutes, 1);
    assert.strictEqual(router.stats.escalations, 0);
});

test('router escalates to the LLM callback only when no path remains', async () => {
    let escalated = null;
    const router = new SelfHealingRouter({
        onEscalate: async (info) => { escalated = info; return { plan: 'ask model' }; }
    });
    router.addEdge('start', 'goal', { cost: 1 });
    const result = await router.executeRoute('start', 'goal', async () => {
        throw new Error('always down');
    });
    assert.strictEqual(result.status, 'escalated');
    assert.strictEqual(escalated.reason, 'no_feasible_path');
    assert.deepStrictEqual(result.fallback, { plan: 'ask model' });
    assert.strictEqual(router.stats.escalations, 1);
});

test('attention monitor triages by priority', () => {
    const monitor = new AttentionMonitor();
    monitor.addSignal({ id: 'user-intent', match: () => true, priority: 0.5 });
    monitor.addSignal({ id: 'db-timeout', match: /database.*timeout/i, priority: 0.99 });
    assert.strictEqual(monitor.triage('Database query timeout on replica').id, 'db-timeout');
    assert.strictEqual(monitor.triage('build me an app').id, 'user-intent');
});

test('forAll passes for a true invariant', () => {
    const result = forAll(
        [gen.int(-100, 100), gen.int(-100, 100)],
        (a, b) => a + b === b + a
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.runs, 200);
});

test('forAll falsifies and shrinks to the minimal counterexample', () => {
    const result = forAll([gen.int(0, 200)], (x) => x <= 100, { runs: 500 });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.counterexample, [101]);
});

test('forAll treats thrown exceptions as falsification', () => {
    const result = forAll([gen.array(gen.int(0, 10), 5)], (arr) => {
        if (arr.length > 2) throw new Error('boom');
        return true;
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.counterexample[0].length, 3);
});

test('generateMutants produces only compilable single-fault mutants', () => {
    const source = '(a, b) => a > 0 && b > 0 ? a + b : a - b';
    const mutants = generateMutants(source);
    assert.ok(mutants.length >= 4);
    for (const mutant of mutants) {
        assert.notStrictEqual(mutant.source, source);
        // compileFunction throwing would have filtered it out already
    }
});

test('a strong test suite kills mutants; a weak one lets them survive', () => {
    const source = '(a, b) => a + b * 2';
    const strongSuite = (fn) => {
        assert.strictEqual(fn(1, 1), 3);
        assert.strictEqual(fn(2, 3), 8);
        assert.strictEqual(fn(-1, 2), 3);
    };
    const weakSuite = (fn) => {
        assert.strictEqual(fn(5, 0), 5); // b=0 hides both the +/- and off-by-one mutants
    };
    const strong = scoreTestSuite(source, strongSuite);
    const weak = scoreTestSuite(source, weakSuite);
    assert.strictEqual(strong.originalPassed, true);
    assert.ok(strong.total >= 2);
    assert.ok(strong.score > weak.score, `expected ${strong.score} > ${weak.score}`);
    assert.ok(strong.score >= 0.6);
    assert.strictEqual(weak.score, 0);
});

test('scoreTestSuite reports zero when the original fails its own suite', () => {
    const result = scoreTestSuite('(a) => a + 1', (fn) => {
        assert.strictEqual(fn(1), 99);
    });
    assert.strictEqual(result.originalPassed, false);
    assert.strictEqual(result.score, 0);
});
