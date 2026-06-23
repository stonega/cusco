export const TOOL_PERMISSION_ALLOW = 'allow';
export const TOOL_PERMISSION_ASK = 'ask';
export const TOOL_PERMISSION_DENY = 'deny';

const VALID_PERMISSION_POLICIES = new Set([
    TOOL_PERMISSION_ALLOW,
    TOOL_PERMISSION_ASK,
    TOOL_PERMISSION_DENY,
]);

export function normalizePermissionPolicy(policy, { requiresPermission = true } = {}) {
    const normalized = String(policy ?? '').trim().toLowerCase();

    if (VALID_PERMISSION_POLICIES.has(normalized))
        return normalized;

    return requiresPermission ? TOOL_PERMISSION_ASK : TOOL_PERMISSION_ALLOW;
}

export function createToolPermissionDecision(request, options = {}) {
    if (options.autoModeEnabled) {
        return {
            policy: TOOL_PERMISSION_ALLOW,
            status: 'allow',
            requiresUserApproval: false,
            reason: '',
        };
    }

    const permissionPolicy = normalizePermissionPolicy(request?.permissionPolicy, {
        requiresPermission: request?.requiresPermission !== false,
    });

    if (permissionPolicy === TOOL_PERMISSION_DENY) {
        return {
            policy: permissionPolicy,
            status: 'deny',
            requiresUserApproval: false,
            reason: `${request?.label ?? request?.name ?? 'Tool'} is blocked by policy.`,
        };
    }

    if (permissionPolicy === TOOL_PERMISSION_ASK) {
        return {
            policy: permissionPolicy,
            status: 'ask',
            requiresUserApproval: true,
            reason: `${request?.label ?? request?.name ?? 'Tool'} needs approval before it can run.`,
        };
    }

    return {
        policy: permissionPolicy,
        status: 'allow',
        requiresUserApproval: false,
        reason: '',
    };
}
