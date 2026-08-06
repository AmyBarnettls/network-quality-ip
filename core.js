export const WINDOW_SIZE = 60;
export const MAX_GRAPH_LATENCY_MS = 300;

export const SampleStatus = Object.freeze({
    SUCCESS: 'success',
    TIMEOUT: 'timeout',
});

export const Risk = Object.freeze({
    CLEAN: 'Clean',
    ATTENTION: 'Attention',
    RISK: 'Risk',
    UNKNOWN: 'Unknown',
});

function readNumber(text, start, allowDecimal) {
    let end = start;
    let decimalSeen = false;

    while (end < text.length) {
        const character = text[end];
        if (character >= '0' && character <= '9') {
            end++;
            continue;
        }
        if (allowDecimal && character === '.' && !decimalSeen) {
            decimalSeen = true;
            end++;
            continue;
        }
        break;
    }

    if (end === start)
        return null;

    const value = Number(text.slice(start, end));
    return Number.isFinite(value) ? value : null;
}

export function parsePingLine(line) {
    if (typeof line !== 'string')
        return null;

    const sequenceMarker = 'icmp_seq=';
    const sequenceStart = line.indexOf(sequenceMarker);
    if (sequenceStart < 0)
        return null;

    const sequence = readNumber(
        line, sequenceStart + sequenceMarker.length, false);
    if (!Number.isInteger(sequence))
        return null;

    if (line.indexOf('no answer yet for ', 0) >= 0) {
        return {
            sequence,
            status: SampleStatus.TIMEOUT,
            latencyMs: null,
        };
    }

    let timeStart = line.indexOf('time=', sequenceStart);
    let upperBound = false;
    if (timeStart < 0) {
        timeStart = line.indexOf('time<', sequenceStart);
        upperBound = timeStart >= 0;
    }
    if (timeStart < 0)
        return null;

    const latency = readNumber(line, timeStart + 5, true);
    if (latency === null)
        return null;

    return {
        sequence,
        status: SampleStatus.SUCCESS,
        latencyMs: upperBound ? Math.max(1, latency) : latency,
    };
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
                event.status === SampleStatus.TIMEOUT)
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
                    status: SampleStatus.TIMEOUT,
                    latencyMs: null,
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
            Number.isFinite(sample.latencyMs));
        const latest = this._samples[this._samples.length - 1];
        const lossCount = this._samples.length - successful.length;

        return {
            currentLatencyMs: latest && latest.status === SampleStatus.SUCCESS
                ? latest.latencyMs
                : null,
            lossPercent: this._samples.length
                ? lossCount / this._samples.length * 100
                : null,
        };
    }
}

export function getSampleVisual(sample) {
    if (!sample || sample.status !== SampleStatus.SUCCESS ||
        !Number.isFinite(sample.latencyMs)) {
        return {color: 'timeout', heightRatio: 1};
    }

    let color = 'bad';
    if (sample.latencyMs <= 80)
        color = 'good';
    else if (sample.latencyMs <= 150)
        color = 'warning';

    const normalized = Math.min(
        sample.latencyMs, MAX_GRAPH_LATENCY_MS) / MAX_GRAPH_LATENCY_MS;
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
