// Copyright 2026 Cusco contributors. SPDX-License-Identifier: Apache-2.0
// Only the extension page invoking this function can be added to a group.
let assigning = null;

async function assignCurrentTab({ title, groupId } = {}) {
    const label = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 80)
        throw new Error('Use a task title between 1 and 80 characters.');
    if (groupId !== undefined && (!Number.isInteger(groupId) || groupId < 0))
        throw new Error('Use the numeric group ID returned for this task.');

    const tab = await chrome.tabs.getCurrent();
    if (!Number.isInteger(tab?.id))
        throw new Error('Open the task.html extension page in a new task tab first.');

    const fullTitle = `Cusco · ${label}`;
    let targetId = groupId;
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        if (targetId !== undefined && targetId !== tab.groupId)
            throw new Error('This tab already belongs to another group. Open a new task tab.');
        targetId = tab.groupId;
    }
    if (targetId !== undefined) {
        const group = await chrome.tabGroups.get(targetId);
        if (group.title !== fullTitle)
            throw new Error('The group ID does not match this task title.');
    }

    const assignedId = await chrome.tabs.group({
        tabIds: [tab.id],
        ...(targetId === undefined ? {} : { groupId: targetId }),
    });
    await chrome.tabGroups.update(assignedId, {
        title: fullTitle,
        color: 'blue',
        collapsed: false,
    });
    const verified = await chrome.tabs.get(tab.id);
    if (verified.groupId !== assignedId)
        throw new Error('Chrome did not retain the task tab group.');
    return { groupId: assignedId, title: fullTitle, browserTabId: tab.id, windowId: verified.windowId };
}

globalThis.cuscoTaskGroup = Object.freeze({
    assign(options) {
        if (assigning)
            return Promise.reject(new Error('A grouping operation is already running for this tab.'));
        assigning = assignCurrentTab(options).finally(() => assigning = null);
        return assigning;
    },
});
