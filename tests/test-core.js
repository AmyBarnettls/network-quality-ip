import {
    classifyPurity,
    getSampleVisual,
    isValidIpv4,
    isValidPingTarget,
    parsePingLine,
    Purity,
    SampleStatus,
    SampleWindow,
} from '../core.js';

let assertions = 0;

function assert(condition, message) {
    assertions++;
    if (!condition)
        throw new Error(message);
}

function assertEqual(actual, expected, message) {
    assert(Object.is(actual, expected),
        `${message}: expected ${expected}, got ${actual}`);
}

function assertClose(actual, expected, tolerance, message) {
    assert(Math.abs(actual - expected) <= tolerance,
        `${message}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

const success = parsePingLine(
    '64 bytes from 1.1.1.1: icmp_seq=17 ttl=57 time=12.45 ms');
assertEqual(success.sequence, 17, 'success sequence');
assertEqual(success.status, SampleStatus.SUCCESS, 'success status');
assertClose(success.latencyMs, 12.45, 0.001, 'success latency');

const subMillisecond = parsePingLine(
    '64 bytes from 1.1.1.1: icmp_seq=18 ttl=57 time<1 ms');
assertEqual(subMillisecond.latencyMs, 1, 'sub-millisecond parser');

const timeout = parsePingLine('no answer yet for icmp_seq=19');
assertEqual(timeout.sequence, 19, 'timeout sequence');
assertEqual(timeout.status, SampleStatus.TIMEOUT, 'timeout status');
assertEqual(parsePingLine('PING 1.1.1.1 (1.1.1.1)'), null, 'ignore header');

const window = new SampleWindow(4);
window.record({sequence: 1, status: SampleStatus.SUCCESS, latencyMs: 10});
window.record({sequence: 2, status: SampleStatus.SUCCESS, latencyMs: 20});
window.record({sequence: 3, status: SampleStatus.TIMEOUT, latencyMs: null});
window.record({sequence: 4, status: SampleStatus.SUCCESS, latencyMs: 50});

let stats = window.getStats();
assertEqual(stats.totalCount, 4, 'sample total');
assertEqual(stats.validCount, 3, 'valid total');
assertClose(stats.lossPercent, 25, 0.001, 'loss percent');
assertClose(stats.medianLatencyMs, 20, 0.001, 'median');
assertClose(stats.p95LatencyMs, 50, 0.001, 'p95');
assertClose(stats.jitterMs, 10, 0.001, 'jitter ignores a loss gap');
assertClose(stats.currentLatencyMs, 50, 0.001, 'current latency');

window.record({sequence: 3, status: SampleStatus.SUCCESS, latencyMs: 30});
stats = window.getStats();
assertClose(stats.lossPercent, 0, 0.001, 'late reply repairs timeout');
assertClose(stats.jitterMs, 13.333, 0.001, 'jitter after late reply');

window.record({sequence: 3, status: SampleStatus.TIMEOUT, latencyMs: null});
assertEqual(window.getSamples()[2].status, SampleStatus.SUCCESS,
    'timeout cannot replace a success');

window.record({sequence: 6, status: SampleStatus.SUCCESS, latencyMs: 60});
const samplesAfterGap = window.getSamples();
assertEqual(samplesAfterGap.length, 4, 'window remains bounded');
assertEqual(samplesAfterGap[0].sequence, 3, 'oldest sample was pruned');
assertEqual(samplesAfterGap[2].status, SampleStatus.TIMEOUT,
    'missing sequence becomes timeout');

assertEqual(getSampleVisual(
    {status: SampleStatus.SUCCESS, latencyMs: 50}, 80, 150).color,
'good', 'green visual');
assertEqual(getSampleVisual(
    {status: SampleStatus.SUCCESS, latencyMs: 100}, 80, 150).color,
'warning', 'amber visual');
assertEqual(getSampleVisual(
    {status: SampleStatus.SUCCESS, latencyMs: 200}, 80, 150).color,
'bad', 'red visual');
assertEqual(getSampleVisual(
    {status: SampleStatus.TIMEOUT, latencyMs: null}, 80, 150).color,
'timeout', 'timeout visual');
assertClose(getSampleVisual(
    {status: SampleStatus.SUCCESS, latencyMs: 300}, 80, 150).heightRatio,
1, 0.001, 'height caps at 300ms');

assertEqual(classifyPurity(null), Purity.UNKNOWN, 'unknown purity');
assertEqual(classifyPurity({is_bogon: true}), Purity.UNKNOWN, 'bogon purity');
assertEqual(classifyPurity({is_abuser: true}), Purity.RISK, 'abuser risk');
assertEqual(classifyPurity({is_tor: true, is_vpn: true}), Purity.RISK,
    'risk takes precedence');
assertEqual(classifyPurity({is_vpn: true}), Purity.ATTENTION, 'VPN attention');
assertEqual(classifyPurity({is_datacenter: true}), Purity.ATTENTION,
    'datacenter attention');
assertEqual(classifyPurity({}), Purity.CLEAN, 'clean purity');

assert(isValidIpv4('1.1.1.1'), 'valid IPv4');
assert(!isValidIpv4('01.1.1.1'), 'reject leading zero');
assert(!isValidIpv4('256.1.1.1'), 'reject large octet');
assert(isValidPingTarget('example.com'), 'valid hostname');
assert(isValidPingTarget('router-1.local'), 'valid local hostname');
assert(!isValidPingTarget('-c'), 'reject option-like target');
assert(!isValidPingTarget('bad target'), 'reject whitespace');

console.log(`test-core: ${assertions} assertions passed`);
