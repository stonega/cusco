import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('mailGoa/index.js');

export const {
    defaultMailGoaStatePath,
    extractGoaCredential,
    GoaMailAccountProvider,
    MAIL_GOA_CONNECTOR_TYPE,
    MAIL_TOOL_NAMES,
    MailGoaConnector,
    parseMailToolInput,
    StandardImapClient,
    StandardImapSession,
} = implementation;
