function escapeMarkdown(text) {
    return String(text ?? '').replace(/\r\n/g, '\n');
}

function escapePdfText(text) {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\r?\n/g, ' ');
}

function wrapText(text, maxLength = 92) {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ');
    const lines = [];
    let line = '';

    for (const word of words) {
        if ((line.length + word.length + 1) > maxLength) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }

    if (line)
        lines.push(line);

    return lines.length > 0 ? lines : [''];
}

export function conversationToMarkdown(conversation) {
    const lines = [
        `# ${escapeMarkdown(conversation.title)}`,
        '',
        `- Provider: ${conversation.providerId}`,
        `- Model: ${conversation.modelId || 'none'}`,
        `- Created: ${conversation.createdAt}`,
        `- Updated: ${conversation.updatedAt}`,
    ];

    if (conversation.folderId)
        lines.push(`- Folder: ${conversation.folderId}`);

    if (conversation.tags?.length > 0)
        lines.push(`- Tags: ${conversation.tags.join(', ')}`);

    lines.push('');

    for (const message of conversation.messages ?? []) {
        lines.push(`## ${message.role}`);
        lines.push('');
        lines.push(escapeMarkdown(message.content));
        lines.push('');
    }

    return `${lines.join('\n').trim()}\n`;
}

export function conversationToJson(conversation) {
    return `${JSON.stringify(conversation, null, 2)}\n`;
}

export function conversationToPdf(conversation) {
    const textLines = [
        conversation.title,
        `Provider: ${conversation.providerId} / ${conversation.modelId || 'none'}`,
        '',
        ...(conversation.messages ?? []).flatMap((message) => [
            `${message.role.toUpperCase()}:`,
            ...wrapText(message.content),
            '',
        ]),
    ];
    const content = [
        'BT',
        '/F1 11 Tf',
        '50 780 Td',
        '14 TL',
        ...textLines.slice(0, 52).map((line) => `(${escapePdfText(line)}) Tj T*`),
        'ET',
    ].join('\n');
    const objects = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
        '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
        `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];

    for (const object of objects) {
        offsets.push(pdf.length);
        pdf += `${object}\n`;
    }

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';

    for (const offset of offsets.slice(1))
        pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;

    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return pdf;
}

export function exportConversation(conversation, format) {
    switch (format) {
    case 'markdown':
        return conversationToMarkdown(conversation);
    case 'json':
        return conversationToJson(conversation);
    case 'pdf':
        return conversationToPdf(conversation);
    default:
        throw new Error(`Unsupported export format: ${format}`);
    }
}
