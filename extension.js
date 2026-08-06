import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    getSampleVisual,
    normalizeIpData,
    parsePingLine,
    Risk,
    SampleWindow,
    WINDOW_SIZE,
} from './core.js';

const PING_TARGET = '1.1.1.1';
const IP_API_URL = 'https://api.ipapi.is';
const IP_CHECK_INTERVAL_SECONDS = 15 * 60;
const PING_RETRY_SECONDS = 5;

const GRAPH_COLORS = Object.freeze({
    good: [0.18, 0.80, 0.44, 1],
    warning: [0.96, 0.69, 0.18, 1],
    bad: [0.91, 0.30, 0.24, 1],
    timeout: [0.55, 0.57, 0.61, 0.9],
});

function formatLatency(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—';
}

function formatLoss(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

class PingMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._window = new SampleWindow();
        this._active = false;
        this._generation = 0;
        this._nextSequence = 1;
        this._sequenceBase = 0;
        this._process = null;
        this._stream = null;
        this._cancellable = null;
        this._retrySource = 0;
    }

    start() {
        if (this._active)
            return;
        this._active = true;
        this._spawn();
    }

    stop() {
        this._active = false;
        this._generation++;
        if (this._retrySource) {
            GLib.source_remove(this._retrySource);
            this._retrySource = 0;
        }
        if (this._cancellable)
            this._cancellable.cancel();
        if (this._process) {
            try {
                this._process.force_exit();
            } catch (_error) {
                // The process may already have exited.
            }
        }
        this._process = null;
        this._stream = null;
        this._cancellable = null;
    }

    _spawn() {
        if (!this._active)
            return;

        const generation = ++this._generation;
        this._sequenceBase = this._nextSequence - 1;
        this._cancellable = new Gio.Cancellable();

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE,
            });
            launcher.setenv('LC_ALL', 'C', true);
            this._process = launcher.spawnv([
                '/usr/bin/ping',
                '-n',
                '-O',
                '-i', '1',
                '-W', '1',
                PING_TARGET,
            ]);
            this._stream = new Gio.DataInputStream({
                base_stream: this._process.get_stdout_pipe(),
                close_base_stream: true,
            });
            this._readLine(generation);
            this._waitForExit(generation);
        } catch (error) {
            this._fail(generation, error);
        }
    }

    _readLine(generation) {
        if (!this._active || generation !== this._generation || !this._stream)
            return;

        this._stream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (stream, result) => {
                if (!this._active || generation !== this._generation)
                    return;
                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (line === null)
                        return;
                    const event = parsePingLine(line);
                    if (event) {
                        event.sequence += this._sequenceBase;
                        this._nextSequence = Math.max(
                            this._nextSequence, event.sequence + 1);
                        if (this._window.record(event))
                            this._emitUpdate();
                    }
                    this._readLine(generation);
                } catch (error) {
                    if (!this._isCancelled(error))
                        this._fail(generation, error);
                }
            }
        );
    }

    _waitForExit(generation) {
        this._process.wait_async(this._cancellable, (process, result) => {
            if (!this._active || generation !== this._generation)
                return;
            try {
                process.wait_finish(result);
                this._fail(generation, new Error('ping exited unexpectedly'));
            } catch (error) {
                if (!this._isCancelled(error))
                    this._fail(generation, error);
            }
        });
    }

    _fail(generation, error) {
        if (!this._active || generation !== this._generation)
            return;

        console.warn(`Network Quality & IP: ${error.message}`);
        this._generation++;
        if (this._cancellable)
            this._cancellable.cancel();
        if (this._process) {
            try {
                this._process.force_exit();
            } catch (_error) {
                // The process may already have exited.
            }
        }
        this._process = null;
        this._stream = null;
        this._cancellable = null;
        this._retrySource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            PING_RETRY_SECONDS,
            () => {
                this._retrySource = 0;
                this._spawn();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _emitUpdate() {
        this._onUpdate({
            samples: this._window.getSamples(),
            stats: this._window.getStats(),
        });
    }

    _isCancelled(error) {
        return error.code === Gio.IOErrorEnum.CANCELLED;
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

        this._online = true;
        this._ping = {samples: [], stats: {}};
        this._ip = {checking: false, data: null, stale: false};

        const box = new St.BoxLayout({
            style_class: 'network-quality-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
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

        this._currentValue = this._addInfoRow('Current RTT');
        this._lossValue = this._addInfoRow('Packet loss');
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
        item.add_child(value);
        this.menu.addMenuItem(item);
        return value;
    }

    setOnline(online) {
        this._online = online;
        this._refresh();
    }

    updatePing(snapshot) {
        this._ping = snapshot;
        this._graph.queue_repaint();
        this._refresh();
    }

    updateIp(state) {
        this._ip = state;
        this._refresh();
    }

    _refresh() {
        const stats = this._ping.stats || {};
        this._currentValue.text = this._online
            ? formatLatency(stats.currentLatencyMs)
            : 'Offline';
        this._lossValue.text = this._online
            ? formatLoss(stats.lossPercent)
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
        const samples = this._ping.samples || [];
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

        this._pingMonitor = new PingMonitor(snapshot => {
            if (this._indicator)
                this._indicator.updatePing(snapshot);
        });
        this._ipMonitor = new IpMonitor(state => {
            if (this._indicator)
                this._indicator.updateIp(state);
        });

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
        if (this._pingMonitor)
            this._pingMonitor.stop();
        if (this._ipMonitor)
            this._ipMonitor.stop();
        if (this._indicator)
            this._indicator.destroy();

        this._indicator = null;
        this._pingMonitor = null;
        this._ipMonitor = null;
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
        this._pingMonitor.start();
        this._ipMonitor.start();
    }

    _stopMonitors() {
        this._pingMonitor.stop();
        this._ipMonitor.stop();
    }
}
