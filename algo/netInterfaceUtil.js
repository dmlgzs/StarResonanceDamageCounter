'use strict';
const { exec } = require('child_process');
const cap = require('cap');

// Filter virtual adapters
const VIRTUAL_KEYWORDS = ['zerotier', 'vmware', 'hyper-v', 'virtual', 'loopback', 'tap', 'bluetooth', 'wan miniport'];

function isVirtual(name) {
    const lower = name.toLowerCase();
    return VIRTUAL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

// Detect TCP traffic for 3 seconds
function detectTraffic(deviceIndex, devices) {
    return new Promise((resolve) => {
        let count = 0;
        try {
            const c = new cap.Cap();
            const buffer = Buffer.alloc(65535);

            const cleanup = () => {
                try {
                    c.close();
                } catch (e) {}
            };

            setTimeout(() => {
                cleanup();
                resolve(count);
            }, 3000);

            if (c.open(devices[deviceIndex].name, 'ip and tcp', 1024 * 1024, buffer) === 'ETHERNET') {
                c.setMinBytes && c.setMinBytes(0);
                c.on('packet', () => count++);
            } else {
                cleanup();
                resolve(0);
            }
        } catch (e) {
            resolve(0);
        }
    });
}

async function findByRoute(devices) {
    try {
        const stdout = await new Promise((resolve, reject) => {
            exec('route print 0.0.0.0', (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            });
        });

        const defaultInterface = stdout
            .split('\n')
            .find((line) => line.trim().startsWith('0.0.0.0'))
            ?.trim()
            .split(/\s+/)[3];

        if (!defaultInterface) return undefined;

        const targetInterface = Object.entries(devices).find(([, device]) =>
            device.addresses.find((address) => address.addr === defaultInterface),
        )?.[0];

        return parseInt(targetInterface);
    } catch (error) {
        return undefined;
    }
}

async function findDefaultNetworkDevice(devices) {
    try {
        // Get physical adapters
        const physical = Object.entries(devices).filter(([, device]) => {
            const name = device.description || device.name || '';
            return !isVirtual(name) && device.addresses && device.addresses.length > 0;
        });

        if (physical.length === 0) {
            return await findByRoute(devices);
        }

        // Detect traffic on physical adapters
        console.log('Detecting network traffic... (3s)');
        const results = await Promise.all(
            physical.map(async ([index]) => ({
                index: parseInt(index),
                packets: await detectTraffic(parseInt(index), devices),
            })),
        );

        // Select adapter with most traffic
        const best = results.filter((r) => r.packets > 0).sort((a, b) => b.packets - a.packets)[0];

        if (best) {
            console.log(`Using adapter with most traffic: ${best.index} - ${devices[best.index].description} (${best.packets} packets)`);
            return best.index;
        }

        // Fallback to route table
        const routeIndex = await findByRoute(devices);
        if (routeIndex !== undefined && devices[routeIndex] && isVirtual(devices[routeIndex].description || '')) {
            console.log('Route table selected virtual adapter, using first physical adapter instead');
            return parseInt(physical[0][0]);
        }

        return routeIndex;
    } catch (error) {
        return undefined;
    }
}

module.exports = findDefaultNetworkDevice;
