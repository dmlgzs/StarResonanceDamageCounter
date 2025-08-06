const cap = require('cap');
const readline = require('readline');
const winston = require("winston");
const zlib = require('zlib');
const express = require('express');
const cors = require('cors');
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

/** 统计数据类 - 用于统计伤害或治疗数据 */
class StatisticData {
    constructor() {
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0, // 仅用于伤害统计
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = []; // 实时统计窗口
        this.timeRange = []; // 时间范围 [开始时间, 最后时间]
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }

    /** 添加记录
     * @param {number} value - 数值（伤害或治疗）
     * @param {boolean} isCrit - 是否暴击
     * @param {boolean} isLucky - 是否幸运
     * @param {number} hpLessenValue - HP减少值（仅用于伤害）
     */
    addRecord(value, isCrit, isLucky, hpLessenValue = 0) {
        const now = Date.now();

        // 更新数值统计
        if (isCrit) {
            if (isLucky) {
                this.stats.crit_lucky += value;
            } else {
                this.stats.critical += value;
            }
        } else if (isLucky) {
            this.stats.lucky += value;
        } else {
            this.stats.normal += value;
        }
        this.stats.total += value;
        this.stats.hpLessen += hpLessenValue;

        // 更新次数统计
        if (isCrit) {
            this.count.critical++;
        }
        if (isLucky) {
            this.count.lucky++;
        }
        if (!isCrit && !isLucky) {
            this.count.normal++;
        }
        this.count.total++;
        this.realtimeWindow.push({
            time: now,
            value,
        });

        // 更新时间范围
        if (this.timeRange.length === 0) {
            this.timeRange = [now, now];
        } else {
            this.timeRange[1] = now;
        }
    }

    /** 更新实时统计（过去1秒内的数据） */
    updateRealtimeStats() {
        const now = Date.now();
        const cutoff = now - 1000; // 1秒前

        // 清理过期数据
        this.realtimeWindow = this.realtimeWindow.filter(entry => entry.time > cutoff);

        // 计算实时值
        const oldValue = this.realtimeStats.value;
        this.realtimeStats.value = this.realtimeWindow.reduce((sum, entry) => sum + entry.value, 0);

        // 更新最大值
        if (this.realtimeStats.value > this.realtimeStats.max) {
            this.realtimeStats.max = this.realtimeStats.value;
        }

        return oldValue !== this.realtimeStats.value;
    }

    /** 获取总的每秒平均值 */
    getTotalPerSecond() {
        if (this.timeRange.length < 2 || this.timeRange[1] <= this.timeRange[0]) {
            return 0;
        }
        const duration = this.timeRange[1] - this.timeRange[0];
        return (this.stats.total / duration) * 1000;
    }

    /** 重置所有数据 */
    reset() {
        this.stats = {
            normal: 0,
            critical: 0,
            lucky: 0,
            crit_lucky: 0,
            hpLessen: 0,
            total: 0,
        };
        this.count = {
            normal: 0,
            critical: 0,
            lucky: 0,
            total: 0,
        };
        this.realtimeWindow = [];
        this.timeRange = [];
        this.realtimeStats = {
            value: 0,
            max: 0,
        };
    }
}

/** 用户数据类 */
class UserData {
    constructor(uid) {
        this.uid = uid;
        this.damageStats = new StatisticData();
        this.healingStats = new StatisticData();
        this.takenDamage = 0; // 承伤
        this.profession = '未知';
    }

    /** 添加伤害记录
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否暴击
     * @param {boolean} isLucky - 是否幸运
     * @param {number} hpLessenValue - HP减少值
     */
    addDamage(damage, isCrit, isLucky, hpLessenValue = 0) {
        this.damageStats.addRecord(damage, isCrit, isLucky, hpLessenValue);
    }

    /** 添加治疗记录
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否暴击
     * @param {boolean} isLucky - 是否幸运
     */
    addHealing(healing, isCrit, isLucky) {
        this.healingStats.addRecord(healing, isCrit, isLucky);
    }

    /** 添加承伤记录
     * @param {number} damage - 承受的伤害
     */
    addTakenDamage(damage) {
        this.takenDamage += damage;
    }

    /** 设置职业 */
    setProfession(profession) {
        this.profession = profession;
    }

    /** 更新实时DPS和HPS 计算过去1秒内的总伤害和治疗 */
    updateRealtimeDps() {
        this.damageStats.updateRealtimeStats();
        this.healingStats.updateRealtimeStats();
    }

    /** 获取总DPS */
    getTotalDps() {
        return this.damageStats.getTotalPerSecond();
    }

