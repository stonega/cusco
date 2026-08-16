import Cairo from 'cairo';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    composerHintPresentation,
} from './presentation.js';
import {
    estimateConversationUsage,
    summarizeConversationStatistics,
} from './usage.js';

const COMPOSER_USAGE_UPDATE_DELAY_MS = 80;

function trimFixedNumber(value, fractionDigits) {
    return value.toFixed(fractionDigits).replace(/\.?0+$/, '');
}

function normalizeContextWindowTokens(value) {
    const tokens = Number(value);

    return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
}

function formatCompactTokenCount(tokens) {
    const normalized = normalizeContextWindowTokens(tokens);

    if (normalized >= 1000000)
        return `${trimFixedNumber(normalized / 1000000, 2)}m`;

    if (normalized >= 1000)
        return `${trimFixedNumber(normalized / 1000, 1)}k`;

    return String(normalized);
}

function formatTokenCount(tokens) {
    return `${formatCompactTokenCount(tokens)} tokens`;
}

function formatContextUsagePercent(tokens, contextWindowTokens) {
    const normalizedContextWindowTokens = normalizeContextWindowTokens(contextWindowTokens);

    if (!normalizedContextWindowTokens)
        return '';

    const percentage = (Math.max(0, Number(tokens) || 0) / normalizedContextWindowTokens) * 100;

    if (percentage === 0)
        return '0%';

    if (percentage < 0.1)
        return '<0.1%';

    if (percentage < 10)
        return `${trimFixedNumber(percentage, 1)}%`;

    return `${Math.round(percentage)}%`;
}

function formatStatisticCount(value) {
    return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
}

function formatStatisticNoun(count, singular, plural = `${singular}s`) {
    return `${formatStatisticCount(count)} ${count === 1 ? singular : plural}`;
}

export function drawContextUsageChart(cr, width, height, fraction, color) {
    const size = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(1, (size / 2) - 2);
    const lineWidth = Math.max(2, size / 6);
    const clampedFraction = Math.min(1, Math.max(0, Number(fraction) || 0));

    cr.save();
    cr.setLineWidth(lineWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);

    cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha * 0.18);
    cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
    cr.stroke();

    if (clampedFraction > 0) {
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
        cr.arc(
            centerX,
            centerY,
            radius,
            -Math.PI / 2,
            (-Math.PI / 2) + (Math.PI * 2 * clampedFraction),
        );
        cr.stroke();
    }

    cr.restore();
}

