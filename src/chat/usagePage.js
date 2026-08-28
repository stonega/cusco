import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { getProviderGIcon } from '../providers/icons.js';
import { createProviderIconPileView } from './providerIconPileView.js';
import { summarizeUsageDashboard } from './usage.js';
import {
    dailyUsageDateLabelIndices,
    dailyUsageIndexAtX,
    easeOutCubic,
    shouldKeepDailyUsageTooltipVisible,
} from './usageChart.js';
import {
    clearContainer,
    drawDailyUsageChart,
    formatStatisticCount,
    formatStatisticNoun,
    formatUsageDate,
    formatUsageNumberMarkup,
    setUsageNumberLabel,
} from './usagePagePresentation.js';

export { formatUsageNumberMarkup } from './usagePagePresentation.js';

const DAILY_USAGE_CHART_REVEAL_DURATION_US = 280 * 1000;

export class UsagePage {
    constructor({ conversations, providerConfigs, onBack = () => {} }) {
        this._conversations = conversations;
        this._providerConfigs = providerConfigs;
        this._onBack = onBack;
        this._widget = null;
        this._periodDays = 30;
        this._refreshSourceId = 0;
        this._chartAnimationTickId = 0;
        this._chartTooltipHideSourceId = 0;
    }

    get widget() {
        this._widget ??= this._createSurface();
        return this._widget;
    }

    cancelRefresh() {
        if (!this._refreshSourceId)
            return;
        GLib.Source.remove(this._refreshSourceId);
        this._refreshSourceId = 0;
    }

    dispose() {
        this.cancelRefresh();
        this._stopChartAnimation();
        this._cancelChartTooltipHide?.();
        this._cancelChartTooltipHide = null;
        this._providerIconPile?.stop();

        if (this._chartTooltip) {
            this._chartTooltip.popdown();
            this._chartTooltip.unparent();
            this._chartTooltip = null;
        }
    }