    /** 获取总HPS */
    getTotalHps() {
        return this.healingStats.getTotalPerSecond();
    }

    /** 获取合并的次数统计 */
    getTotalCount() {
        return {
            normal: this.damageStats.count.normal + this.healingStats.count.normal,
            critical: this.damageStats.count.critical + this.healingStats.count.critical,
            lucky: this.damageStats.count.lucky + this.healingStats.count.lucky,
            total: this.damageStats.count.total + this.healingStats.count.total,
        };
    }
    /** 获取用户数据摘要 */
    getSummary() {
        return {
            realtime_dps: this.damageStats.realtimeStats.value,
            realtime_dps_max: this.damageStats.realtimeStats.max,
            total_dps: this.getTotalDps(),
            total_damage: { ...this.damageStats.stats },
            total_count: this.getTotalCount(),
            realtime_hps: this.healingStats.realtimeStats.value,
            realtime_hps_max: this.healingStats.realtimeStats.max,
            total_hps: this.getTotalHps(),
            total_healing: { ...this.healingStats.stats },
            taken_damage: this.takenDamage,
            profession: this.profession,
        };
    }

    /** 重置用户数据 */
    reset() {
        this.damageStats.reset();
        this.healingStats.reset();
        this.takenDamage = 0;
        this.profession = '未知';
    }
}

// 用户数据管理器类
class UserDataManager {
    constructor() {
        this.users = new Map(); // 使用Map存储UserData实例
    }

    // 获取或创建用户数据
    getOrCreateUser(uid) {
        if (!this.users.has(uid)) {
            this.users.set(uid, new UserData(uid));
        }
        return this.users.get(uid);
    }

    // 添加伤害数据
    addDamage(uid, damage, isCrit, isLucky, hpLessen = 0) {
        if (!isStatsEnabled) return;
        
        const user = this.getOrCreateUser(uid);
        user.addDamage(damage, isCrit, isLucky, hpLessen);
        dataChanged = true;
    }

    // 添加治疗数据
    addHealing(uid, healing, isCrit, isLucky) {
        if (!isStatsEnabled) return;
        
        const user = this.getOrCreateUser(uid);
        user.addHealing(healing, isCrit, isLucky);
        dataChanged = true;
    }

    // 添加承受伤害数据
    addTakenDamage(uid, damage) {
        if (!isStatsEnabled) return;
        
        const user = this.getOrCreateUser(uid);
        user.addTakenDamage(damage);
        dataChanged = true;
    }

    // 设置用户职业
    setProfession(uid, profession) {
        const user = this.getOrCreateUser(uid);
        user.setProfession(profession);
    }

    // 更新所有用户的实时DPS/HPS
    updateAllRealtimeDps() {
        let hasUpdate = false;

        for (const [uid, user] of this.users) {
            const oldDps = user.damageStats.realtimeStats.value;
            const oldHps = user.healingStats.realtimeStats.value;
            
            user.updateRealtimeDps();
            
            if (oldDps !== user.damageStats.realtimeStats.value || 
                oldHps !== user.healingStats.realtimeStats.value) {
                hasUpdate = true;
            }
        }

        return hasUpdate;
    }

    // 获取所有用户数据
    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    // 清空所有数据
    clearAll() {
        this.users.clear();
        dataChanged = true;
    }
}

const userDataManager = new UserDataManager();

