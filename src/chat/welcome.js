import { createMessage } from '../providers/provider.js';

export const WELCOME_CONVERSATION_TITLE = 'Welcome to Cusco';
export const WELCOME_MESSAGE_KIND = 'welcome';
export const WELCOME_MESSAGE_CONTENT = [
    '# Welcome to Cusco',
    'Cusco brings AI into a focused, native GNOME workspace. You can explore ideas, work with local files, and use tools without leaving your desktop.',
    [
        '## What you can do',
        '',
        '- **Ask and explore.** Draft, explain, compare, summarize, or work through a difficult problem.',
        '- **Work with files.** Attach documents and images to give Cusco the context it needs.',
        '- **Get things done.** Agent mode can use available tools and follow a task through multiple steps.',
        '- **Reuse your workflow.** Skills add specialized instructions for work you do repeatedly.',
    ].join('\n'),
    [
        '## Quick start',
        '',
        '1. Configure a provider if you have not already.',
        '2. Choose the provider and model you want to use.',
        '3. Describe what you need in the message box below.',
    ].join('\n'),
    '> Tip: Agent starts enabled, and enabled Skills are included in new chats. Memory starts off, so you decide when Cusco may use saved context.',
].join('\n\n');

const LEGACY_WELCOME_MESSAGES = [
    {
        role: 'assistant',
        content: 'Ask a question, compare providers, or start building a reusable AI workflow.',
    },
    {
        role: 'system',
        content: 'Next steps: markdown rendering, memory controls, web search, and desktop integration.',
    },
];

export function createWelcomeMessage() {
    return createMessage('assistant', WELCOME_MESSAGE_CONTENT, {
        metadata: { kind: WELCOME_MESSAGE_KIND },
    });
}

export function isWelcomeMessage(message) {
    return message?.role === 'assistant'
        && message?.metadata?.kind === WELCOME_MESSAGE_KIND;
}

export function isLegacyWelcomeConversation(conversation) {
    if (conversation?.title !== WELCOME_CONVERSATION_TITLE
        || conversation?.messages?.length !== LEGACY_WELCOME_MESSAGES.length) {
        return false;
    }

    return LEGACY_WELCOME_MESSAGES.every((legacyMessage, index) => {
        const message = conversation.messages[index];
        return message?.role === legacyMessage.role
            && message?.content === legacyMessage.content;
    });
}

export function welcomeStreamFrame(content, visibleCharacters) {
    const characters = [...String(content ?? '')];
    const end = Math.min(
        characters.length,
        Math.max(0, Math.floor(Number(visibleCharacters) || 0)),
    );
    return characters.slice(0, end).join('');
}