    _createMetricLabels(title) {
        const titleLabel = new Gtk.Label({
            label: title,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        titleLabel.add_css_class('caption');
        titleLabel.add_css_class('dim-label');
        const valueLabel = new Gtk.Label({
            label: '0',
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        valueLabel.add_css_class('title-2');
        valueLabel.add_css_class('cusco-chat-statistics-value');
        valueLabel.add_css_class('cusco-usage-number');
        setUsageNumberLabel(valueLabel, '0');
        return { titleLabel, valueLabel };
    }

    _createMetricCard(title) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            width_request: 175,
        });
        card.add_css_class('card');
        card.add_css_class('cusco-usage-metric-card');
        const { titleLabel, valueLabel } = this._createMetricLabels(title);
        const detailLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true });
        detailLabel.add_css_class('caption');
        detailLabel.add_css_class('dim-label');
        card.append(titleLabel);
        card.append(valueLabel);
        card.append(detailLabel);
        return { card, valueLabel, detailLabel };
    }

    _createSurface() {
        const toolbarView = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();

        const backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: 'Back to chat',
        });
        backButton.connect('clicked', () => this._onBack());
        headerBar.pack_start(backButton);

        const periodButtons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
        periodButtons.add_css_class('linked');
        let firstPeriodButton = null;
        for (const days of [7, 30, 90]) {
            const button = new Gtk.ToggleButton({
                label: `${days} days`,
                active: days === this._periodDays,
            });
            if (firstPeriodButton)
                button.set_group(firstPeriodButton);
            else
                firstPeriodButton = button;
            button.connect('toggled', () => {
                if (!button.get_active())
                    return;
                this._periodDays = days;
                this.refresh();
            });
            periodButtons.append(button);
        }
        headerBar.set_title_widget(periodButtons);

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh usage',
        });
        refreshButton.connect('clicked', () => this.refresh());
        headerBar.pack_end(refreshButton);
        toolbarView.add_top_bar(headerBar);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            margin_top: 24,
            margin_bottom: 32,
            margin_start: 24,
            margin_end: 24,
        });
        const overview = new Adw.WrapBox({
            orientation: Gtk.Orientation.HORIZONTAL,
            child_spacing: 16,
            line_spacing: 16,
            justify: Adw.JustifyMode.FILL,
            justify_last_line: Adw.JustifyMode.FILL,
            line_homogeneous: false,
            wrap_policy: Adw.WrapPolicy.MINIMUM,
            hexpand: true,
            vexpand: false,
            valign: Gtk.Align.START,
        });

        const totalCard = new Gtk.Overlay({ width_request: 245 });
        totalCard.add_css_class('card');
        totalCard.add_css_class('cusco-usage-total-card');
        this._providerIconPile = createProviderIconPileView(this._providerConfigs);
        totalCard.set_child(this._providerIconPile.widget);
        const totalContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 7,
            hexpand: true,
            vexpand: true,
            valign: Gtk.Align.START,
            can_target: false,
            margin_top: 20,
            margin_bottom: 20,
            margin_start: 20,
            margin_end: 20,
        });
        totalCard.add_overlay(totalContent);
        totalCard.set_measure_overlay(totalContent, true);
        totalCard.set_clip_overlay(totalContent, true);
        const totalHeading = new Gtk.Label({ label: 'TOTAL TOKENS', xalign: 0 });
        totalHeading.add_css_class('caption');
        totalHeading.add_css_class('dim-label');
        this._totalTokensLabel = new Gtk.Label({ label: '0', xalign: 0 });
        this._totalTokensLabel.add_css_class('title-1');
        this._totalTokensLabel.add_css_class('cusco-chat-statistics-value');
        this._totalTokensLabel.add_css_class('cusco-usage-number');
        setUsageNumberLabel(this._totalTokensLabel, '0');
        const secondaryTotals = new Gtk.Grid({
            column_spacing: 20,
            row_spacing: 12,
            column_homogeneous: true,
            margin_top: 8,
        });
        const createSecondaryTotal = (title, column, row) => {
            const metric = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4,
                hexpand: true,
            });
            const { titleLabel, valueLabel } = this._createMetricLabels(title);
            metric.append(titleLabel);
            metric.append(valueLabel);
            secondaryTotals.attach(metric, column, row, 1, 1);
            return valueLabel;
        };
        this._conversationCountLabel = createSecondaryTotal('CONVERSATIONS', 0, 0);
        this._messageCountLabel = createSecondaryTotal('MESSAGES', 1, 0);
        this._providerCountLabel = createSecondaryTotal('PROVIDERS', 0, 1);
        this._modelCountLabel = createSecondaryTotal('MODELS', 1, 1);
        this._totalStatusLabel = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        this._totalStatusLabel.add_css_class('caption');
        this._totalStatusLabel.add_css_class('dim-label');
        totalContent.append(totalHeading);
        totalContent.append(this._totalTokensLabel);
        totalContent.append(secondaryTotals);
        totalContent.append(this._totalStatusLabel);

        const chartCard = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
        });
        chartCard.add_css_class('card');
        chartCard.add_css_class('cusco-usage-chart-card');
        const chartHeader = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 });
        const chartHeading = new Gtk.Label({
            label: 'Daily tokens',
            xalign: 0,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        chartHeading.add_css_class('heading');
        const chartTodayTotal = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            halign: Gtk.Align.END,
        });
        const chartTodayTotalHeading = new Gtk.Label({ label: 'TODAY TOTAL', xalign: 1 });
        chartTodayTotalHeading.add_css_class('caption');
        chartTodayTotalHeading.add_css_class('dim-label');
        this._todayTotalLabel = new Gtk.Label({ label: '0 tokens', xalign: 1 });
        this._todayTotalLabel.add_css_class('cusco-usage-number');
        setUsageNumberLabel(this._todayTotalLabel, '0 tokens');
        chartTodayTotal.append(chartTodayTotalHeading);
        chartTodayTotal.append(this._todayTotalLabel);
        chartHeader.append(chartHeading);
        chartHeader.append(chartTodayTotal);
        this._chartData = [];
        this._chartHoveredIndex = -1;
        this._chartAnimationProgress = 1;
        this._chart = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: false,
            valign: Gtk.Align.START,
            content_height: 210,
            content_width: 360,
            accessible_role: Gtk.AccessibleRole.IMG,
        });
        this._chart.add_css_class('cusco-usage-chart');
        this._chart.set_draw_func((widget, cr, width, height) => drawDailyUsageChart(
            cr,
            width,
            height,
            this._chartData,
            widget.get_color(),
            this._chartHoveredIndex,
            this._chartAnimationProgress,
        ));

        const tooltipContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 10,
            margin_end: 10,
        });
        this._chartTooltipDateLabel = new Gtk.Label();
        this._chartTooltipDateLabel.add_css_class('caption');
        this._chartTooltipDateLabel.add_css_class('dim-label');
        this._chartTooltipValueLabel = new Gtk.Label();
        this._chartTooltipValueLabel.add_css_class('heading');
        this._chartTooltipValueLabel.add_css_class('cusco-usage-number');
        tooltipContent.append(this._chartTooltipDateLabel);
        tooltipContent.append(this._chartTooltipValueLabel);
        this._chartTooltip = new Gtk.Popover({
            child: tooltipContent,
            position: Gtk.PositionType.TOP,
            autohide: false,
            can_target: true,
        });
        this._chartTooltip.set_parent(this._chart);

        const chartMotionController = new Gtk.EventControllerMotion();
        const tooltipMotionController = new Gtk.EventControllerMotion();
        const cancelTooltipHide = () => {
            if (!this._chartTooltipHideSourceId)
                return;
            GLib.Source.remove(this._chartTooltipHideSourceId);
            this._chartTooltipHideSourceId = 0;
        };
        const hideTooltip = () => {
            this._chartHoveredIndex = -1;
            this._chartTooltip.popdown();
            this._chart.queue_draw();
        };
        const scheduleTooltipHide = () => {
            if (this._chartTooltipHideSourceId)
                return;
            this._chartTooltipHideSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._chartTooltipHideSourceId = 0;
                if (shouldKeepDailyUsageTooltipVisible(
                    chartMotionController.contains_pointer,
                    tooltipMotionController.contains_pointer,
                )) {
                    return GLib.SOURCE_REMOVE;
                }
                hideTooltip();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._cancelChartTooltipHide = cancelTooltipHide;
        const updateChartHover = (x) => {
            cancelTooltipHide();
            const hoveredIndex = dailyUsageIndexAtX(this._chartData, this._chart.get_width(), x);
            if (hoveredIndex < 0)
                return;
            if (this._chartHoveredIndex !== hoveredIndex) {
                const entry = this._chartData[hoveredIndex];
                const point = revealDailyUsageChartPoints(
                    buildDailyUsageChartPoints(
                        this._chartData,
                        this._chart.get_width(),
                        this._chart.get_height(),
                    ),
                    this._chart.get_height(),
                    this._chartAnimationProgress,
                )[hoveredIndex];
                if (!entry || !point)
                    return;
                this._chartTooltipDateLabel.set_label(formatUsageDate(entry.date));
                setUsageNumberLabel(
                    this._chartTooltipValueLabel,
                    formatStatisticNoun(entry.totalTokens, 'token'),
                );
                this._chartTooltip.set_pointing_to(new Gdk.Rectangle({
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                    width: 1,
                    height: 1,
                }));
                this._chartHoveredIndex = hoveredIndex;
                this._chart.queue_draw();
            }
            if (!this._chartTooltip.get_visible())
                this._chartTooltip.popup();
        };
        chartMotionController.connect('enter', (_controller, x) => updateChartHover(x));
        chartMotionController.connect('motion', (_controller, x) => updateChartHover(x));
        chartMotionController.connect('leave', scheduleTooltipHide);
        this._chart.add_controller(chartMotionController);
        tooltipMotionController.connect('enter', cancelTooltipHide);
        tooltipMotionController.connect('leave', scheduleTooltipHide);
        this._chartTooltip.add_controller(tooltipMotionController);

        const chartDates = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            spacing: 4,
        });
        this._dateLabels = Array.from({ length: 7 }, (_value, index) => {
            const label = new Gtk.Label({
                xalign: index === 0 ? 0 : index === 6 ? 1 : 0.5,
                hexpand: true,
                visible: false,
            });
            label.add_css_class('caption');
            label.add_css_class('dim-label');
            chartDates.append(label);
            return label;
        });
        chartCard.append(chartHeader);
        chartCard.append(this._chart);
        chartCard.append(chartDates);
        overview.append(totalCard);
        overview.append(chartCard);
        content.append(overview);

        const metrics = new Adw.WrapBox({
            orientation: Gtk.Orientation.HORIZONTAL,
            child_spacing: 12,
            line_spacing: 12,
            justify: Adw.JustifyMode.FILL,
            justify_last_line: Adw.JustifyMode.FILL,
            line_homogeneous: true,
            wrap_policy: Adw.WrapPolicy.MINIMUM,
            hexpand: true,
        });
        this._metricLabels = {};
        for (const [key, title] of [
            ['cached', 'Cached input'],
            ['uncached', 'Uncached input'],
            ['output', 'Output'],
            ['coverage', 'Reporting coverage'],
        ]) {
            const { card, valueLabel, detailLabel } = this._createMetricCard(title);
            metrics.append(card);
            this._metricLabels[key] = { valueLabel, detailLabel };
        }
        content.append(metrics);

        const breakdownHeading = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 8,
        });
        const breakdownTitle = new Gtk.Label({ label: 'Breakdown', xalign: 0, hexpand: true });
        breakdownTitle.add_css_class('title-3');
        const breakdownSubtitle = new Gtk.Label({ label: 'Provider and model', xalign: 1 });
        breakdownSubtitle.add_css_class('dim-label');
        breakdownHeading.append(breakdownTitle);
        breakdownHeading.append(breakdownSubtitle);
        content.append(breakdownHeading);

        this._breakdownList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this._breakdownList.add_css_class('boxed-list');
        this._emptyLabel = new Gtk.Label({
            label: 'No provider-reported token usage in this period.',
            margin_top: 28,
            margin_bottom: 28,
            wrap: true,
            visible: false,
        });
        this._emptyLabel.add_css_class('dim-label');
        content.append(this._breakdownList);
        content.append(this._emptyLabel);
        this._sourceNoteLabel = new Gtk.Label({
            label: 'Usage is calculated from token metadata stored in local chat history. Historical cost is not estimated because provider pricing can change.',
            xalign: 0,
            wrap: true,
        });
        this._sourceNoteLabel.add_css_class('caption');
        this._sourceNoteLabel.add_css_class('dim-label');
        content.append(this._sourceNoteLabel);

        const clamp = new Adw.Clamp({ child: content, maximum_size: 1120, tightening_threshold: 840 });
        toolbarView.set_content(new Gtk.ScrolledWindow({
            child: clamp,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        }));
        return toolbarView;
    }

    _stopChartAnimation() {
        if (!this._chartAnimationTickId)
            return;
        this._chart?.remove_tick_callback(this._chartAnimationTickId);
        this._chartAnimationTickId = 0;
    }

    _startChartAnimation() {
        this._stopChartAnimation();
        if (!this._chart)
            return;
        if (!Adw.get_enable_animations(this._chart)) {
            this._chartAnimationProgress = 1;
            this._chart.queue_draw();
            return;
        }
        this._chartAnimationProgress = 0;
        let startTime = 0;
        this._chartAnimationTickId = this._chart.add_tick_callback((widget, frameClock) => {
            const frameTime = frameClock.get_frame_time();
            if (startTime === 0)
                startTime = frameTime;
            const linearProgress = Math.min(
                1,
                (frameTime - startTime) / DAILY_USAGE_CHART_REVEAL_DURATION_US,
            );
            this._chartAnimationProgress = easeOutCubic(linearProgress);
            widget.queue_draw();
            if (linearProgress < 1)
                return GLib.SOURCE_CONTINUE;
            this._chartAnimationTickId = 0;
            return GLib.SOURCE_REMOVE;
        });
        this._chart.queue_draw();
    }

    refresh() {
        if (!this._totalTokensLabel || !this._conversations)
            return;
        this.cancelRefresh();
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        startDate.setDate(startDate.getDate() - (this._periodDays - 1));
        const cutoff = startDate.getTime();
        const conversations = this._conversations.allConversations.filter((conversation) => {
            const updatedAt = Date.parse(conversation?.updatedAt);
            return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
        });
        let conversationIndex = 0;
        let incompleteConversationCount = 0;
        for (const label of [
            this._totalTokensLabel,
            this._conversationCountLabel,
            this._messageCountLabel,
            this._providerCountLabel,
            this._modelCountLabel,
            this._todayTotalLabel,
        ]) {
            setUsageNumberLabel(label, '…');
        }
        this._totalStatusLabel.set_label('Reading local chat history…');
        this._totalStatusLabel.set_visible(true);
        const finish = () => {
            this._refreshSourceId = 0;
            this.applyUsage(summarizeUsageDashboard(conversations, {
                days: this._periodDays,
                now,
            }), { incompleteConversationCount });
        };
        if (conversations.length === 0) {
            finish();
            return;
        }
        this._refreshSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const deadline = GLib.get_monotonic_time() + 4000;
            do {
                const conversation = conversations[conversationIndex];
                if (this._conversations.conversationLoadError(conversation.id))
                    this._conversations.retryConversationLoad(conversation.id);
                void conversation.messages;
                if (this._conversations.conversationLoadError(conversation.id))
                    incompleteConversationCount += 1;
                conversationIndex += 1;
            } while (conversationIndex < conversations.length
                && GLib.get_monotonic_time() < deadline);
            if (conversationIndex < conversations.length)
                return GLib.SOURCE_CONTINUE;
            finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    applyUsage(usage, { incompleteConversationCount = 0 } = {}) {
        const cachedPercentage = usage.inputTokens > 0
            ? (usage.cachedInputTokens / usage.inputTokens) * 100
            : 0;
        const coveragePercentage = usage.assistantMessages > 0
            ? (usage.reportedMessages / usage.assistantMessages) * 100
            : 0;
        for (const [label, value] of [
            [this._totalTokensLabel, formatStatisticCount(usage.totalTokens)],
            [this._conversationCountLabel, formatStatisticCount(usage.conversationCount)],
            [this._messageCountLabel, formatStatisticCount(usage.totalMessages)],
            [this._providerCountLabel, formatStatisticCount(usage.providerCount)],
            [this._modelCountLabel, formatStatisticCount(usage.modelCount)],
            [this._todayTotalLabel, formatStatisticNoun(usage.daily.at(-1)?.totalTokens ?? 0, 'token')],
        ]) {
            setUsageNumberLabel(label, value);
        }
        this._providerIconPile.setBreakdown(usage.breakdown);
        this._totalStatusLabel.set_label(incompleteConversationCount > 0
            ? `${formatStatisticNoun(incompleteConversationCount, 'chat')} unavailable`
            : '');
        this._totalStatusLabel.set_visible(incompleteConversationCount > 0);
        setUsageNumberLabel(this._metricLabels.cached.valueLabel, formatStatisticCount(usage.cachedInputTokens));
        this._metricLabels.cached.detailLabel.set_label(`${cachedPercentage.toFixed(1)}% of reported input`);
        setUsageNumberLabel(this._metricLabels.uncached.valueLabel, formatStatisticCount(usage.uncachedInputTokens));
        this._metricLabels.uncached.detailLabel.set_label(`${formatStatisticCount(usage.inputTokens)} total input tokens`);
        setUsageNumberLabel(this._metricLabels.output.valueLabel, formatStatisticCount(usage.outputTokens));
        this._metricLabels.output.detailLabel.set_label(usage.estimatedMessages > 0
            ? formatStatisticNoun(usage.estimatedMessages, 'estimate')
            : 'Provider-reported output');
        setUsageNumberLabel(this._metricLabels.coverage.valueLabel, `${coveragePercentage.toFixed(1)}%`);
        this._metricLabels.coverage.detailLabel.set_label(
            `${formatStatisticCount(usage.reportedMessages)} of ${
                formatStatisticCount(usage.assistantMessages)
            } assistant messages`,
        );
        this._chartData = usage.daily;
        this._chartHoveredIndex = -1;
        this._cancelChartTooltipHide?.();
        this._chartTooltip?.popdown();
        this._startChartAnimation();
        const dailyDescription = usage.daily
            .filter((entry) => entry.totalTokens > 0)
            .map((entry) => `${formatUsageDate(entry.date)}: ${
                formatStatisticCount(entry.totalTokens)
            } tokens`)
            .join('; ');
        this._chart.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [dailyDescription
                ? `Daily token usage. ${dailyDescription}`
                : 'Daily token usage. No provider-reported tokens in this period.'],
        );
        const dateLabelIndices = dailyUsageDateLabelIndices(usage.daily.length, this._dateLabels.length);
        for (let index = 0; index < this._dateLabels.length; index += 1) {
            const label = this._dateLabels[index];
            const entry = usage.daily[dateLabelIndices[index]];
            label.set_visible(Boolean(entry));
            label.set_label(entry ? formatUsageDate(entry.date) : '');
            label.set_xalign(index === 0 ? 0 : index === dateLabelIndices.length - 1 ? 1 : 0.5);
        }

        clearContainer(this._breakdownList);
        for (const entry of usage.breakdown) {
            const provider = this._providerConfigs.getProvider(entry.providerId);
            const model = provider?.models.find((candidate) => candidate.id === entry.modelId);
            const row = new Gtk.ListBoxRow({ activatable: false, selectable: false });
            const rowContent = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 12,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 12,
                margin_end: 12,
            });
            const icon = new Gtk.Image({
                gicon: getProviderGIcon(provider ?? entry.providerId),
                valign: Gtk.Align.CENTER,
            });
            icon.set_pixel_size(20);
            const identity = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                hexpand: true,
            });
            const name = new Gtk.Label({
                label: model?.name ?? model?.label ?? entry.modelId,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            });
            const providerLabel = new Gtk.Label({
                label: `${provider?.name ?? entry.providerId} · ${
                    formatStatisticCount(entry.inputTokens)
                } input · ${formatStatisticCount(entry.outputTokens)} output`,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            });
            providerLabel.add_css_class('caption');
            providerLabel.add_css_class('dim-label');
            identity.append(name);
            identity.append(providerLabel);
            const share = usage.totalTokens > 0 ? (entry.totalTokens / usage.totalTokens) * 100 : 0;
            const totals = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                halign: Gtk.Align.END,
            });
            const tokenLabel = new Gtk.Label({ xalign: 1 });
            tokenLabel.add_css_class('cusco-chat-statistics-value');
            tokenLabel.add_css_class('cusco-usage-number');
            setUsageNumberLabel(tokenLabel, formatStatisticCount(entry.totalTokens));
            const shareLabel = new Gtk.Label({ label: `${share.toFixed(1)}%`, xalign: 1 });
            shareLabel.add_css_class('caption');
            shareLabel.add_css_class('dim-label');
            totals.append(tokenLabel);
            totals.append(shareLabel);
            rowContent.append(icon);
            rowContent.append(identity);
            rowContent.append(totals);
            row.set_child(rowContent);
            this._breakdownList.append(row);
        }
        const hasBreakdown = usage.breakdown.length > 0;
        this._breakdownList.set_visible(hasBreakdown);
        this._emptyLabel.set_visible(!hasBreakdown);
        this._sourceNoteLabel.set_label(incompleteConversationCount > 0
            ? 'Usage is calculated from token metadata stored in local chat history. Some chat transcripts could not be read, so these totals are incomplete. Refresh to retry. Historical cost is not estimated because provider pricing can change.'
            : 'Usage is calculated from token metadata stored in local chat history. Historical cost is not estimated because provider pricing can change.');
    }
}
