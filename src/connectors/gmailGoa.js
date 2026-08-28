import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('gmailGoa/index.js');

export const {
    defaultGmailGoaStatePath,
    extractGoaAccessToken,
    GMAIL_GOA_CONNECTOR_TYPE,
    GMAIL_TOOL_NAMES,
    GmailGoaConnector,
    GmailImapClient,
    GoaGoogleAccountProvider,
    ImapSession,
    normalizeGmailNumericId,
    parseGmailToolInput,
    parseImapFetchRecords,
} = implementation;
