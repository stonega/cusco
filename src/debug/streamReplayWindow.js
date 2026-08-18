import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { createAgentWorkingRow } from '../chat/agentActivityPresenter.js';
import { createMessageWrapper } from '../chat/messagePresenter.js';
import { createMessageContent } from '../chat/messageView.js';
import {
    DEFAULT_STREAM_ANIMATION_DURATION_MS,
    DEFAULT_STREAM_ANIMATION_STAGGER_MS,
} from '../chat/streamAnimation.js';
import {
    DEFAULT_STREAM_ANIMATION_STYLE,
    DEFAULT_STREAM_IDLE_FLUSH_MS,
    DEFAULT_STREAM_INTERVAL_MS,
    normalizeStreamAnimationStyle,
    streamRevealUnits,
} from '../chat/streamingText.js';

const DEFAULT_PROVIDER_INTERVAL_MS = 48;
const DEFAULT_PROVIDER_UNITS_PER_CHUNK = 8;
const STREAM_ANIMATION_OPTIONS = Object.freeze([
    { id: 'blurIn', label: 'Blur in' },
    { id: 'fadeIn', label: 'Fade in' },
    { id: 'slideUp', label: 'Slide up' },
    { id: 'none', label: 'Off' },
]);

export const DEFAULT_STREAM_REPLAY_MESSAGE = `**阿森纳**（Arsenal Football Club）是英格兰足坛历史最悠久、最具影响力的俱乐部之一，绰号“枪手”（The Gunners），位于北伦敦。

---

### 1. 基本概况
- **成立时间**：1886年（最初名为“Dial Square”，后改名伍尔维奇阿森纳，1914年迁至北伦敦海布里）。
- **主场**：酋长球场（Emirates Stadium），可容纳约6万人，2006年启用。
- **队徽**：以加农炮为核心元素，体现“兵工厂/军工厂”的历史渊源。
- **传统颜色**：主场红衣白袖，客场球衣每年变化。

---

### 2. 历史荣誉
| 荣誉 | 次数 |
|---|---|
| 英格兰顶级联赛冠军 | 13次 |
| 足总杯冠军 | 14次（历史最多） |
| 联赛杯冠军 | 2次 |
| 社区盾冠军 | 17次 |
| 欧洲优胜者杯 | 1次（1994）|

- 顶级联赛冠军包括3次英超冠军（1997–98、2001–02、2003–04）。

---

### 3. “不败赛季”传奇
- **2003–04赛季**，阿森纳以**26胜12平0负**的战绩夺得英超冠军，整个赛季**38场不败**。
- 那支球队的标志性球员包括亨利、博格坎普、维埃拉、皮雷、索尔·坎贝尔、莱曼等。
- 这一成就被认为是英超历史上最伟大的赛季之一。

---

### 4. 温格时代（1996–2018）
- **阿尔塞纳·温格**是阿森纳历史上最伟大的主教练。
- 他将法国足球的技术流和英超的对抗性结合，打造了华丽攻势足球。
- 温格带队夺得3次英超冠军、7次足总杯冠军，并长期保持欧冠资格。
- 后期因新建酋长球场带来的财务压力，球队多年无重要冠军，被戏称为“争四狂魔”。

---

### 5. 近年复兴
- 温格离任后，阿森纳经历埃梅里、临时主帅永贝里等过渡期。
- **2019年**，前曼城助教**米克尔·阿尔特塔**出任主教练，开启重建。
- 阿尔特塔带队夺得：
  - 2019–20赛季足总杯冠军
  - 2020年社区盾冠军
  - 2022–23、2023–24赛季连续两年获得英超亚军
- 球队重新成为曼城在英超的主要挑战者。

---

### 6. 战术风格
- 阿尔特塔治下，阿森纳强调**高位逼抢、控球组织、边路进攻**。
- 常用阵型为4-3-3或3-2-5进攻结构。
- 定位球和角球战术颇具威胁。

---

### 7. 当前核心球员（2024–25赛季）
- **布卡约·萨卡**（Bukayo Saka）：英格兰国脚，右路核心，青训瑰宝。
- **马丁·厄德高**（Martin Ødegaard）：挪威中场，球队队长，进攻组织者。
- **德克兰·赖斯**（Declan Rice）：英格兰后腰，2023年以高价加盟，中场屏障。
- **威廉·萨利巴**（William Saliba）：法国中卫，防线基石。
- **凯·哈弗茨**（Kai Havertz）：德国攻击手，常被用作中锋。
- **加布里埃尔·热苏斯**（Gabriel Jesus）：巴西前锋。

---

### 8. 北伦敦德比
- 阿森纳与**托特纳姆热刺**的对抗是英超最著名的德比战之一。
- 两队同处北伦敦，恩怨已久，比赛火药味十足。
- 阿森纳在历史总战绩和冠军数量上均占优。

---

### 9. 球迷与文化
- 阿森纳以“美丽足球”和国际化球迷基础著称。
- 主场氛围热烈，全球拥有大量支持者，尤其在中国、东南亚、非洲等地。
- 经典口号：“*Victoria Concordia Crescit*”（胜利源于和谐）。

---

如果你想了解阿森纳某个具体赛季、某位传奇球星（如亨利、博格坎普）、转会动态，或者与曼联、曼城、切尔西的对比，可以继续问我！`;

