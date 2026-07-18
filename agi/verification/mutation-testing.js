'use strict';

/**
 * Mutation-guided test validation.
 *
 * Line/branch coverage is a weak proxy for fault detection — a suite can hit
 * 100% coverage yet kill almost no realistic faults. This module generates
 * semantic mutants of a pure function's source (operator swaps, boundary
 * shifts, constant perturbations that mimic real developer errors), discards
 * anything that doesn't compile, and scores a test suite by its mutant kill
 * rate. The evolution engine refuses to commit code whose companion tests
 * fall below the configured kill threshold.
 */

const MUTATION_RULES = [
    { name: 'eq-to-neq', pattern: /===/g, replacement: '!==' },
    { name: 'neq-to-eq', pattern: /!==/g, replacement: '===' },
    { name: 'lte-to-lt', pattern: /<=/g, replacement: '<' },
    { name: 'gte-to-gt', pattern: />=/g, replacement: '>' },
    { name: 'lt-to-lte', pattern: /<(?![=<])/g, replacement: '<=' },
    { name: 'gt-to-gte', pattern: /(?<![=>\-])>(?!=)/g, replacement: '>=' },
    { name: 'and-to-or', pattern: /&&/g, replacement: '||' },
    { name: 'or-to-and', pattern: /\|\|/g, replacement: '&&' },
    { name: 'plus-to-minus', pattern: /(?<![+])\+(?![+=])/g, replacement: '-' },
    { name: 'minus-to-plus', pattern: /(?<![-])-(?![-=>])/g, replacement: '+' },
    { name: 'true-to-false', pattern: /\btrue\b/g, replacement: 'false' },
    { name: 'false-to-true', pattern: /\bfalse\b/g, replacement: 'true' },
    { name: 'off-by-one', pattern: /\b(\d+)\b/g, replacement: (m) => String(Number(m) + 1) }
];

function compileFunction(source) {
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return (${source});`)();
}

function isCompilable(source) {
    try {
        const fn = compileFunction(source);
        return typeof fn === 'function';
    } catch (err) {
        return false;
    }
}

/**
 * Generates single-fault mutants: each mutant differs from the original by
 * exactly one mutated occurrence, mirroring how real bugs are introduced.
 *
 * @param {string} source function source text
 * @param {object} [options] { maxMutants = 60 }
 * @returns {Array<{rule: string, index: number, source: string}>}
 */
function generateMutants(source, options = {}) {
    const { maxMutants = 60 } = options;
    const mutants = [];
    const seen = new Set();

    for (const rule of MUTATION_RULES) {
        const matches = [...source.matchAll(rule.pattern)];
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const replacement = typeof rule.replacement === 'function'
                ? rule.replacement(match[0])
                : rule.replacement;
            const mutated =
                source.slice(0, match.index) +
                replacement +
                source.slice(match.index + match[0].length);
            if (mutated === source || seen.has(mutated)) continue;
            if (!isCompilable(mutated)) continue;
            seen.add(mutated);
            mutants.push({ rule: rule.name, index: match.index, source: mutated });
            if (mutants.length >= maxMutants) return mutants;
        }
    }
    return mutants;
}

/**
 * Scores a test suite by mutant kill rate.
 *
 * @param {string} source pure function source (must compile)
 * @param {function} testSuite (fn) => void — throws (or returns false) to fail
 * @param {object} [options] { maxMutants }
 * @returns {{score: number, total: number, killed: number, survivors: Array, originalPassed: boolean}}
 */
function scoreTestSuite(source, testSuite, options = {}) {
    const passes = (fn) => {
        try {
            return testSuite(fn) !== false;
        } catch (err) {
            return false;
        }
    };

    if (!isCompilable(source)) {
        throw new Error('Original source does not compile');
    }
    const originalPassed = passes(compileFunction(source));
    if (!originalPassed) {
        return { score: 0, total: 0, killed: 0, survivors: [], originalPassed: false };
    }

    const mutants = generateMutants(source, options);
    const survivors = [];
    let killed = 0;
    for (const mutant of mutants) {
        if (passes(compileFunction(mutant.source))) {
            survivors.push({ rule: mutant.rule, index: mutant.index });
        } else {
            killed += 1;
        }
    }
    return {
        score: mutants.length ? killed / mutants.length : 1,
        total: mutants.length,
        killed,
        survivors,
        originalPassed: true
    };
}

module.exports = { generateMutants, scoreTestSuite, compileFunction, MUTATION_RULES };
