import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {classifyPurity, isValidIpv4, Purity} from './core.js';

const IP_CHECK_URL = 'https://api.ipify.org?format=json';
const INTELLIGENCE_URL = 'https://api.ipapi.is/?q=';

export class IpService {
    constructor(onUpdate, requestOverride = null) {
        this._onUpdate = onUpdate;
        this._requestOverride = requestOverride;
        this._active = false;
        this._timerSource = 0;
        this._checking = false;
        this._pendingForce = false;
        this._cancellable = null;
        this._session = null;
        this._state = this._emptyState();
    }

    start() {
        if (this._active)
            return;

        this._active = true;
        this._session = new Soup.Session({
            timeout: 5,
            user_agent: 'Network Quality & IP/1.0',
        });
        this._cancellable = new Gio.Cancellable();
        const initialCheck = this.checkNow(false);
        this._timerSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this.checkNow(false);
                return GLib.SOURCE_CONTINUE;
            }
        );
        return initialCheck;
    }

    stop() {
        this._active = false;
        if (this._timerSource) {
            GLib.source_remove(this._timerSource);
            this._timerSource = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session)
            this._session.abort();
        this._session = null;
        this._checking = false;
        this._pendingForce = false;
    }

    refresh() {
        this.checkNow(true);
    }

    getState() {
        return {...this._state};
    }

    async checkNow(forceIntelligence = false) {
        if (!this._active)
            return;

        if (this._checking) {
            this._pendingForce = this._pendingForce || forceIntelligence;
            return;
        }

        this._checking = true;
        this._state.checking = true;
        this._emitUpdate();

        try {
            const ipResponse = await this._requestJson(IP_CHECK_URL);
            if (!this._active)
                return;
            if (!ipResponse || !isValidIpv4(ipResponse.ip))
                throw new Error('The public IPv4 service returned invalid data');

            const ip = ipResponse.ip;
            const changed = ip !== this._state.ip;
            this._state.lastIpCheck = Date.now();
            this._state.error = null;

            if (changed) {
                this._state = {
                    ...this._emptyState(),
                    ip,
                    checking: true,
                    lastIpCheck: Date.now(),
                };
                this._emitUpdate();
            }

            if (changed || forceIntelligence || !this._state.intelligence)
                await this._updateIntelligence(ip, changed);
            else
                this._state.stale = false;
        } catch (error) {
            if (!this._active)
                return;
            this._state.error = error.message;
            this._state.stale = this._state.ip !== null;
        } finally {
            if (!this._active)
                return;

            this._checking = false;
            this._state.checking = false;
            this._emitUpdate();

            if (this._pendingForce) {
                const pendingForce = this._pendingForce;
                this._pendingForce = false;
                GLib.idle_add_once(() => this.checkNow(pendingForce));
            }
        }
    }

    async _updateIntelligence(ip, ipChanged) {
        const oldIntelligence = this._state.intelligence;
        try {
            const intelligence = await this._requestJson(
                `${INTELLIGENCE_URL}${encodeURIComponent(ip)}`);
            if (!this._active || this._state.ip !== ip)
                return;
            if (!intelligence || intelligence.error || intelligence.ip !== ip)
                throw new Error(intelligence && intelligence.error
                    ? intelligence.error
                    : 'The IP intelligence service returned invalid data');

            this._state.intelligence = intelligence;
            this._state.purity = classifyPurity(intelligence);
            this._state.lastIntelUpdate = Date.now();
            this._state.stale = false;
            this._state.error = null;
        } catch (error) {
            if (!this._active)
                return;
            if (!ipChanged && oldIntelligence) {
                this._state.intelligence = oldIntelligence;
                this._state.purity = classifyPurity(oldIntelligence);
            } else {
                this._state.intelligence = null;
                this._state.purity = Purity.UNKNOWN;
            }
            this._state.stale = true;
            this._state.error = error.message;
        }
    }

    _requestJson(url) {
        if (this._requestOverride)
            return this._requestOverride(url);

        return new Promise((resolve, reject) => {
            if (!this._active || !this._session) {
                reject(new Error('IP service is stopped'));
                return;
            }

            const message = Soup.Message.new('GET', url);
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (message.get_status() < 200 || message.get_status() >= 300)
                            throw new Error(`HTTP ${message.get_status()}`);
                        const text = new TextDecoder('utf-8').decode(bytes.get_data());
                        resolve(JSON.parse(text));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    _emptyState() {
        return {
            ip: null,
            intelligence: null,
            purity: Purity.UNKNOWN,
            checking: false,
            stale: false,
            error: null,
            lastIpCheck: null,
            lastIntelUpdate: null,
        };
    }

    _emitUpdate() {
        if (this._active && this._onUpdate)
            this._onUpdate(this.getState());
    }
}
