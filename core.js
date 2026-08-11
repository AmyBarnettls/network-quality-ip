export const WINDOW_SIZE = 60;
export const MAX_GRAPH_DURATION_MS = 3000;

export const SampleStatus = Object.freeze({
    SUCCESS: 'success',
    FAILURE: 'failure',
});

export const ProbeProvider = Object.freeze({
    GOOGLE: 'google',
    CLOUDFLARE: 'cloudflare',
    APPLE: 'apple',
});

export const Risk = Object.freeze({
    CLEAN: 'Clean',
    ATTENTION: 'Attention',
    RISK: 'Risk',
    UNKNOWN: 'Unknown',
});

export function validateProbeResponse(provider, status, body) {
    if (!Number.isInteger(status) || typeof body !== 'string')
        return false;

    if (provider === ProbeProvider.GOOGLE)
        return status === 204 && body.length === 0;

    if (provider === ProbeProvider.CLOUDFLARE) {
        if (status !== 200)
            return false;
        const fields = new Map();
        for (const line of body.trim().split('\n')) {
            const separator = line.indexOf('=');
            if (separator > 0)
                fields.set(line.slice(0, separator), line.slice(separator + 1));
        }
        return fields.get('h') === 'cloudflare.com' &&
            Boolean(fields.get('colo')) && Boolean(fields.get('tls'));
    }

    if (provider === ProbeProvider.APPLE) {
        const expected = '<HTML><HEAD><TITLE>Success</TITLE></HEAD>' +
            '<BODY>Success</BODY></HTML>';
        return status === 200 && body.trim() === expected;
    }

    return false;
}

export class SampleWindow {
    constructor(size = WINDOW_SIZE) {
        this._size = size;
        this._samples = [];
    }

    record(event) {
        if (!event || !Number.isInteger(event.sequence) || event.sequence < 0)
            return false;

        const existingIndex = this._samples.findIndex(
            sample => sample.sequence === event.sequence);
        if (existingIndex >= 0) {
            const existing = this._samples[existingIndex];
            if (existing.status === SampleStatus.SUCCESS &&
                event.status === SampleStatus.FAILURE)
                return false;
            this._samples[existingIndex] = {...event};
            return true;
        }

        const last = this._samples[this._samples.length - 1];
        if (last && event.sequence < last.sequence)
            return false;

        if (last) {
            for (let sequence = last.sequence + 1;
                sequence < event.sequence; sequence++) {
                this._samples.push({
                    sequence,
                    status: SampleStatus.FAILURE,
                    durationMs: null,
                });
            }
        }

        this._samples.push({...event});
        if (this._samples.length > this._size)
            this._samples.splice(0, this._samples.length - this._size);
        return true;
    }

    getSamples() {
        return this._samples.map(sample => ({...sample}));
    }

    getStats() {
        const successful = this._samples.filter(sample =>
            sample.status === SampleStatus.SUCCESS &&
            Number.isFinite(sample.durationMs));
        const latest = this._samples[this._samples.length - 1];
        const failureCount = this._samples.length - successful.length;

        return {
            currentDurationMs: latest && latest.status === SampleStatus.SUCCESS
                ? latest.durationMs
                : null,
            failurePercent: this._samples.length
                ? failureCount / this._samples.length * 100
                : null,
        };
    }
}

export function getSampleVisual(sample) {
    if (!sample || sample.status !== SampleStatus.SUCCESS ||
        !Number.isFinite(sample.durationMs)) {
        return {color: 'failure', heightRatio: 1};
    }

    let color = 'bad';
    if (sample.durationMs <= 300)
        color = 'good';
    else if (sample.durationMs <= 800)
        color = 'warning';

    const normalized = Math.min(
        sample.durationMs, MAX_GRAPH_DURATION_MS) / MAX_GRAPH_DURATION_MS;
    return {color, heightRatio: 0.16 + normalized * 0.84};
}

export function normalizeIpData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.error || typeof payload.ip !== 'string' || !payload.ip)
        return null;

    const flags = {
        isAbuser: payload.is_abuser,
        isDatacenter: payload.is_datacenter,
        isProxy: payload.is_proxy,
        isTor: payload.is_tor,
        isVpn: payload.is_vpn,
    };
    if (Object.values(flags).some(value => typeof value !== 'boolean'))
        return null;

    const reasons = [];
    if (flags.isTor)
        reasons.push('Tor');
    if (flags.isAbuser)
        reasons.push('Abuse');
    if (flags.isVpn)
        reasons.push('VPN');
    if (flags.isProxy)
        reasons.push('Proxy');
    if (flags.isDatacenter)
        reasons.push('Datacenter');

    let risk = Risk.CLEAN;
    if (flags.isTor || flags.isAbuser)
        risk = Risk.RISK;
    else if (reasons.length)
        risk = Risk.ATTENTION;

    const country = typeof payload.cc === 'string' && payload.cc.length === 2
        ? payload.cc.toUpperCase()
        : '--';
    const isp = typeof payload.company_name === 'string' && payload.company_name
        ? payload.company_name
        : typeof payload.asn_org === 'string' ? payload.asn_org : '';
    const asn = Number.isInteger(payload.asn_num) && payload.asn_num > 0
        ? `AS${payload.asn_num}`
        : '';

    return {ip: payload.ip, country, isp, asn, risk, reasons};
}
