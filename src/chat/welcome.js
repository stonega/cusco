import { createMessage } from '../providers/provider.js';

export const WELCOME_CONVERSATION_TITLE = 'Welcome to Cusco';
export const WELCOME_MESSAGE_KIND = 'welcome';
export const WELCOME_MESSAGE_CONTENT = [
    'Cusco is a native GNOME app for chatting with AI, working with files, and using tools—all from your desktop.',
    'Quick start: choose a provider and model above, then type a question or task below.',
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
