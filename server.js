const cap = require('cap');
const readline = require('readline');
const winston = require("winston");
const zlib = require('zlib');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const pb = require('./algo/pb');
const Readable = require("stream").Readable;
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const print = console.log;
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const devices = cap.deviceList();

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer);
        });
    });
}

class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    async acquire() {
        if (this.locked) {
            return new Promise((resolve) => this.queue.push(resolve));
        }
        this.locked = true;
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

let total_damage = {};
let total_count = {};
let dps_window = {};
let damage_time = {};
let realtime_dps = {};

// 统计状态控制
let isStatsEnabled = true;

// WebSocket连接管理
let connectedClients = new Set();

// 数据更新标志，用于批量推送
let dataChanged = false;
let lastPushTime = 0;
const PUSH_THROTTLE_MS = 100; // 限制推送频率为100ms

async function main() {
    print('Welcome to use Damage Counter for Star Resonance by Dimole!');
    print('Version: V2.1');
    for (let i = 0; i < devices.length; i++) {
        print(i + '.\t' + devices[i].description);
    }
    const num = await ask('Please enter the number of the device used for packet capture: ');
    if (!devices[num]) {
        print('Cannot find device ' + num + '!');
        process.exit(1);
    }
    const log_level = await ask('Please enter log level (info|debug): ') || 'info';
    if (!log_level || !['info', 'debug'].includes(log_level)) {
        print('Invalid log level!');
        process.exit(1);
    }
    rl.close();
    const logger = winston.createLogger({
        level: log_level,
        format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(info => {
                return `[${info.timestamp}] [${info.level}] ${info.message}`;
            })
        ),
        transports: [
            new winston.transports.Console()
        ]
    });

