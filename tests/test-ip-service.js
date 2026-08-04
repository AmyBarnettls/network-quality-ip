import {IpService} from '../ipService.js';
import {Purity} from '../core.js';
import System from 'system';

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

async function main() {
    const responses = [];
    const requestedUrls = [];
    const request = async url => {
        requestedUrls.push(url);
        if (responses.length === 0)
            throw new Error(`Unexpected request: ${url}`);
        const response = responses.shift();
        if (response instanceof Error)
            throw response;
        return response;
    };

    const updates = [];
    const service = new IpService(state => updates.push(state), request);

    responses.push(
        {ip: '1.2.3.4'},
        {
            ip: '1.2.3.4',
            is_abuser: false,
            is_tor: false,
            is_proxy: false,
            is_vpn: false,
            is_datacenter: false,
            location: {country_code: 'MN'},
        }
    );
    await service.start();
    let state = service.getState();
    assertEqual(state.ip, '1.2.3.4', 'initial IPv4');
    assertEqual(state.purity, Purity.CLEAN, 'initial purity');
    assert(state.lastIntelUpdate !== null, 'initial update timestamp');
    assertEqual(requestedUrls.length, 2,
        'initial address and intelligence requests');

    responses.push({ip: '1.2.3.4'});
    await service.checkNow(false);
    assertEqual(requestedUrls.length, 3, 'same IP skips intelligence request');

    responses.push(
        {ip: '5.6.7.8'},
        {
            ip: '5.6.7.8',
            is_abuser: true,
            location: {country_code: 'US'},
        }
    );
    await service.checkNow(false);
    state = service.getState();
    assertEqual(state.ip, '5.6.7.8', 'changed IPv4');
    assertEqual(state.purity, Purity.RISK, 'changed IP reputation');

    responses.push({ip: '5.6.7.8'},
        new Error('temporary intelligence failure'));
    await service.checkNow(true);
    state = service.getState();
    assertEqual(state.purity, Purity.RISK, 'same IP keeps old reputation');
    assert(state.stale, 'same IP failure is stale');
    assert(state.intelligence !== null, 'same IP retains intelligence');

    responses.push({ip: '2001:db8::1'});
    await service.checkNow(false);
    state = service.getState();
    assertEqual(state.ip, '5.6.7.8', 'invalid IPv6 does not replace IPv4');
    assert(state.stale, 'invalid response marks retained data stale');

    responses.push(
        {ip: '9.10.11.12'},
        new Error('new IP intelligence failure')
    );
    await service.checkNow(false);
    state = service.getState();
    assertEqual(state.ip, '9.10.11.12',
        'new IP is retained when intelligence fails');
    assertEqual(state.purity, Purity.UNKNOWN,
        'failed new IP reputation is unknown');
    assertEqual(state.intelligence, null, 'old-IP intelligence is cleared');
    assert(state.stale, 'failed new IP intelligence is stale');
    assert(updates.length > 0, 'updates were emitted');

    service.stop();
    console.log(`test-ip-service: ${assertions} assertions passed`);
}

main().catch(error => {
    console.error(error);
    System.exit(1);
});
