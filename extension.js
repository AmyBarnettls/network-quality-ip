import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    getSampleVisual,
    normalizeIpData,
    ProbeProvider,
    Risk,
    SampleStatus,
    SampleWindow,
    validateProbeResponse,
    WINDOW_SIZE,
} from './core.js';

const IP_API_URL = 'https://api.ipapi.is';
const IP_CHECK_INTERVAL_SECONDS = 15 * 60;
const PROBE_INTERVAL_SECONDS = 3;
const PROBE_TIMEOUT_SECONDS = 3;
const PROBE_FAILURES_BEFORE_SWITCH = 3;
const SYSTEM_UPDATE_INTERVAL_SECONDS = 1;
const TOP_PROCESS_COUNT = 5;

const TEXT_DECODER = new TextDecoder('utf-8');

const PROBE_TARGETS = Object.freeze([
    Object.freeze({
        provider: ProbeProvider.GOOGLE,
        name: 'Google',
        url: 'https://connectivitycheck.gstatic.com/generate_204',
    }),
    Object.freeze({
        provider: ProbeProvider.CLOUDFLARE,
        name: 'Cloudflare',
        url: 'https://cloudflare.com/cdn-cgi/trace',
    }),
    Object.freeze({
        provider: ProbeProvider.APPLE,
        name: 'Apple',
        url: 'https://www.apple.com/library/test/success.html',
    }),
]);

const GRAPH_COLORS = Object.freeze({
    good: [0.18, 0.80, 0.44, 1],
    warning: [0.96, 0.69, 0.18, 1],
    bad: [0.91, 0.30, 0.24, 1],
    failure: [0.55, 0.57, 0.61, 0.9],
});

function formatDuration(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—';
}

function formatFailureRate(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

function formatUsage(value, fractionDigits = 0) {
    return Number.isFinite(value)
        ? `${value.toFixed(fractionDigits)}%`
        : '—';
}

function readTextFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? TEXT_DECODER.decode(contents) : null;
    } catch (_error) {
        return null;
    }
}

function readCpuTimes() {
    const line = readTextFile('/proc/stat')?.split('\n', 1)[0];
    const fields = line?.trim().split(/\s+/);
    if (!fields || fields[0] !== 'cpu')
        return null;

    const times = fields.slice(1, 9).map(Number);
    if (times.length < 4 || times.some(value => !Number.isFinite(value)))
        return null;

    return {
        total: times.reduce((sum, value) => sum + value, 0),
        idle: times[3] + (times[4] || 0),
    };
}

function readMemoryUsage() {
    const contents = readTextFile('/proc/meminfo');
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(contents)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(contents)?.[1]);
    if (!Number.isFinite(total) || total <= 0 ||
        !Number.isFinite(available))
        return null;

    return Math.max(0, Math.min(100, (total - available) / total * 100));
}

function parseProcessStat(contents, pid) {
    if (!contents)
        return null;

    const nameStart = contents.indexOf('(');
    const nameEnd = contents.lastIndexOf(')');
    if (nameStart < 0 || nameEnd <= nameStart)
        return null;

    const fields = contents.slice(nameEnd + 1).trim().split(/\s+/);
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    const startTime = fields[19];
    if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks) ||
        !startTime)
        return null;

    const name = contents.slice(nameStart + 1, nameEnd)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim();
    return {
        pid,
        name: name || `PID ${pid}`,
        ticks: userTicks + systemTicks,
        startTime,
    };
}

function readProcesses() {
    const processes = new Map();
    let enumerator = null;

    try {
        enumerator = Gio.File.new_for_path('/proc').enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = enumerator.next_file(null); info;
            info = enumerator.next_file(null)) {
            const pid = info.get_name();
            if (!/^\d+$/.test(pid))
                continue;

            const process = parseProcessStat(
                readTextFile(`/proc/${pid}/stat`), pid);
            if (process)
                processes.set(pid, process);
        }
    } catch (_error) {
        return null;
    } finally {
        if (enumerator) {
            try {
                enumerator.close(null);
            } catch (_error) {
                // The next scan will create a new enumerator.
            }
        }
    }

    return processes;
}

class SystemMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._active = false;
        this._systemTimerSource = 0;
        this._processTimerSource = 0;
        this._previousCpu = null;
        this._previousProcessCpu = null;
        this._previousProcesses = null;
        this._state = {
            cpuPercent: null,
            memoryPercent: null,
            topProcesses: [],
            collectingProcesses: false,
        };
    }

    start() {
        if (this._active)
            return;

        this._active = true;
        this._previousCpu = readCpuTimes();
        this._state.memoryPercent = readMemoryUsage();
        this._emitUpdate();
        this._systemTimerSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            SYSTEM_UPDATE_INTERVAL_SECONDS,
            () => {
                this._sampleSystem();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stop() {
        this._active = false;
        if (this._systemTimerSource) {
            GLib.source_remove(this._systemTimerSource);
            this._systemTimerSource = 0;
        }
        this._stopProcessSampling(false);
        this._previousCpu = null;
    }

    setProcessSamplingEnabled(enabled) {
        if (!this._active)
            return;
        if (!enabled) {
            this._stopProcessSampling(true);
            return;
        }
        if (this._processTimerSource)
            return;

        this._previousProcessCpu = readCpuTimes();
        this._previousProcesses = readProcesses();
        this._state.topProcesses = [];
        this._state.collectingProcesses = Boolean(
            this._previousProcessCpu && this._previousProcesses);
        this._emitUpdate();
        this._processTimerSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            SYSTEM_UPDATE_INTERVAL_SECONDS,
            () => {
                this._sampleProcesses();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _sampleSystem() {
        if (!this._active)
            return;

        const currentCpu = readCpuTimes();
        let cpuPercent = null;
        if (currentCpu && this._previousCpu) {
            const totalDelta = currentCpu.total - this._previousCpu.total;
            const idleDelta = currentCpu.idle - this._previousCpu.idle;
            if (totalDelta > 0) {
                cpuPercent = Math.max(0, Math.min(
                    100, (totalDelta - idleDelta) / totalDelta * 100));
            }
        }

        this._previousCpu = currentCpu;
        this._state.cpuPercent = cpuPercent;
        this._state.memoryPercent = readMemoryUsage();
        this._emitUpdate();
    }

    _sampleProcesses() {
        if (!this._active)
            return;

        const currentCpu = readCpuTimes();
        const currentProcesses = readProcesses();
        if (!currentCpu || !currentProcesses) {
            this._previousProcessCpu = null;
            this._previousProcesses = null;
            this._state.topProcesses = [];
            this._state.collectingProcesses = false;
            this._emitUpdate();
            return;
        }

        if (!this._previousProcessCpu || !this._previousProcesses) {
            this._previousProcessCpu = currentCpu;
            this._previousProcesses = currentProcesses;
            this._state.topProcesses = [];
            this._state.collectingProcesses = true;
            this._emitUpdate();
            return;
        }

        const totalDelta = currentCpu.total - this._previousProcessCpu.total;
        const processorCount = Math.max(1, GLib.get_num_processors());
        const maximumPercent = processorCount * 100;
        const processes = [];
        if (totalDelta > 0) {
            for (const process of currentProcesses.values()) {
                const previous = this._previousProcesses.get(process.pid);
                const ticks = previous?.startTime === process.startTime
                    ? Math.max(0, process.ticks - previous.ticks)
                    : 0;
                const cpuPercent = Math.min(
                    maximumPercent, ticks / totalDelta * maximumPercent);
                processes.push({...process, ticks, cpuPercent});
            }
        }

        processes.sort((first, second) =>
            second.ticks - first.ticks || first.name.localeCompare(second.name));
        this._state.topProcesses = processes.slice(0, TOP_PROCESS_COUNT).map(
            process => ({
                name: process.name,
                cpuPercent: process.cpuPercent,
            })
        );
        this._state.collectingProcesses = false;
        this._previousProcessCpu = currentCpu;
        this._previousProcesses = currentProcesses;
        this._emitUpdate();
    }

    _stopProcessSampling(emitUpdate) {
        if (this._processTimerSource) {
            GLib.source_remove(this._processTimerSource);
            this._processTimerSource = 0;
        }
        this._previousProcessCpu = null;
        this._previousProcesses = null;
        this._state.topProcesses = [];
        this._state.collectingProcesses = false;
        if (emitUpdate)
            this._emitUpdate();
    }

    _emitUpdate() {
        this._onUpdate({
            ...this._state,
            topProcesses: this._state.topProcesses.map(
                process => ({...process})),
        });
    }
}

class HttpsMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._window = new SampleWindow();
        this._active = false;
        this._nextSequence = 1;
        this._targetIndex = 0;
        this._consecutiveFailures = 0;
        this._timerSource = 0;
        this._inFlight = null;
    }

    start() {
        if (this._active)
            return;
        this._active = true;
        this._consecutiveFailures = 0;
        this._emitUpdate();
        this._probe();
        this._timerSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            PROBE_INTERVAL_SECONDS,
            () => {
                if (this._inFlight)
                    this._finishFailure(this._inFlight, 'request timed out');
                this._probe();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stop() {
        this._active = false;
        if (this._timerSource) {
            GLib.source_remove(this._timerSource);
            this._timerSource = 0;
        }
        if (this._inFlight) {
            const probe = this._inFlight;
            this._inFlight = null;
            probe.cancellable.cancel();
            probe.session.abort();
        }
    }

    _probe() {
        if (!this._active || this._inFlight)
            return;

        const target = PROBE_TARGETS[this._targetIndex];
        const session = new Soup.Session({
            timeout: PROBE_TIMEOUT_SECONDS,
            user_agent: 'Network Quality & IP',
        });
        const cancellable = new Gio.Cancellable();
        const message = Soup.Message.new('GET', target.url);
        message.add_flags(
            Soup.MessageFlags.NO_REDIRECT | Soup.MessageFlags.NEW_CONNECTION);
        message.get_request_headers().append(
            'Cache-Control', 'no-cache, no-store');
        message.get_request_headers().append('Accept', 'text/plain');

        const probe = {
            sequence: this._nextSequence,
            target,
            session,
            cancellable,
            startedUs: GLib.get_monotonic_time(),
        };
        this._inFlight = probe;

        try {
            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (currentSession, result) => {
                    if (!this._active || this._inFlight !== probe)
                        return;
                    try {
                        const bytes = currentSession.send_and_read_finish(result);
                        const body = new TextDecoder('utf-8').decode(
                            bytes.get_data());
                        const status = message.get_status();
                        if (!validateProbeResponse(
                            target.provider, status, body)) {
                            this._finishFailure(
                                probe, `unexpected HTTP ${status}`);
                            return;
                        }
                        const durationMs =
                            (GLib.get_monotonic_time() - probe.startedUs) / 1000;
                        this._finishSuccess(probe, durationMs);
                    } catch (error) {
                        this._finishFailure(probe, error.message);
                    }
                }
            );
        } catch (error) {
            this._finishFailure(probe, error.message);
        }
    }

    _finishSuccess(probe, durationMs) {
        if (!this._active || this._inFlight !== probe)
            return;
        this._completeProbe(probe);
        this._consecutiveFailures = 0;
        this._window.record({
            sequence: probe.sequence,
            status: SampleStatus.SUCCESS,
            durationMs,
            targetName: probe.target.name,
        });
        this._nextSequence++;
        this._emitUpdate();
    }

    _finishFailure(probe, reason) {
        if (!this._active || this._inFlight !== probe)
            return;
        this._completeProbe(probe);
        this._window.record({
            sequence: probe.sequence,
            status: SampleStatus.FAILURE,
            durationMs: null,
            targetName: probe.target.name,
        });
        this._nextSequence++;
        this._consecutiveFailures++;
        if (this._consecutiveFailures >= PROBE_FAILURES_BEFORE_SWITCH) {
            const previousTarget = probe.target.name;
            this._targetIndex = (this._targetIndex + 1) % PROBE_TARGETS.length;
            this._consecutiveFailures = 0;
            console.warn(
                `Network Quality & IP: ${previousTarget} probe failed ` +
                `(${reason}); switching to ` +
                `${PROBE_TARGETS[this._targetIndex].name}`);
        }
        this._emitUpdate();
    }

    _completeProbe(probe) {
        this._inFlight = null;
        probe.cancellable.cancel();
        probe.session.abort();
    }

    _emitUpdate() {
        this._onUpdate({
            samples: this._window.getSamples(),
            stats: this._window.getStats(),
            targetName: PROBE_TARGETS[this._targetIndex].name,
        });
    }
}

class IpMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._active = false;
        this._checking = false;
        this._timerSource = 0;
        this._session = null;
        this._cancellable = null;
        this._data = null;
        this._stale = false;
    }

    start() {
        if (this._active)
            return;
        this._active = true;
        this._session = new Soup.Session({
            timeout: 5,
            user_agent: 'Network Quality & IP',
        });
        this._check();
        this._timerSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            IP_CHECK_INTERVAL_SECONDS,
            () => {
                this._check();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stop() {
        this._active = false;
        if (this._timerSource) {
            GLib.source_remove(this._timerSource);
            this._timerSource = 0;
        }
        if (this._cancellable)
            this._cancellable.cancel();
        if (this._session)
            this._session.abort();
        this._checking = false;
        this._cancellable = null;
        this._session = null;
    }

    async _check() {
        if (!this._active || this._checking)
            return;

        this._checking = true;
        this._emitUpdate();
        this._cancellable = new Gio.Cancellable();

        try {
            const payload = await this._requestJson();
            if (!this._active)
                return;
            const data = normalizeIpData(payload);
            if (!data || !Gio.InetAddress.new_from_string(data.ip))
                throw new Error('ipapi.is returned invalid data');
            this._data = data;
            this._stale = false;
        } catch (error) {
            if (!this._active)
                return;
            this._stale = this._data !== null;
            console.warn(`Network Quality & IP: ${error.message}`);
        } finally {
            if (this._active) {
                this._checking = false;
                this._cancellable = null;
                this._emitUpdate();
            }
        }
    }

    _requestJson() {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', IP_API_URL);
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status < 200 || status >= 300)
                            throw new Error(`ipapi.is returned HTTP ${status}`);
                        const text = new TextDecoder('utf-8').decode(
                            bytes.get_data());
                        resolve(JSON.parse(text));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    _emitUpdate() {
        this._onUpdate({
            checking: this._checking,
            data: this._data,
            stale: this._stale,
        });
    }
}

const NetworkIndicator = GObject.registerClass(
class NetworkIndicator extends PanelMenu.Button {
    _init() {
        super._init(0, 'Network Quality & IP');
        this.menu.box.add_style_class_name('network-quality-menu');

        this._online = true;
        this._probe = {samples: [], stats: {}, targetName: 'Google'};
        this._ip = {checking: false, data: null, stale: false};
        this._system = {
            cpuPercent: null,
            memoryPercent: null,
            topProcesses: [],
            collectingProcesses: false,
        };

        const box = new St.BoxLayout({
            style_class: 'network-quality-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cpuLabel = new St.Label({
            text: 'CPU —',
            style_class: 'network-quality-system',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._cpuLabel);
        box.add_child(this._separator());

        this._memoryLabel = new St.Label({
            text: 'MEM —',
            style_class: 'network-quality-system',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._memoryLabel);
        box.add_child(this._separator());

        this._graph = new St.DrawingArea({
            style_class: 'network-quality-graph',
            width: 90,
            height: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._graph.connect('repaint', () => this._drawGraph());
        box.add_child(this._graph);
        box.add_child(this._separator());

        this._countryLabel = new St.Label({
            text: '--',
            style_class: 'network-quality-country',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._countryLabel);
        box.add_child(this._separator());

        this._riskLabel = new St.Label({
            text: Risk.UNKNOWN,
            style_class: 'network-quality-risk risk-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._riskLabel);
        this.add_child(box);

        this._cpuValue = this._addInfoRow('CPU usage');
        this._memoryValue = this._addInfoRow('Memory usage');
        this._topProcessValues = [];
        for (let index = 0; index < TOP_PROCESS_COUNT; index++) {
            this._topProcessValues.push(
                this._addInfoRow(`CPU #${index + 1}`));
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._currentValue = this._addInfoRow('HTTPS time');
        this._failureValue = this._addInfoRow('Failure rate');
        this._targetValue = this._addInfoRow('Probe target');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._ipValue = this._addInfoRow('Public IP');
        this._countryValue = this._addInfoRow('Country');
        this._ispValue = this._addInfoRow('ISP / ASN');
        this._riskValue = this._addInfoRow('Risk');
        this._refresh();
    }

    _separator() {
        return new St.Label({
            text: '·',
            style_class: 'network-quality-separator',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _addInfoRow(title) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(new St.Label({
            text: title,
            style_class: 'network-quality-info-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const value = new St.Label({
            text: '—',
            style_class: 'network-quality-info-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        value.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        value.clutter_text.set_single_line_mode(true);
        item.add_child(value);
        this.menu.addMenuItem(item);
        return value;
    }

    setOnline(online) {
        this._online = online;
        this._refresh();
    }

    updateProbe(snapshot) {
        this._probe = snapshot;
        this._graph.queue_repaint();
        this._refresh();
    }

    updateIp(state) {
        this._ip = state;
        this._refresh();
    }

    updateSystem(state) {
        this._system = state;
        this._refresh();
    }

    _refresh() {
        this._cpuLabel.text = `CPU ${formatUsage(this._system.cpuPercent)}`;
        this._memoryLabel.text =
            `MEM ${formatUsage(this._system.memoryPercent)}`;
        this._cpuValue.text = formatUsage(this._system.cpuPercent, 1);
        this._memoryValue.text = formatUsage(this._system.memoryPercent, 1);
        for (let index = 0; index < TOP_PROCESS_COUNT; index++) {
            const process = this._system.topProcesses[index];
            if (index === 0 && this._system.collectingProcesses) {
                this._topProcessValues[index].text = 'Collecting…';
            } else {
                this._topProcessValues[index].text = process
                    ? `${process.name} · ${formatUsage(
                        process.cpuPercent, 1)}`
                    : '—';
            }
        }

        const stats = this._probe.stats || {};
        this._currentValue.text = this._online
            ? formatDuration(stats.currentDurationMs)
            : 'Offline';
        this._failureValue.text = this._online
            ? formatFailureRate(stats.failurePercent)
            : 'Offline';
        this._targetValue.text = this._online
            ? this._probe.targetName || 'Unknown'
            : 'Offline';

        const data = this._ip.data;
        this._ipValue.text = data ? data.ip : 'Unknown';
        this._countryValue.text = data ? data.country : 'Unknown';
        this._ispValue.text = data
            ? [data.isp, data.asn].filter(Boolean).join(' · ') || 'Unknown'
            : 'Unknown';

        if (!this._online) {
            this._countryLabel.text = '--';
            this._setRisk('Offline');
            this._riskValue.text = 'Offline';
        } else if (!data) {
            this._countryLabel.text = '--';
            this._setRisk(Risk.UNKNOWN);
            this._riskValue.text = this._ip.checking ? 'Checking…' : Risk.UNKNOWN;
        } else {
            this._countryLabel.text = data.country;
            this._setRisk(data.risk);
            const reasons = data.reasons.length
                ? ` · ${data.reasons.join(', ')}`
                : '';
            const stale = this._ip.stale ? ' · Stale' : '';
            this._riskValue.text = `${data.risk}${reasons}${stale}`;
        }
    }

    _setRisk(risk) {
        for (const className of [
            'risk-clean',
            'risk-attention',
            'risk-risk',
            'risk-unknown',
            'risk-offline',
        ]) {
            this._riskLabel.remove_style_class_name(className);
        }
        const classes = {
            [Risk.CLEAN]: 'risk-clean',
            [Risk.ATTENTION]: 'risk-attention',
            [Risk.RISK]: 'risk-risk',
            [Risk.UNKNOWN]: 'risk-unknown',
            Offline: 'risk-offline',
        };
        this._riskLabel.add_style_class_name(classes[risk] || 'risk-unknown');
        this._riskLabel.text = risk;
    }

    _drawGraph() {
        const [width, height] = this._graph.get_surface_size();
        const context = this._graph.get_context();
        const samples = this._probe.samples || [];
        const slotWidth = width / WINDOW_SIZE;
        const firstSlot = Math.max(0, WINDOW_SIZE - samples.length);

        for (let index = 0; index < samples.length; index++) {
            const visual = getSampleVisual(samples[index]);
            const color = GRAPH_COLORS[visual.color];
            const barHeight = Math.max(2, Math.round(height * visual.heightRatio));
            const x = (firstSlot + index) * slotWidth;
            const barWidth = Math.max(1, slotWidth - 0.5);
            context.setSourceRGBA(color[0], color[1], color[2], color[3]);
            context.rectangle(x, height - barHeight, barWidth, barHeight);
            context.fill();
        }
        context.$dispose();
    }
});

export default class NetworkQualityIpExtension extends Extension {
    enable() {
        this._indicator = new NetworkIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._probeMonitor = new HttpsMonitor(snapshot => {
            if (this._indicator)
                this._indicator.updateProbe(snapshot);
        });
        this._ipMonitor = new IpMonitor(state => {
            if (this._indicator)
                this._indicator.updateIp(state);
        });
        this._systemMonitor = new SystemMonitor(state => {
            if (this._indicator)
                this._indicator.updateSystem(state);
        });
        this._menuStateChangedId = this._indicator.menu.connect(
            'open-state-changed', (_menu, isOpen) => {
                if (this._systemMonitor)
                    this._systemMonitor.setProcessSamplingEnabled(isOpen);
            }
        );
        this._systemMonitor.start();

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._online = this._networkMonitor.get_network_available();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            (_monitor, online) => this._setOnline(online)
        );
        this._networkDebounceSource = 0;
        this._indicator.setOnline(this._online);
        if (this._online)
            this._startMonitors();
    }

    disable() {
        if (this._networkDebounceSource) {
            GLib.source_remove(this._networkDebounceSource);
            this._networkDebounceSource = 0;
        }
        if (this._networkMonitor && this._networkChangedId)
            this._networkMonitor.disconnect(this._networkChangedId);
        if (this._indicator && this._menuStateChangedId) {
            this._indicator.menu.disconnect(this._menuStateChangedId);
            this._menuStateChangedId = 0;
        }
        if (this._systemMonitor)
            this._systemMonitor.stop();
        if (this._probeMonitor)
            this._probeMonitor.stop();
        if (this._ipMonitor)
            this._ipMonitor.stop();
        if (this._indicator)
            this._indicator.destroy();

        this._indicator = null;
        this._probeMonitor = null;
        this._ipMonitor = null;
        this._systemMonitor = null;
        this._networkMonitor = null;
        this._networkChangedId = 0;
    }

    _setOnline(online) {
        this._online = online;
        this._indicator.setOnline(online);
        if (this._networkDebounceSource)
            GLib.source_remove(this._networkDebounceSource);
        this._networkDebounceSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                this._networkDebounceSource = 0;
                if (this._online)
                    this._startMonitors();
                else
                    this._stopMonitors();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _startMonitors() {
        this._probeMonitor.start();
        this._ipMonitor.start();
    }

    _stopMonitors() {
        this._probeMonitor.stop();
        this._ipMonitor.stop();
    }
}