function textFromBuffer(buffer) {
    const [start, end] = buffer.get_bounds();

    return buffer.get_text(start, end, true);
}

function createSpinRow(title, subtitle, value, lower, upper, step = 1) {
    return new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: Math.max(step, step * 10),
            value,
        }),
        digits: 0,
    });
}

function createAnimationStyleModel() {
    const model = new Gtk.StringList();

    for (const option of STREAM_ANIMATION_OPTIONS)
        model.append(option.label);

    return model;
}

function removeChild(parent, child) {
    if (child?.get_parent?.() === parent)
        parent.remove(child);
}

export function createStreamReplayWindow(parent = null, options = {}) {
    const appSettings = options.appSettings ?? null;
    const window = new Adw.Window({
        title: 'Stream Replay',
        default_width: 1080,
        default_height: 760,
        transient_for: parent,
        destroy_with_parent: Boolean(parent),
    });
    const toolbarView = new Adw.ToolbarView();
    const headerBar = new Adw.HeaderBar();
    const windowTitle = new Adw.WindowTitle({
        title: 'Stream Replay',
        subtitle: 'Assistant message presentation debugger',
    });
    const replayButton = new Gtk.Button({
        label: 'Replay',
        tooltip_text: 'Replay the message with the current configuration',
    });
    const stopButton = new Gtk.Button({
        label: 'Stop',
        sensitive: false,
        tooltip_text: 'Stop provider delivery and reveal its current snapshot',
    });

    replayButton.add_css_class('suggested-action');
    headerBar.set_title_widget(windowTitle);
    headerBar.pack_end(replayButton);
    headerBar.pack_end(stopButton);

    const messageBuffer = new Gtk.TextBuffer();
    messageBuffer.set_text(options.initialMessage ?? DEFAULT_STREAM_REPLAY_MESSAGE, -1);
    const messageEditor = new Gtk.TextView({
        buffer: messageBuffer,
        accepts_tab: true,
        hexpand: true,
        vexpand: true,
        top_margin: 10,
        bottom_margin: 10,
        left_margin: 10,
        right_margin: 10,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
    });
    messageEditor.add_css_class('cusco-stream-replay-editor');
    const messageScroller = new Gtk.ScrolledWindow({
        child: messageEditor,
        min_content_height: 220,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    messageScroller.add_css_class('frame');

    const loadSampleButton = new Gtk.Button({
        label: 'Load reported sample',
        halign: Gtk.Align.START,
    });
    loadSampleButton.add_css_class('flat');
    loadSampleButton.connect('clicked', () => {
        messageBuffer.set_text(DEFAULT_STREAM_REPLAY_MESSAGE, -1);
    });

    const messageGroup = new Adw.PreferencesGroup({
        title: 'Message',
        description: 'Enter Markdown exactly as it arrived from a provider.',
    });
    messageGroup.add(messageScroller);
    messageGroup.add(loadSampleButton);

    const initialStyle = normalizeStreamAnimationStyle(
        options.streamAnimationStyle
            ?? appSettings?.streamAnimationStyle
            ?? DEFAULT_STREAM_ANIMATION_STYLE,
    );
    const styleRow = new Adw.ComboRow({
        title: 'Animation',
        subtitle: 'The same effect used by assistant message cards.',
        model: createAnimationStyleModel(),
        selected: Math.max(
            0,
            STREAM_ANIMATION_OPTIONS.findIndex((option) => option.id === initialStyle),
        ),
    });
    const motionRow = new Adw.SwitchRow({
        title: 'Motion',
        subtitle: 'Disable to test reduced-motion and static delivery.',
        active: options.motionEnabled ?? !appSettings?.reducedMotionEnabled,
    });
    const finalRevisionRow = new Adw.SwitchRow({
        title: 'Final provider revision',
        subtitle: 'Append a draft-only tail, then replace it with the final message.',
        active: options.simulateFinalRevision ?? true,
    });
    const autoScrollRow = new Adw.SwitchRow({
        title: 'Follow latest frame',
        subtitle: 'Keep the newest part of the message visible while replaying.',
        active: options.autoScroll ?? true,
    });
    const presentationGroup = new Adw.PreferencesGroup({ title: 'Presentation' });
    presentationGroup.add(styleRow);
    presentationGroup.add(motionRow);
    presentationGroup.add(finalRevisionRow);
    presentationGroup.add(autoScrollRow);

    const providerIntervalRow = createSpinRow(
        'Provider interval',
        'Milliseconds between incoming provider snapshots.',
        options.providerIntervalMs ?? DEFAULT_PROVIDER_INTERVAL_MS,
        1,
        2000,
        1,
    );
    const providerUnitsRow = createSpinRow(
        'Units per snapshot',
        'Language-aware reveal units delivered in each provider update.',
        options.providerUnitsPerChunk ?? DEFAULT_PROVIDER_UNITS_PER_CHUNK,
        1,
        4096,
        1,
    );
    const revealIntervalRow = createSpinRow(
        'Reveal interval',
        'Milliseconds between visible text units.',
        options.revealIntervalMs ?? DEFAULT_STREAM_INTERVAL_MS,
        1,
        1000,
        1,
    );
    const idleFlushRow = createSpinRow(
        'Idle flush delay',
        'Milliseconds before an incomplete trailing unit may be revealed; '
            + 'at least the reveal interval.',
        options.idleFlushMs ?? DEFAULT_STREAM_IDLE_FLUSH_MS,
        1,
        4000,
        1,
    );
    const deliveryGroup = new Adw.PreferencesGroup({
        title: 'Delivery',
        description: 'Changes apply to the next replay.',
    });
    deliveryGroup.add(providerIntervalRow);
    deliveryGroup.add(providerUnitsRow);
    deliveryGroup.add(revealIntervalRow);
    deliveryGroup.add(idleFlushRow);

    const animationDurationRow = createSpinRow(
        'Effect duration',
        'Milliseconds for each rendered text effect.',
        options.animationDurationMs ?? DEFAULT_STREAM_ANIMATION_DURATION_MS,
        1,
        2000,
        1,
    );
    const animationStaggerRow = createSpinRow(
        'Effect stagger',
        'Milliseconds between effects when a frame adds multiple units.',
        options.animationStaggerMs ?? DEFAULT_STREAM_ANIMATION_STAGGER_MS,
        0,
        500,
        1,
    );
    const effectGroup = new Adw.PreferencesGroup({ title: 'Text effect' });
    effectGroup.add(animationDurationRow);
    effectGroup.add(animationStaggerRow);

    const controlsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 22,
        margin_top: 18,
        margin_bottom: 24,
        margin_start: 18,
        margin_end: 18,
        width_request: 380,
    });
    controlsBox.append(messageGroup);
    controlsBox.append(presentationGroup);
    controlsBox.append(deliveryGroup);
    controlsBox.append(effectGroup);
    const controlsScroller = new Gtk.ScrolledWindow({
        child: controlsBox,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    controlsScroller.add_css_class('cusco-stream-replay-controls');

    const phaseLabel = new Gtk.Label({
        label: 'Ready',
        xalign: 0,
        hexpand: true,
    });
    phaseLabel.add_css_class('heading');
    const metricsLabel = new Gtk.Label({
        label: 'No replay started',
        xalign: 1,
        selectable: true,
    });
    metricsLabel.add_css_class('dim-label');
    metricsLabel.add_css_class('cusco-stream-replay-metrics');
    const statusBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_top: 14,
        margin_bottom: 10,
        margin_start: 24,
        margin_end: 24,
    });
    statusBar.append(phaseLabel);
    statusBar.append(metricsLabel);

    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        margin_top: 10,
        margin_bottom: 28,
        margin_start: 24,
        margin_end: 24,
        hexpand: true,
    });
    const previewScroller = new Gtk.ScrolledWindow({
        child: previewBox,
        hexpand: true,
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    const emptyState = new Adw.StatusPage({
        icon_name: 'utilities-terminal-symbolic',
        title: 'Ready to replay',
        description: 'Edit the message and delivery settings, then choose Replay.',
    });
    const previewStack = new Gtk.Stack({
        hexpand: true,
        vexpand: true,
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: 160,
    });
    previewStack.add_named(emptyState, 'empty');
    previewStack.add_named(previewScroller, 'preview');
    previewStack.set_visible_child_name('empty');
    const stage = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    stage.add_css_class('cusco-stream-replay-stage');
    stage.append(statusBar);
    stage.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
    stage.append(previewStack);

    const split = new Gtk.Paned({
        orientation: Gtk.Orientation.HORIZONTAL,
        position: 390,
        wide_handle: false,
        shrink_start_child: false,
        shrink_end_child: false,
        resize_start_child: false,
        resize_end_child: true,
    });
    split.set_start_child(controlsScroller);
    split.set_end_child(stage);
    toolbarView.add_top_bar(headerBar);
    toolbarView.set_content(split);
    window.set_content(toolbarView);

    let activeRun = null;
    let runSequence = 0;
    let scrollSourceId = 0;
    let replayState = {
        phase: 'idle',
        providerUnits: 0,
        providerUnitsTotal: 0,
        visibleCharacters: 0,
        targetCharacters: 0,
    };

    const setPhase = (phase, label) => {
        replayState = { ...replayState, phase };
        phaseLabel.set_label(label);
    };
    const updateMetrics = () => {
        metricsLabel.set_label([
            `${replayState.providerUnits}/${replayState.providerUnitsTotal} provider units`,
            `${replayState.visibleCharacters}/${replayState.targetCharacters} visible chars`,
        ].join('  ·  '));
    };
    const followLatestFrame = () => {
        if (!autoScrollRow.get_active() || scrollSourceId)
            return;

        scrollSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            scrollSourceId = 0;
            const adjustment = previewScroller.get_vadjustment();
            adjustment.set_value(Math.max(
                adjustment.get_lower(),
                adjustment.get_upper() - adjustment.get_page_size(),
            ));
            return GLib.SOURCE_REMOVE;
        });
    };
    const removeWorkingRow = (run) => {
        if (!run?.workingRow)
            return;

        run.workingRow.stop?.();
        removeChild(run.bubble, run.workingRow);
        run.workingRow = null;
    };
    const settleRun = (run, result) => {
        if (run.settled)
            return;

        run.settled = true;
        run.resolve(result);

        if (activeRun === run)
            activeRun = null;
    };
    const clearPreview = () => {
        for (let child = previewBox.get_first_child(); child;) {
            const next = child.get_next_sibling();
            previewBox.remove(child);
            child = next;
        }
    };
    const discardActiveRun = () => {
        const run = activeRun;

        if (!run)
            return;

        if (run.providerSourceId) {
            GLib.Source.remove(run.providerSourceId);
            run.providerSourceId = 0;
        }

        removeWorkingRow(run);
        clearPreview();
        settleRun(run, { status: 'replaced' });
    };
    const selectedConfig = () => ({
        animationStyle: STREAM_ANIMATION_OPTIONS[styleRow.get_selected()]?.id
            ?? DEFAULT_STREAM_ANIMATION_STYLE,
        motionEnabled: motionRow.get_active(),
        simulateFinalRevision: finalRevisionRow.get_active(),
        providerIntervalMs: Math.max(1, Math.round(providerIntervalRow.get_value())),
        providerUnitsPerChunk: Math.max(1, Math.round(providerUnitsRow.get_value())),
        revealIntervalMs: Math.max(1, Math.round(revealIntervalRow.get_value())),
        idleFlushMs: Math.max(1, Math.round(idleFlushRow.get_value())),
        animationDurationMs: Math.max(1, Math.round(animationDurationRow.get_value())),
        animationStaggerMs: Math.max(0, Math.round(animationStaggerRow.get_value())),
    });

    const replayStream = () => {
        discardActiveRun();
        const message = textFromBuffer(messageBuffer);

        if (!message.trim()) {
            setPhase('empty', 'Enter a message first');
            metricsLabel.set_label('The replay message is empty');
            messageEditor.grab_focus();
            return Promise.resolve({ status: 'empty' });
        }

        const config = selectedConfig();
        const providerTarget = config.simulateFinalRevision
            ? `${message}\n\n[provider draft tail]`
            : message;
        const providerUnits = streamRevealUnits(providerTarget);
        const runId = ++runSequence;
        let resolveRun;
        const completion = new Promise((resolve) => {
            resolveRun = resolve;
        });
        const wrapper = createMessageWrapper('assistant');
        const bubble = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
        });
        let run = null;
        const bodyContent = createMessageContent('', {
            role: 'assistant',
            hexpand: true,
            codeMinWidth: 380,
            codeTheme: appSettings?.codeTheme,
            parentWindow: window,
            selectable: false,
            streaming: true,
            streamAnimationStyle: config.animationStyle,
            motionEnabled: () => config.motionEnabled,
            streamRevealIntervalMs: config.revealIntervalMs,
            streamIdleFlushMs: config.idleFlushMs,
            streamAnimationDurationMs: config.animationDurationMs,
            streamAnimationStaggerMs: config.animationStaggerMs,
            onStreamFrame: (visibleText) => {
                if (!run || run.id !== runId)
                    return;

                replayState = {
                    ...replayState,
                    visibleCharacters: visibleText.length,
                };
                updateMetrics();
                followLatestFrame();
            },
        });
        const workingRow = createAgentWorkingRow({
            startedAt: GLib.get_monotonic_time(),
            reducedMotionEnabled: () => !config.motionEnabled,
        });

        bodyContent.set_visible(false);
        bubble.add_css_class('cusco-message-bubble');
        bubble.add_css_class('cusco-message-assistant');
        bubble.append(bodyContent);
        bubble.append(workingRow);
        wrapper.append(bubble);
        clearPreview();
        previewBox.append(wrapper);
        previewStack.set_visible_child_name('preview');

        run = {
            id: runId,
            bodyContent,
            bubble,
            completion,
            providerSourceId: 0,
            providerText: '',
            providerUnitIndex: 0,
            resolve: resolveRun,
            settled: false,
            workingRow,
        };
        activeRun = run;
        replayState = {
            phase: 'streaming',
            providerUnits: 0,
            providerUnitsTotal: providerUnits.length,
            visibleCharacters: 0,
            targetCharacters: message.length,
        };
        setPhase('streaming', 'Streaming provider');
        updateMetrics();
        replayButton.set_sensitive(false);
        stopButton.set_sensitive(true);

        const finishProvider = () => {
            run.providerSourceId = 0;

            if (activeRun !== run)
                return GLib.SOURCE_REMOVE;

            if (config.simulateFinalRevision)
                bodyContent.updateContent(message);

            removeWorkingRow(run);
            setPhase('draining', 'Draining presentation');
            Promise.resolve(bodyContent.finishStreaming({ selectable: true })).then(() => {
                if (activeRun !== run)
                    return;

                replayState = {
                    ...replayState,
                    phase: 'complete',
                    visibleCharacters: message.length,
                    targetCharacters: message.length,
                };
                phaseLabel.set_label('Complete');
                updateMetrics();
                replayButton.set_sensitive(true);
                stopButton.set_sensitive(false);
                settleRun(run, { status: 'complete', message });
            }).catch((error) => {
                if (activeRun === run) {
                    setPhase('error', 'Replay failed');
                    metricsLabel.set_label(String(error?.message ?? error));
                    replayButton.set_sensitive(true);
                    stopButton.set_sensitive(false);
                    settleRun(run, { status: 'error', error });
                }
            });
            return GLib.SOURCE_REMOVE;
        };
        const deliverChunk = () => {
            if (activeRun !== run)
                return GLib.SOURCE_REMOVE;

            const nextIndex = Math.min(
                providerUnits.length,
                run.providerUnitIndex + config.providerUnitsPerChunk,
            );
            run.providerText += providerUnits.slice(run.providerUnitIndex, nextIndex).join('');
            run.providerUnitIndex = nextIndex;
            bodyContent.set_visible(true);
            bodyContent.updateContent(run.providerText);
            replayState = {
                ...replayState,
                providerUnits: run.providerUnitIndex,
            };
            updateMetrics();

            if (run.providerUnitIndex >= providerUnits.length)
                return finishProvider();

            return GLib.SOURCE_CONTINUE;
        };

        if (deliverChunk() === GLib.SOURCE_CONTINUE) {
            run.providerSourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                config.providerIntervalMs,
                deliverChunk,
            );
        }

        return completion;
    };

    const stopReplay = () => {
        const run = activeRun;

        if (!run)
            return Promise.resolve({ status: 'idle' });

        if (run.providerSourceId) {
            GLib.Source.remove(run.providerSourceId);
            run.providerSourceId = 0;
        }

        removeWorkingRow(run);
        setPhase('stopping', 'Stopping replay');
        return Promise.resolve(run.bodyContent.finishStreaming({
            flush: true,
            selectable: true,
        })).then(() => {
            if (activeRun === run) {
                setPhase('stopped', 'Stopped');
                replayButton.set_sensitive(true);
                stopButton.set_sensitive(false);
                settleRun(run, { status: 'stopped' });
            }

            return { status: 'stopped' };
        });
    };

    replayButton.connect('clicked', () => {
        void replayStream();
    });
    stopButton.connect('clicked', () => {
        void stopReplay();
    });
    const cleanupWindow = () => {
        discardActiveRun();

        if (scrollSourceId) {
            GLib.Source.remove(scrollSourceId);
            scrollSourceId = 0;
        }
    };
    window.connect('close-request', () => {
        cleanupWindow();

        return false;
    });
    window.connect('notify::visible', () => {
        if (!window.get_visible())
            cleanupWindow();
    });

    window.setReplayMessage = (message) => {
        messageBuffer.set_text(String(message ?? ''), -1);
    };
    window.setReplayConfig = (config = {}) => {
        if (Object.hasOwn(config, 'animationStyle')) {
            const style = normalizeStreamAnimationStyle(config.animationStyle);
            const selected = STREAM_ANIMATION_OPTIONS.findIndex((option) => option.id === style);
            styleRow.set_selected(Math.max(0, selected));
        }

        if (Object.hasOwn(config, 'motionEnabled'))
            motionRow.set_active(Boolean(config.motionEnabled));

        if (Object.hasOwn(config, 'simulateFinalRevision'))
            finalRevisionRow.set_active(Boolean(config.simulateFinalRevision));

        if (Object.hasOwn(config, 'autoScroll'))
            autoScrollRow.set_active(Boolean(config.autoScroll));

        const numericRows = [
            ['providerIntervalMs', providerIntervalRow],
            ['providerUnitsPerChunk', providerUnitsRow],
            ['revealIntervalMs', revealIntervalRow],
            ['idleFlushMs', idleFlushRow],
            ['animationDurationMs', animationDurationRow],
            ['animationStaggerMs', animationStaggerRow],
        ];

        for (const [name, row] of numericRows) {
            const value = Number(config[name]);

            if (Object.hasOwn(config, name) && Number.isFinite(value))
                row.set_value(value);
        }
    };
    window.replayStream = replayStream;
    window.stopReplay = stopReplay;
    window.getReplayState = () => ({ ...replayState });

    return window;
}

export function presentStreamReplayWindow(parent = null, options = {}) {
    const window = createStreamReplayWindow(parent, options);

    window.present();
    return window;
}
