export const WINDOW_SIZE = 60;
export const MAX_GRAPH_LATENCY_MS = 300;

export const SampleStatus = Object.freeze({
    SUCCESS: 'success',
    TIMEOUT: 'timeout',
});

export const Purity = Object.freeze({
    CLEAN: 'Clean',
    ATTENTION: 'Attention',
    RISK: 'Risk',
    UNKNOWN: 'Unknown',
});

export function parsePingLine(line) {
    if (typeof line !== 'string')
        return null;

    const success = line.match(/icmp_seq=(\d+).*time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms/i);
    if (success) {
        return {
            sequence: Number.parseInt(success[1], 10),
            status: SampleStatus.SUCCESS,
            latencyMs: Number.parseFloat(success[2]),
        };
    }

    const timeout = line.match(/no answer yet for icmp_seq=(\d+)/i);
    if (timeout) {
        return {
            sequence: Number.parseInt(timeout[1], 10),
            status: SampleStatus.TIMEOUT,
            latencyMs: null,
        };
    }

    return null;
}

function percentile(sortedValues, quantile) {
    if (sortedValues.length === 0)
        return null;

    const index = Math.max(0, Math.ceil(quantile * sortedValues.length) - 1);
    return sortedValues[index];
}

function median(sortedValues) {
    if (sortedValues.length === 0)
        return null;

    const midpoint = Math.floor(sortedValues.length / 2);
    if (sortedValues.length % 2 === 1)
        return sortedValues[midpoint];

    return (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2;
}

export class SampleWindow {
    constructor(size = WINDOW_SIZE) {
        this._size = size;
        this.reset();
    }

    reset() {
        this._samples = new Map();
        this._highestSequence = null;
    }

    record(event) {
        if (!event || !Number.isInteger(event.sequence) || event.sequence < 0)
            return false;

        if (this._highestSequence === null) {
            this._highestSequence = event.sequence;
        } else if (event.sequence > this._highestSequence) {
            for (let sequence = this._highestSequence + 1;
                sequence < event.sequence; sequence++) {
                this._samples.set(sequence, {
                    sequence,
                    status: SampleStatus.TIMEOUT,
                    latencyMs: null,
                });
            }
            this._highestSequence = event.sequence;
        }

        const minimumSequence = this._highestSequence - this._size + 1;
        if (event.sequence < minimumSequence)
            return false;

        const previous = this._samples.get(event.sequence);
        if (previous && previous.status === SampleStatus.SUCCESS &&
            event.status === SampleStatus.TIMEOUT)
            return false;

        this._samples.set(event.sequence, {
            sequence: event.sequence,
            status: event.status,
            latencyMs: event.status === SampleStatus.SUCCESS
                ? event.latencyMs
                : null,
        });

        for (const sequence of this._samples.keys()) {
            if (sequence < minimumSequence)
                this._samples.delete(sequence);
        }

        return true;
    }

    getSamples() {
        return [...this._samples.values()]
            .sort((left, right) => left.sequence - right.sequence)
            .map(sample => ({...sample}));
    }

    getStats() {
        const samples = this.getSamples();
        const successful = samples.filter(sample =>
            sample.status === SampleStatus.SUCCESS &&
            Number.isFinite(sample.latencyMs));
        const sortedLatencies = successful
            .map(sample => sample.latencyMs)
            .sort((left, right) => left - right);

        const adjacentDifferences = [];
        for (let index = 1; index < successful.length; index++) {
            if (successful[index].sequence === successful[index - 1].sequence + 1) {
                adjacentDifferences.push(Math.abs(
                    successful[index].latencyMs - successful[index - 1].latencyMs));
            }
        }

        const latest = samples.length > 0 ? samples[samples.length - 1] : null;
        const lossCount = samples.length - successful.length;

        return {
            totalCount: samples.length,
            validCount: successful.length,
            lossCount,
            lossPercent: samples.length > 0
                ? lossCount / samples.length * 100
                : null,
            currentLatencyMs: latest && latest.status === SampleStatus.SUCCESS
                ? latest.latencyMs
                : null,
            medianLatencyMs: median(sortedLatencies),
            p95LatencyMs: percentile(sortedLatencies, 0.95),
            jitterMs: adjacentDifferences.length > 0
                ? adjacentDifferences.reduce((sum, value) => sum + value, 0) /
                    adjacentDifferences.length
                : null,
        };
    }
}

export function getSampleVisual(sample, greenMaximum, amberMaximum) {
    if (!sample || sample.status !== SampleStatus.SUCCESS ||
        !Number.isFinite(sample.latencyMs)) {
        return {color: 'timeout', heightRatio: 1};
    }

    let color = 'bad';
    if (sample.latencyMs <= greenMaximum)
        color = 'good';
    else if (sample.latencyMs <= amberMaximum)
        color = 'warning';

    const normalized = Math.min(sample.latencyMs, MAX_GRAPH_LATENCY_MS) /
        MAX_GRAPH_LATENCY_MS;

    return {
        color,
        heightRatio: 0.16 + normalized * 0.84,
    };
}

export function classifyPurity(intelligence) {
    if (!intelligence || intelligence.error || intelligence.is_bogon)
        return Purity.UNKNOWN;

    if (intelligence.is_abuser || intelligence.is_tor)
        return Purity.RISK;

    if (intelligence.is_proxy || intelligence.is_vpn ||
        intelligence.is_datacenter || intelligence.is_crawler ||
        intelligence.egress_service) {
        return Purity.ATTENTION;
    }

    return Purity.CLEAN;
}

export function isValidIpv4(value) {
    if (typeof value !== 'string')
        return false;

    const octets = value.split('.');
    if (octets.length !== 4)
        return false;

    return octets.every(octet => {
        if (!/^(0|[1-9]\d{0,2})$/.test(octet))
            return false;
        const number = Number.parseInt(octet, 10);
        return number >= 0 && number <= 255;
    });
}

export function isValidPingTarget(value) {
    if (isValidIpv4(value))
        return true;
    if (typeof value !== 'string' || value.length === 0 || value.length > 253)
        return false;
    if (value.startsWith('-') || value.endsWith('.'))
        return false;

    const labels = value.split('.');
    return labels.every(label =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
