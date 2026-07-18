'use strict';

/**
 * Role-based access control with permission globs and role inheritance.
 *
 *   rbac.defineRole('operator', ['tool:read.*', 'tool:search.*']);
 *   rbac.defineRole('admin', ['*'], { inherits: ['operator'] });
 *   rbac.can('operator', 'tool:read.file')  -> true
 *   rbac.can('operator', 'tool:shell.exec') -> false
 */

function permissionMatches(pattern, permission) {
    if (pattern === '*' || pattern === permission) return true;
    if (pattern.endsWith('*')) return permission.startsWith(pattern.slice(0, -1));
    return false;
}

class RBAC {
    constructor() {
        this.roles = new Map(); // name -> { permissions: string[], inherits: string[] }
    }

    defineRole(name, permissions = [], options = {}) {
        this.roles.set(name, {
            permissions: [...permissions],
            inherits: [...(options.inherits || [])]
        });
        return this;
    }

    grant(roleName, permission) {
        const role = this.roles.get(roleName);
        if (!role) throw new Error(`Unknown role: ${roleName}`);
        role.permissions.push(permission);
        return this;
    }

    resolvePermissions(roleName, seen = new Set()) {
        if (seen.has(roleName)) return []; // guard against inheritance cycles
        seen.add(roleName);
        const role = this.roles.get(roleName);
        if (!role) return [];
        const inherited = role.inherits.flatMap(parent => this.resolvePermissions(parent, seen));
        return [...role.permissions, ...inherited];
    }

    can(roleName, permission) {
        return this.resolvePermissions(roleName)
            .some(pattern => permissionMatches(pattern, permission));
    }
}

module.exports = { RBAC };
