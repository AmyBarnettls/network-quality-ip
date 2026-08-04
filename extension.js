import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {getSampleVisual, Purity, WINDOW_SIZE} from './core.js';
import {IpService} from './ipService.js';
import {PingMonitor} from './pingMonitor.js';

const GRAPH_COLORS = Object.freeze({
    good: [0.18, 0.80, 0.44, 1.0],
    warning: [0.96, 0.69, 0.18, 1.0],
    bad: [0.91, 0.30, 0.24, 1.0],
    timeout: [0.55, 0.57, 0.61, 0.9],
});

function formatMetric(value, suffix = ' ms') {
    return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '—';
}

function formatTimestamp(timestamp) {
    if (!timestamp)
        return 'Never';

    const dateTime = GLib.DateTime.new_from_unix_local(Math.floor(timestamp / 1000));
    return dateTime.format('%Y-%m-%d %H:%M:%S');
}

function yesNo(value) {
    return value ? 'Yes' : 'No';
}

const NetworkIndicator = GObject.registerClass(
class NetworkIndicator extends PanelMenu.Button {
    _init(settings, callbacks) {
        super._init(0.0, 'Network Quality & IP');

        this._settings = settings;
        this._callbacks = callbacks;
        this._pingSnapshot = {
            state: 'stopped',
            error: null,
            samples: [],
            stats: {},
        };
        this._ipState = {
            ip: null,
            intelligence: null,
            purity: Purity.UNKNOWN,
            checking: false,
            stale: false,
            error: null,
            lastIpCheck: null,
            lastIntelUpdate: null,
        };
        this._networkAvailable = true;
        this._greenMaximum = settings.get_int('green-latency-max');
        this._amberMaximum = settings.get_int('amber-latency-max');

        const panelBox = new St.BoxLayout({
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
        panelBox.add_child(this._graph);

        panelBox.add_child(new St.Label({
            text: '·',
            style_class: 'network-quality-separator',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._countryLabel = new St.Label({
            text: '--',
            style_class: 'network-quality-country',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._countryLabel);

        panelBox.add_child(new St.Label({
            text: '·',
            style_class: 'network-quality-separator',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._purityLabel = new St.Label({
            text: Purity.UNKNOWN,
            style_class: 'network-quality-purity purity-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._purityLabel);
        this.add_child(panelBox);

        this._buildMenu();
        this._updateMenu();
    }

    _buildMenu() {
        this._pingStateValue = this._addInfoRow('Probe status');
        this._currentValue = this._addInfoRow('Current RTT');
        this._medianValue = this._addInfoRow('Median RTT');
        this._p95Value = this._addInfoRow('P95 RTT');
        this._jitterValue = this._addInfoRow('Jitter');
        this._lossValue = this._addInfoRow('Packet loss');
        this._sampleValue = this._addInfoRow('Samples');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._ipValue = this._addInfoRow('Public IPv4');
        this._locationValue = this._addInfoRow('Location');
        this._ispValue = this._addInfoRow('ISP / company');
        this._asnValue = this._addInfoRow('ASN');
        this._purityValue = this._addInfoRow('Purity');
        this._flagsValue = this._addInfoRow('Risk flags');
        this._updatedValue = this._addInfoRow('IP intelligence');

        const notice = new PopupMenu.PopupMenuItem(
            'Reputation is probabilistic and does not guarantee safety.',
            {reactive: false, can_focus: false}
        );
        notice.label.add_style_class_name('network-quality-notice');
        this.menu.addMenuItem(notice);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh IP now');
        refreshItem.connect('activate', () => this._callbacks.refreshIp());
        this.menu.addMenuItem(refreshItem);

        const resetItem = new PopupMenu.PopupMenuItem('Reset graph');
        resetItem.connect('activate', () => this._callbacks.resetGraph());
        this.menu.addMenuItem(resetItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._callbacks.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _addInfoRow(title) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const titleLabel = new St.Label({
            text: title,
            style_class: 'network-quality-info-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const valueLabel = new St.Label({
            text: '—',
            style_class: 'network-quality-info-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(titleLabel);
        item.add_child(valueLabel);
        this.menu.addMenuItem(item);
        return valueLabel;
    }

    setThresholds(greenMaximum, amberMaximum) {
        this._greenMaximum = greenMaximum;
        this._amberMaximum = amberMaximum;
        this._graph.queue_repaint();
    }

    setNetworkAvailable(available) {
        this._networkAvailable = available;
        this._updateMenu();
    }

    updatePing(snapshot) {
        this._pingSnapshot = snapshot;
        this._graph.queue_repaint();
        this._updateMenu();
    }

    updateIp(state) {
        this._ipState = state;
        const location = state.intelligence && state.intelligence.location;
        this._countryLabel.text = location && location.country_code
            ? location.country_code.toUpperCase()
            : '--';
        this._setPurity(state.purity);
        this._updateMenu();
    }

    _setPurity(purity) {
        for (const className of [
            'purity-clean',
            'purity-attention',
            'purity-risk',
            'purity-unknown',
        ]) {
            this._purityLabel.remove_style_class_name(className);
        }

        const className = {
            [Purity.CLEAN]: 'purity-clean',
            [Purity.ATTENTION]: 'purity-attention',
            [Purity.RISK]: 'purity-risk',
            [Purity.UNKNOWN]: 'purity-unknown',
        }[purity] || 'purity-unknown';
        this._purityLabel.add_style_class_name(className);
        this._purityLabel.text = purity || Purity.UNKNOWN;
    }

    _updateMenu() {
        const snapshot = this._pingSnapshot;
        const stats = snapshot.stats || {};
        if (!this._networkAvailable)
            this._pingStateValue.text = 'Offline';
        else if (snapshot.state === 'error')
            this._pingStateValue.text = `Error: ${snapshot.error || 'unknown error'}`;
        else
            this._pingStateValue.text = snapshot.state[0].toUpperCase() +
                snapshot.state.slice(1);

        this._currentValue.text = formatMetric(stats.currentLatencyMs);
        this._medianValue.text = formatMetric(stats.medianLatencyMs);
        this._p95Value.text = formatMetric(stats.p95LatencyMs);
        this._jitterValue.text = formatMetric(stats.jitterMs);
        this._lossValue.text = Number.isFinite(stats.lossPercent)
            ? `${stats.lossPercent.toFixed(1)}%`
            : '—';
        this._sampleValue.text = `${stats.validCount || 0}/${stats.totalCount || 0}`;

        const state = this._ipState;
        const intelligence = state.intelligence;
        const location = intelligence && intelligence.location;
        const company = intelligence && intelligence.company;
        const asn = intelligence && intelligence.asn;
        this._ipValue.text = state.ip || 'Unknown';
        this._locationValue.text = location
            ? [location.country, location.state, location.city]
                .filter(Boolean).join(' · ') || 'Unknown'
            : 'Unknown';
        this._ispValue.text = company && company.name
            ? company.name
            : asn && asn.org ? asn.org : 'Unknown';
        this._asnValue.text = asn && asn.asn
            ? `AS${asn.asn}${asn.org ? ` · ${asn.org}` : ''}`
            : 'Unknown';
        this._purityValue.text = `${state.purity || Purity.UNKNOWN}` +
            `${state.stale ? ' (stale)' : ''}`;
        this._flagsValue.text = intelligence
            ? `DC ${yesNo(intelligence.is_datacenter)} · ` +
                `Tor ${yesNo(intelligence.is_tor)} · ` +
                `Proxy ${yesNo(intelligence.is_proxy)} · ` +
                `VPN ${yesNo(intelligence.is_vpn)} · ` +
                `Abuse ${yesNo(intelligence.is_abuser)}`
            : 'Unknown';
        this._updatedValue.text = state.checking
            ? 'Checking…'
            : `${formatTimestamp(state.lastIntelUpdate)}` +
                `${state.stale ? ' · stale' : ''}`;
    }

    _drawGraph() {
        const [width, height] = this._graph.get_surface_size();
        const context = this._graph.get_context();
        const samples = this._pingSnapshot.samples || [];
        const slotWidth = width / WINDOW_SIZE;
        const firstSlot = Math.max(0, WINDOW_SIZE - samples.length);

        for (let index = 0; index < samples.length; index++) {
            const visual = getSampleVisual(
                samples[index], this._greenMaximum, this._amberMaximum);
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
        this._settings = this.getSettings();
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkAvailable = this._networkMonitor.get_network_available();
        this._networkDebounceSource = 0;
        this._settingsSignalIds = [];
        this._ipServiceStarted = false;

        this._indicator = new NetworkIndicator(this._settings, {
            refreshIp: () => this._ipService.refresh(),
            resetGraph: () => this._pingMonitor.reset(),
            openPreferences: () => this.openPreferences(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._pingMonitor = new PingMonitor(snapshot => {
            if (this._indicator)
                this._indicator.updatePing(snapshot);
        });
        this._ipService = new IpService(state => {
            if (this._indicator)
                this._indicator.updateIp(state);
        });

        this._settingsSignalIds.push(this._settings.connect(
            'changed::ping-target',
            () => {
                if (this._networkAvailable)
                    this._pingMonitor.restart(this._settings.get_string('ping-target'));
            }
        ));
        for (const key of ['green-latency-max', 'amber-latency-max']) {
            this._settingsSignalIds.push(this._settings.connect(
                `changed::${key}`,
                () => this._indicator.setThresholds(
                    this._settings.get_int('green-latency-max'),
                    this._settings.get_int('amber-latency-max'))
            ));
        }

        this._networkChangedId = this._networkMonitor.connect(
            'network-changed',
            (_monitor, available) => this._handleNetworkChanged(available)
        );
        this._indicator.setNetworkAvailable(this._networkAvailable);
        if (this._networkAvailable)
            this._startNetworkServices();
    }

    disable() {
        if (this._networkDebounceSource) {
            GLib.source_remove(this._networkDebounceSource);
            this._networkDebounceSource = 0;
        }

        if (this._networkMonitor && this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
        }

        if (this._settings) {
            for (const signalId of this._settingsSignalIds)
                this._settings.disconnect(signalId);
        }

        if (this._pingMonitor)
            this._pingMonitor.stop(false);
        if (this._ipService)
            this._ipService.stop();

        if (this._indicator)
            this._indicator.destroy();

        this._indicator = null;
        this._pingMonitor = null;
        this._ipService = null;
        this._networkMonitor = null;
        this._settings = null;
        this._settingsSignalIds = null;
        this._ipServiceStarted = false;
    }

    _startNetworkServices() {
        this._pingMonitor.start(this._settings.get_string('ping-target'));
        if (!this._ipServiceStarted) {
            this._ipService.start();
            this._ipServiceStarted = true;
        } else {
            this._ipService.checkNow(false);
        }
    }

    _handleNetworkChanged(available) {
        this._networkAvailable = available;
        this._indicator.setNetworkAvailable(available);

        if (this._networkDebounceSource)
            GLib.source_remove(this._networkDebounceSource);

        this._networkDebounceSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                this._networkDebounceSource = 0;
                if (this._networkAvailable) {
                    this._startNetworkServices();
                } else {
                    this._pingMonitor.stop();
                    this._ipService.stop();
                    this._ipServiceStarted = false;
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }
}