async function main() {
    print('Welcome to use Damage Counter for Star Resonance!');
    print('Version: V2.2');
    print('GitHub: https://github.com/dmlgzs/StarResonanceDamageCounter');
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

    // 推送数据到所有连接的客户端
    function pushDataToClients() {
        if (connectedClients.size > 0) {
            const userData = userDataManager.getAllUsersData();
            io.emit('dataUpdate', {
                code: 0,
                user: userData,
                timestamp: Date.now()
            });
        }
    }

    //瞬时DPS/HPS更新
    setInterval(() => {
        const hasUpdate = userDataManager.updateAllRealtimeDps();
        const now = Date.now();

        // 如果有数据变化或实时更新，推送数据
        if ((dataChanged || hasUpdate) && now - lastPushTime >= PUSH_THROTTLE_MS) {
            pushDataToClients();
            dataChanged = false;
            lastPushTime = now;
        }
    }, 100);

    //express
    app.use(cors());
    app.use(express.static('public'));

    // 保留原先API，优先使用WebSocket
    app.get('/api/data', (req, res) => {
        const userData = userDataManager.getAllUsersData();
        const data = {
            code: 0,
            user: userData,
            timestamp: Date.now()
        };
        res.json(data);
    });
    app.get('/api/clear', (req, res) => {
        // 清空新的数据管理器
        userDataManager.clearAll();
        
        // 同时清空旧的数据结构以保持兼容性
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
        const userData = userDataManager.getAllUsersData();
        socket.emit('dataUpdate', {
            code: 0,
            user: userData,
            timestamp: Date.now()
        });

        // 处理客户端请求清空数据
        socket.on('clearData', () => {
            try {
                // 清空新的数据管理器
                userDataManager.clearAll();
                
                // 同时清空旧的数据结构以保持兼容性
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
                                        if (typeof skill !== 'number') continue;
                                        const value = hit[6], luckyValue = hit[8], isMiss = !!hit[2], isCrit = !!hit[5], hpLessenValue = hit[9] ?? 0;
                                        const isHeal = hit[4] === 2, isDead = !!hit[17], isLucky = !!luckyValue;
                                        const operatorUUID = hit[11], targetUUID = b[1];
                                        const damage = value ?? luckyValue ?? 0;
                                        if (typeof damage !== 'number') continue;
                                        const operator_is_player = (BigInt(operatorUUID) & 0xffffn) === 640n;
                                        const target_is_player = (BigInt(targetUUID) & 0xffffn) === 640n;
                                        const operator_uid = Number(BigInt(operatorUUID) >> 16n);
                                        const target_uid = Number(BigInt(targetUUID) >> 16n);
                                        if (!operator_uid) continue;

                                        // 检查统计状态，如果暂停则跳过数据记录
                                        if (!isStatsEnabled) {
                                            logger.debug('Statistics paused, skipping damage record for UID: ' + operator_uid);
                                            continue;
                                        }

                                        let srcTargetStr = operator_is_player ? ('Src: ' + operator_uid) : ('SrcUUID: ' + operatorUUID);
                                        srcTargetStr += target_is_player ? (' Tgt: ' + target_uid) : (' TgtUUID: ' + targetUUID);

                                        if (target_is_player) { //玩家目标
                                            if (isHeal) { //玩家被治疗
                                                if (operator_is_player) { //只记录玩家造成的治疗
                                                    userDataManager.addHealing(operator_uid, damage, isCrit, isLucky);
                                                }
                                            } else { //玩家受到伤害
                                                userDataManager.addTakenDamage(target_uid, damage);
                                            }
                                        } else { //非玩家目标
                                            if (isHeal) { //非玩家被治疗
                                                // 不处理非玩家的治疗
                                            }
                                            else { //非玩家受到伤害
                                                if (operator_is_player) { //只记录玩家造成的伤害
                                                    userDataManager.addDamage(operator_uid, damage, isCrit, isLucky, hpLessenValue);
                                                }
                                            }
                                        }

                                        // 判断职业
                                        if (operator_is_player) {
                                            let roleName;
                                            switch (skill) {
                                                case 1241:
                                                    roleName = '射线';
                                                    break;
                                                case 55302:
                                                    roleName = '协奏';
                                                    break;
                                                case 20301:
                                                    roleName = '愈合';
                                                    break;
                                                case 1518:
                                                    roleName = '惩戒';
                                                    break;
                                                case 2306:
                                                    roleName = '狂音';
                                                    break;
                                                case 120902:
                                                    roleName = '冰矛';
                                                    break;
                                                case 1714:
                                                    roleName = '居合';
                                                    break;
                                                case 44701:
                                                    roleName = '月刃';
                                                    break;
                                                case 220112:
                                                case 2203622:
                                                    roleName = '鹰弓';
                                                    break;
                                                case 1700827:
                                                    roleName = '狼弓';
                                                    break;
                                                case 1419:
                                                    roleName = '空枪';
                                                    break;
                                                case 1418:
                                                    roleName = '重装';
                                                    break;
                                                case 2405:
                                                    roleName = '防盾';
                                                    break;
                                                case 2406:
                                                    roleName = '光盾';
                                                    break;
                                                case 199902:
                                                    roleName = '岩盾';
                                                    break;
                                                default:
                                                    break;
                                            }
                                            if (roleName) userDataManager.setProfession(operator_uid, roleName);
                                        }

                                        let extra = [];
                                        if (isCrit) extra.push('Crit');
                                        if (isLucky) extra.push('Lucky');
                                        if (extra.length === 0) extra = ['Normal'];

                                        const actionType = isHeal ? 'Healing' : 'Damage';
                                        logger.info(`${srcTargetStr} Skill/Buff: ${skill} ${actionType}: ${damage}${isHeal ? '' : ` HpLessen: ${hpLessenValue}`} Extra: ${extra.join('|')}`);
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