    // 数据处理函数
    function generateUserData() {
        const user = {};
        for (const uid of Object.keys(total_damage)) {
            if (!user[uid]) user[uid] = {
                realtime_dps: 0,
                realtime_dps_max: 0,
                total_dps: 0,
                total_damage: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    crit_lucky: 0,
                    hpLessen: 0,
                    total: 0,
                },
                total_count: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                },
            };
            user[uid].total_damage = total_damage[uid];
            user[uid].total_count = total_count[uid];
            user[uid].total_dps = ((total_damage[uid].total) / (damage_time[uid][1] - damage_time[uid][0]) * 1000) || 0;
            user[uid].realtime_dps = realtime_dps[uid] ? realtime_dps[uid].value : 0;
            user[uid].realtime_dps_max = realtime_dps[uid] ? realtime_dps[uid].max : 0;
        }
        return user;
    }

    // 推送数据到所有连接的客户端
    function pushDataToClients() {
        if (connectedClients.size > 0) {
            const userData = generateUserData();
            io.emit('dataUpdate', {
                code: 0,
                user: userData,
                timestamp: Date.now()
            });
        }
    }

    //瞬时DPS计算和数据推送
    setInterval(() => {
        const now = Date.now();
        let hasRealtimeUpdate = false;

        for (const uid of Object.keys(dps_window)) {
            while (dps_window[uid].length > 0 && now - dps_window[uid][0].time > 1000) {
                dps_window[uid].shift();
            }
            if (!realtime_dps[uid]) {
                realtime_dps[uid] = {
                    value: 0,
                    max: 0,
                }
            }
            const oldValue = realtime_dps[uid].value;
            realtime_dps[uid].value = 0;
            for (const b of dps_window[uid]) {
                realtime_dps[uid].value += b.damage;
            }
            if (realtime_dps[uid].value > realtime_dps[uid].max) {
                realtime_dps[uid].max = realtime_dps[uid].value;
            }

            // 检查是否有实时数据变化
            if (oldValue !== realtime_dps[uid].value) {
                hasRealtimeUpdate = true;
            }
        }

        // 如果有数据变化或实时DPS更新，推送数据
        if ((dataChanged || hasRealtimeUpdate) && now - lastPushTime >= PUSH_THROTTLE_MS) {
            pushDataToClients();
            dataChanged = false;
            lastPushTime = now;
        }
    }, 50);

    //express
    app.use(express.static('public'));

    // 保留原先API，优先使用WebSocket
    app.get('/api/data', (req, res) => {
        const userData = generateUserData();
        const data = {
            code: 0,
            user: userData,
            timestamp: Date.now()
        };
        res.json(data);
    });
    app.get('/api/clear', (req, res) => {
        total_damage = {};
        total_count = {};
        dps_window = {};
        damage_time = {};
        realtime_dps = {};
        logger.info('Statistics have been cleared!');

        // 通知所有WebSocket客户端数据已清空
        io.emit('dataCleared', {
            code: 0,
            msg: 'Statistics have been cleared!',
            timestamp: Date.now()
        });

        res.json({
            code: 0,
            msg: 'Statistics have been cleared!',
        });
    });

    // 统计控制API
    app.post('/api/stats/start', (req, res) => {
        isStatsEnabled = true;
        logger.info('Statistics started!');

        // 通知所有WebSocket客户端统计已开始
        io.emit('statsStarted', {
            code: 0,
            msg: 'Statistics started!',
            timestamp: Date.now()
        });

        res.json({
            code: 0,
            msg: 'Statistics started!',
        });
    });

    app.post('/api/stats/pause', (req, res) => {
        isStatsEnabled = false;
        logger.info('Statistics paused!');

        // 通知所有WebSocket客户端统计已暂停
        io.emit('statsPaused', {
            code: 0,
            msg: 'Statistics paused!',
            timestamp: Date.now()
        });

        res.json({
            code: 0,
            msg: 'Statistics paused!',
        });
    });

    // WebSocket连接处理
    io.on('connection', (socket) => {
        logger.info(`WebSocket client connected: ${socket.id}`);
        connectedClients.add(socket.id);

        // 发送当前数据给新连接的客户端
        const userData = generateUserData();
        socket.emit('dataUpdate', {
            code: 0,
            user: userData,
            timestamp: Date.now()
        });

        // 处理客户端请求清空数据
        socket.on('clearData', () => {
            try {
                total_damage = {};
                total_count = {};
                dps_window = {};
                damage_time = {};
                realtime_dps = {};
                logger.info('Statistics cleared via WebSocket');

                io.emit('dataCleared', {
                    code: 0,
                    msg: 'Statistics have been cleared!',
                    timestamp: Date.now()
                });
            } catch (error) {
                logger.error('Error clearing data via WebSocket:', error);
                socket.emit('error', {
                    code: 1,
                    msg: 'Failed to clear data',
                    error: error.message
                });
            }
        });

        // 处理统计控制
        socket.on('startStats', () => {
            try {
                isStatsEnabled = true;
                logger.info('Statistics started via WebSocket');

                io.emit('statsStarted', {
                    code: 0,
                    msg: 'Statistics started!',
                    timestamp: Date.now()
                });
            } catch (error) {
                logger.error('Error starting stats via WebSocket:', error);
                socket.emit('error', {
                    code: 1,
                    msg: 'Failed to start statistics',
                    error: error.message
                });
            }
        });

        socket.on('pauseStats', () => {
            try {
                isStatsEnabled = false;
                logger.info('Statistics paused via WebSocket');

                io.emit('statsPaused', {
                    code: 0,
                    msg: 'Statistics paused!',
                    timestamp: Date.now()
                });
            } catch (error) {
                logger.error('Error pausing stats via WebSocket:', error);
                socket.emit('error', {
                    code: 1,
                    msg: 'Failed to pause statistics',
                    error: error.message
                });
            }
        });

        // 处理心跳检测
        socket.on('ping', () => {
            socket.emit('pong', { timestamp: Date.now() });
        });

        // 处理断开连接
        socket.on('disconnect', (reason) => {
            logger.info(`WebSocket client disconnected: ${socket.id}, reason: ${reason}`);
            connectedClients.delete(socket.id);
        });

        // 处理连接错误
        socket.on('error', (error) => {
            logger.error(`WebSocket error for client ${socket.id}:`, error);
            connectedClients.delete(socket.id);
        });
    });

    // WebSocket健康状态检查
    setInterval(() => {
        const connectedCount = connectedClients.size;
        if (connectedCount > 0) {
            logger.debug(`Active WebSocket connections: ${connectedCount}`);
        }

        // 清理无效连接
        const validClients = new Set();
        for (const clientId of connectedClients) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket && clientSocket.connected) {
                validClients.add(clientId);
            }
        }
        connectedClients = validClients;
    }, 30000); // 每30秒检查一次

    server.listen(8989, () => {
        logger.info('Web Server started at http://localhost:8989');
        logger.info('WebSocket server is running on the same port');
    });

    logger.info('Welcome!');
    logger.info('Attempting to find the game server, please wait!');

    let user_uid;
    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = {};
    let tcp_cache_size = 0;
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const processPacket = (buf) => {
        try {
            if (buf.length < 32) return;
            if (buf[4] & 0x80) {//zstd
                if (!zlib.zstdDecompressSync) logger.warn('zstdDecompressSync is not available! Please check your Node.js version!');
                const decompressed = zlib.zstdDecompressSync(buf.subarray(10));
                buf = Buffer.concat([buf.subarray(0, 10), decompressed]);
            }
            const data = buf.subarray(10);
            if (data.length) {
                const stream = Readable.from(data, { objectMode: false });
                let data1;
                do {
                    const len_buf = stream.read(4);
                    if (!len_buf) break;
                    data1 = stream.read(len_buf.readUInt32BE() - 4);
                    try {
                        let body = pb.decode(data1.subarray(18)) || {};
                        if (data1[17] === 0x2e) {
                            body = body[1];
                            if (body[5]) { //玩家uid
                                const uid = BigInt(body[5]) >> 16n;
                                if (user_uid !== uid) {
                                    user_uid = uid;
                                    logger.info('Got player UID! UID: ' + user_uid);
                                }
                            }
                        }
                        let body1 = body[1];
                        if (body1) {
                            if (!Array.isArray(body1)) body1 = [body1];
                            for (const b of body1) {
                                if (b[7] && b[7][2]) {
                                    logger.debug(b.toBase64());
                                    const hits = Array.isArray(b[7][2]) ? b[7][2] : [b[7][2]];
                                    for (const hit of hits) {
                                        const skill = hit[12];
                                        if (typeof skill !== 'number') break; //可以用来区分伤害和治疗啥的，但我不想去导出它的表
                                        const value = hit[6], luckyValue = hit[8], isCrit = hit[5], hpLessenValue = hit[9] ?? 0;
                                        const damage = value ?? luckyValue;
                                        const is_player = (BigInt(hit[21] || hit[11]) & 0xffffn) === 640n;
                                        if (!is_player) break; //排除怪物攻击
                                        const operator_uid = BigInt(hit[21] || hit[11]) >> 16n;
                                        if (!operator_uid) break;

                                        // 检查统计状态，如果暂停则跳过数据记录
                                        if (!isStatsEnabled) {
                                            logger.debug('Statistics paused, skipping damage record for UID: ' + operator_uid);
                                            break;
                                        }

                                        //初始化
                                        if (!total_damage[operator_uid]) total_damage[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            crit_lucky: 0,
                                            hpLessen: 0,
                                            total: 0,
                                        };
                                        if (!total_count[operator_uid]) total_count[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            total: 0,
                                        };

                                        if (isCrit) {
                                            total_count[operator_uid].critical++;
                                            if (luckyValue) {
                                                total_damage[operator_uid].crit_lucky += damage;
                                                total_count[operator_uid].lucky++;
                                            } else {
                                                total_damage[operator_uid].critical += damage;
                                            }
                                        } else if (luckyValue) {
                                            total_damage[operator_uid].lucky += damage;
                                            total_count[operator_uid].lucky++;
                                        } else {
                                            total_damage[operator_uid].normal += damage;
                                            total_count[operator_uid].normal++;
                                        }
                                        total_damage[operator_uid].total += damage;
                                        total_damage[operator_uid].hpLessen += hpLessenValue;
                                        total_count[operator_uid].total++;
                                        if (!dps_window[operator_uid]) dps_window[operator_uid] = [];
                                        dps_window[operator_uid].push({
                                            time: Date.now(),
                                            damage,
                                        });
                                        if (!damage_time[operator_uid]) damage_time[operator_uid] = [];
                                        if (damage_time[operator_uid][0]) {
                                            damage_time[operator_uid][1] = Date.now();
                                        } else {
                                            damage_time[operator_uid][0] = Date.now();
                                        }

                                        // 标记数据已更新，用于WebSocket推送
                                        dataChanged = true;
                                        let extra = [];
                                        if (isCrit) extra.push('Crit');
                                        if (luckyValue) extra.push('Lucky');
                                        if (extra.length === 0) extra = ['Normal'];

                                        logger.info('User: ' + operator_uid + ' Skill: ' + skill + ' Damage/Healing: ' + damage +
                                                    ' HpLessen: ' + hpLessenValue +
                                                    ' Extra: ' + extra.join('|')
                                            );
                                    }
                                } else {
                                    //logger.debug(data1.toString('hex'));
                                }
                            }
                        } else {
                            //logger.debug(data1.toString('hex'));
                        }
                    } catch (e) {
                        logger.debug(e);
                        logger.debug(data1.subarray(18).toString('hex'));
                    }
                } while (data1 && data1.length)
            }
        } catch (e) {
            logger.debug(e);
        }
    }
    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache = {};
        tcp_cache_size = 0;
    }

    //抓包相关
    const c = new Cap();
    const device = devices[num].name;
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);
    const linkType = c.open(device, filter, bufSize, buffer);
    c.setMinBytes && c.setMinBytes(0);
    c.on('packet', async function (_nbytes, _trunc) {
        const buffer1 = Buffer.from(buffer);
        if (linkType === 'ETHERNET') {
            var ret = decoders.Ethernet(buffer1);
            if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
                ret = decoders.IPV4(buffer1, ret.offset);
                //logger.debug('from: ' + ret.info.srcaddr + ' to ' + ret.info.dstaddr);
                const srcaddr = ret.info.srcaddr;
                const dstaddr = ret.info.dstaddr;

                if (ret.info.protocol === PROTOCOL.IP.TCP) {
                    var datalen = ret.info.totallen - ret.hdrlen;

                    ret = decoders.TCP(buffer1, ret.offset);
                    //logger.debug(' from port: ' + ret.info.srcport + ' to port: ' + ret.info.dstport);
                    const srcport = ret.info.srcport;
                    const dstport = ret.info.dstport;
                    const src_server = srcaddr + ':' + srcport + ' -> ' + dstaddr + ':' + dstport;
                    datalen -= ret.hdrlen;
                    let buf = Buffer.from(buffer1.subarray(ret.offset, ret.offset + datalen));

                    if (tcp_last_time && Date.now() - tcp_last_time > 30000) {
                        logger.warn('Cannot capture the next packet! Is the game closed or disconnected? seq: ' + tcp_next_seq);
                        current_server = '';
                        clearTcpCache();
                    }

                    if (current_server !== src_server) {
                        try {
                            //尝试通过小包识别服务器
                            if (buf[4] === 0) {
                                const data = buf.subarray(10);
                                if (data.length) {
                                    const stream = Readable.from(data, { objectMode: false });
                                    let data1;
                                    do {
                                        const len_buf = stream.read(4);
                                        if (!len_buf) break;
                                        data1 = stream.read(len_buf.readUInt32BE() - 4);
                                        const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); //c3SB??
                                        if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                                        try {
                                            let body = pb.decode(data1.subarray(18)) || {};
                                            if (current_server !== src_server) {
                                                current_server = src_server;
                                                clearTcpCache();
                                                logger.info('Got Scene Server Address: ' + src_server);
                                            }
                                            if (data1[17] === 0x2e) {
                                                body = body[1];
                                                if (body[5]) { //玩家uid
                                                    if (!user_uid) {
                                                        user_uid = BigInt(body[5]) >> 16n;
                                                        logger.info('Got player UID! UID: ' + user_uid);
                                                    }
                                                }
                                            }
                                        } catch (e) { }
                                    } while (data1 && data1.length)
                                }
                            }
                        } catch (e) { }
                        return;
                    }
                    //这里已经是识别到的服务器的包了
                    await tcp_lock.acquire();
                    if (tcp_next_seq === -1 && buf.length > 4 && buf.readUInt32BE() < 999999) { //第一次抓包可能抓到后半段的，先丢了
                        tcp_next_seq = ret.info.seqno;
                    }
                    logger.debug('TCP next seq: ' + tcp_next_seq);
                    tcp_cache[ret.info.seqno] = buf;
                    tcp_cache_size++;
                    while (tcp_cache[tcp_next_seq]) {
                        const seq = tcp_next_seq;
                        _data = _data.length === 0 ? tcp_cache[seq] : Buffer.concat([_data, tcp_cache[seq]]);
                        tcp_next_seq = (seq + tcp_cache[seq].length) >>> 0; //uint32
                        tcp_cache[seq] = undefined;
                        tcp_cache_size--;
                        tcp_last_time = Date.now();
                        setTimeout(() => {
                            if (tcp_cache[seq]) {
                                tcp_cache[seq] = undefined;
                                tcp_cache_size--;
                            }
                        }, 10000);
                    }
                    /*
                    if (tcp_cache_size > 30) {
                        logger.warn('Too much unused tcp cache! Is the game reconnected? seq: ' + tcp_next_seq + ' size:' + tcp_cache_size);
                        clearTcpCache();
                    }
                    */
                    while (_data.length > 4) {
                        let len = _data.readUInt32BE();
                        if (_data.length >= len) {
                            const packet = _data.subarray(0, len);
                            _data = _data.subarray(len);
                            processPacket(packet);
                        } else {
                            if (len > 999999) {
                                logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                                process.exit(1)
                            }
                            break;
                        }
                    }
                    tcp_lock.release();
                } else
                    logger.error('Unsupported IPv4 protocol: ' + PROTOCOL.IP[ret.info.protocol]);
            } else
                logger.error('Unsupported Ethertype: ' + PROTOCOL.ETHERNET[ret.info.type]);
        }
    })
}

main();