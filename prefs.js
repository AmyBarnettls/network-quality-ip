import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {isValidPingTarget} from './core.js';

export default class NetworkQualityIpPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 560);

        const page = new Adw.PreferencesPage({
            title: 'Network Quality & IP',
            icon_name: 'network-wired-symbolic',
        });
        window.add(page);

        const probeGroup = new Adw.PreferencesGroup({
            title: 'ICMP probe',
            description: 'One ICMP echo is sent every second. The graph always covers the latest 60 samples.',
        });
        page.add(probeGroup);

        const targetRow = new Adw.ActionRow({
            title: 'Ping target',
            subtitle: 'IPv4 address or DNS hostname',
        });
        const targetEntry = new Gtk.Entry({
            text: settings.get_string('ping-target'),
            hexpand: true,
            width_chars: 20,
            valign: Gtk.Align.CENTER,
        });
        const applyButton = new Gtk.Button({
            icon_name: 'object-select-symbolic',
            tooltip_text: 'Apply ping target',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        targetRow.add_suffix(targetEntry);
        targetRow.add_suffix(applyButton);
        targetRow.activatable_widget = targetEntry;
        probeGroup.add(targetRow);

        const validateTarget = () => {
            const valid = isValidPingTarget(targetEntry.text.trim());
            applyButton.sensitive = valid;
            if (valid)
                targetEntry.remove_css_class('error');
            else
                targetEntry.add_css_class('error');
            return valid;
        };
        const applyTarget = () => {
            if (validateTarget())
                settings.set_string('ping-target', targetEntry.text.trim());
        };
        targetEntry.connect('changed', validateTarget);
        targetEntry.connect('activate', applyTarget);
        applyButton.connect('clicked', applyTarget);

        const greenRow = Adw.SpinRow.new_with_range(1, 999, 1);
        greenRow.title = 'Green latency maximum';
        greenRow.subtitle = 'Samples at or below this RTT are green';
        greenRow.value = settings.get_int('green-latency-max');
        probeGroup.add(greenRow);

        const amberRow = Adw.SpinRow.new_with_range(2, 1000, 1);
        amberRow.title = 'Amber latency maximum';
        amberRow.subtitle = 'Higher samples are red';
        amberRow.value = settings.get_int('amber-latency-max');
        probeGroup.add(amberRow);

        let updatingThresholds = false;
        greenRow.connect('notify::value', () => {
            if (updatingThresholds)
                return;
            updatingThresholds = true;
            const green = Math.round(greenRow.value);
            if (amberRow.value <= green)
                amberRow.value = Math.min(1000, green + 1);
            settings.set_int('green-latency-max', green);
            settings.set_int('amber-latency-max', Math.round(amberRow.value));
            updatingThresholds = false;
        });
        amberRow.connect('notify::value', () => {
            if (updatingThresholds)
                return;
            updatingThresholds = true;
            const amber = Math.round(amberRow.value);
            if (greenRow.value >= amber)
                greenRow.value = Math.max(1, amber - 1);
            settings.set_int('green-latency-max', Math.round(greenRow.value));
            settings.set_int('amber-latency-max', amber);
            updatingThresholds = false;
        });

        const privacyGroup = new Adw.PreferencesGroup({
            title: 'Privacy and data sources',
            description: 'The extension checks your public IPv4 every minute and refreshes reputation data only when the address changes.',
        });
        page.add(privacyGroup);

        privacyGroup.add(new Adw.ActionRow({
            title: 'Public IPv4',
            subtitle: 'api.ipify.org · checked every 60 seconds',
        }));
        privacyGroup.add(new Adw.ActionRow({
            title: 'Location and reputation',
            subtitle: 'api.ipapi.is · queried on first use and when IPv4 changes',
        }));
        privacyGroup.add(new Adw.ActionRow({
            title: 'Important',
            subtitle: 'These services receive your public IPv4. Reputation results are probabilistic and do not guarantee safety.',
        }));
    }
}
