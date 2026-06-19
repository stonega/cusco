import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { ConversationFileStore } from './storage/conversationStore.js';

const APP_ID = 'io.github.stonega.Cusco';
const SEARCH_PROVIDER_PATH = '/io/github/stonega/Cusco/SearchProvider';
const SEARCH_PROVIDER_XML = `
<node>
  <interface name="org.gnome.Shell.SearchProvider2">
    <method name="GetInitialResultSet">
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetSubsearchResultSet">
      <arg type="as" name="previous_results" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetResultMetas">
      <arg type="as" name="identifiers" direction="in"/>
      <arg type="aa{sv}" name="metas" direction="out"/>
    </method>
    <method name="ActivateResult">
      <arg type="s" name="identifier" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="LaunchSearch">
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
  </interface>
</node>`;

function normalizeQuery(terms) {
    return terms.join(' ').trim().toLowerCase();
}

function conversationMatches(conversation, query) {
    if (!query)
        return false;

    if (conversation.title.toLowerCase().includes(query))
        return true;

    return conversation.messages.some((message) => message.content.toLowerCase().includes(query));
}

function snippetForConversation(conversation, query) {
    const message = conversation.messages.find((item) => item.content.toLowerCase().includes(query));

    if (!message)
        return conversation.messages.at(-1)?.content ?? 'Cusco conversation';

    return message.content.length > 160
        ? `${message.content.slice(0, 157)}...`
        : message.content;
}

export class ConversationSearchIndex {
    constructor(store = new ConversationFileStore()) {
        this._store = store;
    }

    search(terms, { limit = 20 } = {}) {
        const query = normalizeQuery(terms);
        const database = this._store.load();

        return database.conversations
            .filter((conversation) => !conversation.archived)
            .filter((conversation) => conversationMatches(conversation, query))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, limit)
            .map((conversation) => conversation.id);
    }

    metas(identifiers, terms = []) {
        const query = normalizeQuery(terms);
        const database = this._store.load();
        const conversationsById = new Map(database.conversations.map((conversation) => [conversation.id, conversation]));

        return identifiers
            .map((identifier) => conversationsById.get(identifier))
            .filter(Boolean)
            .map((conversation) => ({
                id: conversation.id,
                name: conversation.title,
                description: snippetForConversation(conversation, query),
            }));
    }
}

class ShellSearchProvider {
    constructor(application) {
        this._application = application;
        this._index = new ConversationSearchIndex();
        this._lastTerms = [];
    }

    GetInitialResultSet(terms) {
        this._lastTerms = terms;
        return this._index.search(terms);
    }

    GetSubsearchResultSet(_previousResults, terms) {
        this._lastTerms = terms;
        return this._index.search(terms);
    }

    GetResultMetas(identifiers) {
        return this._index.metas(identifiers, this._lastTerms).map((meta) => ({
            id: new GLib.Variant('s', meta.id),
            name: new GLib.Variant('s', meta.name),
            description: new GLib.Variant('s', meta.description),
            gicon: new GLib.Variant('s', APP_ID),
        }));
    }

    ActivateResult(identifier, _terms, _timestamp) {
        this._application.activate();
        this._application.active_window?.selectConversation(identifier);
    }

    LaunchSearch(terms, _timestamp) {
        this._application.activate();
        this._application.active_window?.focusComposer();

        if (terms.length > 0)
            this._application.active_window?.setComposerText(terms.join(' '));
    }
}

export function installSearchProvider(application) {
    const connection = application.get_dbus_connection();

    if (!connection)
        return null;

    const exported = Gio.DBusExportedObject.wrapJSObject(
        SEARCH_PROVIDER_XML,
        new ShellSearchProvider(application),
    );
    exported.export(connection, SEARCH_PROVIDER_PATH);
    return exported;
}