export class ComposerUsageController {
    constructor({
        appSettings,
        conversations,
        providerConfigs,
        getState,
        setState,
        getComposerText,
        isConversationUsingComputer,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._providerConfigs = providerConfigs;
        this._getComposerText = getComposerText;
        this._isConversationUsingComputer = isConversationUsingComputer;

        for (const name of [
            '_chatStatisticsLabels',
            '_composerHint',
            '_composerUsageChart',
            '_composerUsageDetailLabel',
            '_composerUsageFraction',
            '_composerUsagePercentLabel',
            '_composerUsageSyncSourceId',
            '_composerUsageTitleLabel',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
    }

    _getUsageMessages(conversation, {
        pendingAssistantText = '',
        includeComposerDraft = false,
    } = {}) {
        const messages = [...(conversation?.messages ?? [])];

        if (pendingAssistantText)
            messages.push({ content: pendingAssistantText });

        if (includeComposerDraft) {
            const draft = this._getComposerText().trim();

            if (draft)
                messages.push({ content: draft });
        }

        return messages;
    }

    _getContextWindowTokens(conversation) {
        if (!conversation)
            return 0;

        const { model } = this._providerConfigs.resolve(conversation.providerId, conversation.modelId);

        return normalizeContextWindowTokens(model?.contextWindowTokens);
    }

    _createComposerUsagePopover() {
        const popover = new Gtk.Popover({
            position: Gtk.PositionType.TOP,
            autohide: false,
        });
        popover.add_css_class('cusco-context-usage-popover');
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });

        this._composerUsageTitleLabel = new Gtk.Label({
            label: 'Context window:',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        this._composerUsageTitleLabel.add_css_class('caption');
        this._composerUsageTitleLabel.add_css_class('dim-label');

        this._composerUsagePercentLabel = new Gtk.Label({
            label: '0% full',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });

        this._composerUsageDetailLabel = new Gtk.Label({
            label: '0 / unknown tokens used',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        this._composerUsageDetailLabel.add_css_class('caption');

        content.append(this._composerUsageTitleLabel);
        content.append(this._composerUsagePercentLabel);
        content.append(this._composerUsageDetailLabel);
        popover.set_child(content);
        return popover;
    }

    _createChatStatisticsPopover() {
        const popover = new Gtk.Popover({
            position: Gtk.PositionType.BOTTOM,
            autohide: false,
        });
        popover.add_css_class('cusco-chat-statistics-popover');
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 14,
            margin_end: 14,
        });
        const labels = {};
        const createSection = (heading, rows) => {
            const section = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 5,
            });
            const headingLabel = new Gtk.Label({
                label: heading,
                xalign: 0,
            });
            headingLabel.add_css_class('heading');
            section.append(headingLabel);
            const grid = new Gtk.Grid({
                row_spacing: 3,
                column_spacing: 24,
            });

            rows.forEach(([key, label, indent], row) => {
                const nameLabel = new Gtk.Label({
                    label,
                    xalign: 0,
                    hexpand: true,
                    margin_start: indent ? 12 : 0,
                });
                const valueLabel = new Gtk.Label({
                    label: '0',
                    xalign: 1,
                    halign: Gtk.Align.END,
                });
                valueLabel.add_css_class('cusco-chat-statistics-value');
                grid.attach(nameLabel, 0, row, 1, 1);
                grid.attach(valueLabel, 1, row, 1, 1);
                labels[key] = valueLabel;
            });

            section.append(grid);
            content.append(section);
        };

        createSection('Messages', [
            ['totalMessages', 'Total'],
            ['userMessages', 'User'],
            ['assistantMessages', 'Assistant'],
            ['tools', 'Tools'],
        ]);
        content.append(new Gtk.Separator({
            orientation: Gtk.Orientation.VERTICAL,
        }));
        createSection('Tokens', [
            ['cachedInputTokens', 'Cached'],
            ['uncachedInputTokens', 'Uncached'],
            ['outputTokens', 'Output'],
            ['totalTokens', 'Total'],
        ]);

        this._chatStatisticsLabels = labels;
        popover.set_child(content);
        return popover;
    }

    _syncChatStatisticsPopover(conversation) {
        if (!this._chatStatisticsLabels)
            return;

        const statistics = summarizeConversationStatistics(conversation?.messages);
        const cachedPercentage = statistics.inputTokens > 0
            ? (statistics.cachedInputTokens / statistics.inputTokens) * 100
            : 0;
        const labels = this._chatStatisticsLabels;

        labels.totalMessages.set_label(formatStatisticCount(statistics.totalMessages));
        labels.userMessages.set_label(formatStatisticCount(statistics.userMessages));
        labels.assistantMessages.set_label(formatStatisticCount(statistics.assistantMessages));
        labels.tools.set_label([
            formatStatisticNoun(statistics.toolCalls, 'call'),
            formatStatisticNoun(statistics.toolResults, 'result'),
        ].join(', '));
        labels.cachedInputTokens.set_label(
            `${formatStatisticCount(statistics.cachedInputTokens)} (${
                cachedPercentage.toFixed(1)
            }%)`,
        );
        labels.uncachedInputTokens.set_label(
            formatStatisticCount(statistics.uncachedInputTokens),
        );
        labels.outputTokens.set_label(formatStatisticCount(statistics.outputTokens));
        labels.totalTokens.set_label(formatStatisticCount(statistics.totalTokens));
    }

    _syncComposerUsageChart(baseUsage = null, conversation = this._conversations.activeConversation) {
        if (!this._composerUsageChart)
            return;

        let usage = baseUsage;

        if (usage) {
            const draft = this._getComposerText().trim();

            if (draft) {
                const draftUsage = estimateConversationUsage([{ content: draft }]);
                usage = {
                    characters: usage.characters + draftUsage.characters,
                    messages: usage.messages + draftUsage.messages,
                    tokens: usage.tokens + draftUsage.tokens,
                };
            }
        } else {
            usage = estimateConversationUsage(this._getUsageMessages(conversation, {
                includeComposerDraft: true,
            }));
        }

        const contextWindowTokens = this._getContextWindowTokens(conversation);
        this._composerUsageFraction = contextWindowTokens > 0
            ? usage.tokens / contextWindowTokens
            : 0;

        this._composerUsageChart.set_tooltip_text('');
        if (contextWindowTokens > 0) {
            this._composerUsagePercentLabel?.set_label(
                `${formatContextUsagePercent(usage.tokens, contextWindowTokens)} full`,
            );
            this._composerUsageDetailLabel?.set_label(
                `${formatCompactTokenCount(usage.tokens)} / ${
                    formatTokenCount(contextWindowTokens)
                } used`,
            );
        } else {
            this._composerUsagePercentLabel?.set_label('Unknown');
            this._composerUsageDetailLabel?.set_label(`${usage.tokens} est. tokens used`);
        }
        this._composerUsageChart.queue_draw();
    }

    _scheduleComposerUsageChartSync() {
        if (this._composerUsageSyncSourceId)
            GLib.Source.remove(this._composerUsageSyncSourceId);

        this._composerUsageSyncSourceId = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            COMPOSER_USAGE_UPDATE_DELAY_MS,
            () => {
                this._composerUsageSyncSourceId = 0;
                this._syncComposerUsageChart();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _syncComposerHint(
        isBusy = false,
        computerUseActive = this._isConversationUsingComputer(
            this._conversations.activeConversation?.id,
        ),
    ) {
        if (!this._composerHint)
            return;

        const presentation = composerHintPresentation(
            this._appSettings.sendWithEnter,
            isBusy,
            computerUseActive,
        );

        if (presentation.markup) {
            this._composerHint.remove_css_class('dim-label');
            this._composerHint.set_markup(presentation.markup);
        } else {
            this._composerHint.add_css_class('dim-label');
            this._composerHint.set_label(presentation.label);
        }
    }

}
