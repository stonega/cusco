import Gdk from 'gi://Gdk?version=4.0';

import { normalizeComposerReferences } from './presentation.js';
import {
    buildComposerHistoryEntries,
    composerHistoryDirection,
    composerReadlineAction,
    planComposerReadlineEdit,
} from './readline.js';

export class ComposerInputController {
    constructor({
        getBuffer,
        getText,
        setText,
        getReferences,
        setReferences,
        deleteReferenceAtCursor,
        getActiveConversation,
        getPendingMessages,
        isQuestionActive,
    }) {
        this._getBuffer = getBuffer;
        this._getText = getText;
        this._setText = setText;
        this._getReferences = getReferences;
        this._setReferences = setReferences;
        this._deleteReferenceAtCursor = deleteReferenceAtCursor;
        this._getActiveConversation = getActiveConversation;
        this._getPendingMessages = getPendingMessages;
        this._isQuestionActive = isQuestionActive;
        this._killText = '';
        this._history = null;
    }

    resetHistory() {
        this._history = null;
    }

    get killText() {
        return this._killText;
    }

    handleReadlineKey(keyval, state) {
        const action = composerReadlineAction(keyval, state);
        const buffer = this._getBuffer();

        if (!action || !buffer)
            return false;

        if (action === 'backward-delete-character'
            && this._deleteReferenceAtCursor(Gdk.KEY_BackSpace)) {
            return true;
        }

        if (action === 'delete-character'
            && this._deleteReferenceAtCursor(Gdk.KEY_Delete)) {
            return true;
        }

        const insertMark = buffer.get_insert();
        const selectionBoundMark = buffer.get_selection_bound();
        const cursorOffset = buffer.get_iter_at_mark(insertMark).get_offset();
        const selectionBoundOffset = buffer.get_iter_at_mark(selectionBoundMark).get_offset();
        const plan = planComposerReadlineEdit(
            this._getText(),
            cursorOffset,
            selectionBoundOffset,
            action,
            this._killText,
        );

        if (!plan)
            return false;

        if (plan.killedText !== undefined)
            this._killText = plan.killedText;

        if (plan.edit) {
            buffer.begin_user_action();
            buffer.delete(
                buffer.get_iter_at_offset(plan.edit.startOffset),
                buffer.get_iter_at_offset(plan.edit.endOffset),
            );

            if (plan.edit.replacement) {
                buffer.insert(
                    buffer.get_iter_at_offset(plan.edit.startOffset),
                    plan.edit.replacement,
                    -1,
                );
            }

            buffer.place_cursor(buffer.get_iter_at_offset(plan.cursorOffset));
            buffer.end_user_action();
        } else {
            buffer.place_cursor(buffer.get_iter_at_offset(plan.cursorOffset));
        }

        return true;
    }

    handleHistoryKey(keyval, state) {
        const buffer = this._getBuffer();
        const conversation = this._getActiveConversation();

        if (this._isQuestionActive(conversation?.id) || !buffer)
            return false;

        const insertMark = buffer.get_insert();
        const selectionBoundMark = buffer.get_selection_bound();
        const cursorOffset = buffer.get_iter_at_mark(insertMark).get_offset();
        const selectionBoundOffset = buffer.get_iter_at_mark(selectionBoundMark).get_offset();
        const direction = composerHistoryDirection(
            keyval,
            state,
            this._getText(),
            cursorOffset,
            selectionBoundOffset,
        );

        return direction === 0 ? false : this.navigateHistory(direction);
    }

    navigateHistory(direction) {
        const conversation = this._getActiveConversation();

        if (!conversation)
            return false;

        let history = this._history;

        if (!history || history.conversationId !== conversation.id) {
            const entries = buildComposerHistoryEntries(
                conversation.messages,
                this._getPendingMessages(conversation.id),
            );

            if (entries.length === 0)
                return false;

            history = {
                conversationId: conversation.id,
                entries,
                index: entries.length,
                draft: {
                    text: this._getText(),
                    references: this._getReferences(),
                },
            };
            this._history = history;
        }

        const currentEntry = {
            text: this._getText(),
            references: this._getReferences(),
        };

        if (history.index === history.entries.length)
            history.draft = currentEntry;
        else
            history.entries[history.index] = currentEntry;

        const nextIndex = history.index + direction;

        if (nextIndex < 0 || nextIndex > history.entries.length)
            return false;

        history.index = nextIndex;
        const nextEntry = nextIndex === history.entries.length
            ? history.draft
            : history.entries[nextIndex];
        this._setReferences(normalizeComposerReferences(nextEntry.references));
        this._setText(nextEntry.text, {
            preserveHistory: true,
            preserveReferences: true,
        });
        return true;
    }
}
