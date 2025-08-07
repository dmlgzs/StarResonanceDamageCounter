const cap = require('cap');
const cors = require('cors');
const readline = require('readline');
const winston = require("winston");
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PacketProcessor = require('./algo/packet');
const pb = require('./algo/pb');
const Readable = require("stream").Readable;
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const print = console.log;
const app = express();

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

// 通用统计类，用于处理伤害或治疗数据
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

    /** 添加数据记录
     * @param {number} value - 数值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} isLucky - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量（仅伤害使用）
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

        if (this.timeRange[0]) {
            this.timeRange[1] = now;
        } else {
            this.timeRange[0] = now;
        }
    }

    /** 更新实时统计 */
    updateRealtimeStats() {
        const now = Date.now();

        // 清除超过1秒的数据
        while (this.realtimeWindow.length > 0 && now - this.realtimeWindow[0].time > 1000) {
            this.realtimeWindow.shift();
        }

        // 计算当前实时值
        this.realtimeStats.value = 0;
        for (const entry of this.realtimeWindow) {
            this.realtimeStats.value += entry.value;
        }

        // 更新最大值
        if (this.realtimeStats.value > this.realtimeStats.max) {
            this.realtimeStats.max = this.realtimeStats.value;
        }
    }

    /** 计算总的每秒统计值 */
    getTotalPerSecond() {
        if (!this.timeRange[0] || !this.timeRange[1]) {
            return 0;
        }
        const totalPerSecond = (this.stats.total / (this.timeRange[1] - this.timeRange[0]) * 1000) || 0;
        if (!Number.isFinite(totalPerSecond)) return 0;
        return totalPerSecond;
    }

    /** 重置数据 */
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

class UserData {
    constructor(uid) {
        this.uid = uid;
        this.name = '';
        this.damageStats = new StatisticData();
        this.healingStats = new StatisticData();
        this.takenDamage = 0; // 承伤
        this.profession = '未知';
        this.skillUsage = new Map(); // 技能使用情况
        this.fightPoint = 0; // 总评分
    }

    /** 添加伤害记录
     * @param {number} skillId - 技能ID/Buff ID
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量
     */
    addDamage(skillId, damage, isCrit, isLucky, hpLessenValue = 0) {
        this.damageStats.addRecord(damage, isCrit, isLucky, hpLessenValue);
        // 记录技能使用情况
        if (!this.skillUsage.has(skillId)) {
            this.skillUsage.set(skillId, new StatisticData());
        }
        this.skillUsage.get(skillId).addRecord(damage, isCrit, isLucky, hpLessenValue);
        this.skillUsage.get(skillId).realtimeWindow.length = 0;
    }

    /** 添加治疗记录
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     */
    addHealing(healing, isCrit, isLucky) {
        this.healingStats.addRecord(healing, isCrit, isLucky);
    }

    /** 添加承伤记录
     * @param {number} damage - 承受的伤害值
     * */
    addTakenDamage(damage) {
        this.takenDamage += damage;
    }

    /** 设置职业
     * @param {string} profession - 职业名称
     * */
    setProfession(profession) {
        this.profession = profession;
    }

    /** 更新实时DPS和HPS 计算过去1秒内的总伤害和治疗 */
    updateRealtimeDps() {
        this.damageStats.updateRealtimeStats();
        this.healingStats.updateRealtimeStats();
    }

    /** 计算总DPS */
    getTotalDps() {
        return this.damageStats.getTotalPerSecond();
    }

    /** 计算总HPS */
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
            name: this.name,
            fightPoint: this.fightPoint,
        };
    }

    /** 设置姓名
     * @param {string} name - 姓名
     * */
    setName(name) {
        this.name = name;
    }

    /** 设置用户总评分
     * @param {number} fightPoint - 总评分
     */
    setFightPoint(fightPoint) {
        this.fightPoint = fightPoint;
    }

    /** 重置数据 预留 */
    reset() {
        this.damageStats.reset();
        this.healingStats.reset();
        this.takenDamage = 0;
        this.profession = '未知';
        this.skillUsage.clear();
        this.fightPoint = 0;
    }
}

// 用户数据管理器
class UserDataManager {
    constructor() {
        this.users = new Map();
    }

    /** 获取或创建用户记录
     * @param {number} uid - 用户ID
     * @returns {UserData} - 用户数据实例
     */
    getUser(uid) {
        if (!this.users.has(uid)) {
            this.users.set(uid, new UserData(uid));
        }
        return this.users.get(uid);
    }

    /** 添加伤害记录
     * @param {number} uid - 造成伤害的用户ID
     * @param {number} skillId - 技能ID/Buff ID
     * @param {number} damage - 伤害值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     * @param {number} hpLessenValue - 生命值减少量
     */
    addDamage(uid, skillId, damage, isCrit, isLucky, hpLessenValue = 0) {
        const user = this.getUser(uid);
        user.addDamage(skillId, damage, isCrit, isLucky, hpLessenValue);
    }

    /** 添加治疗记录
     * @param {number} uid - 进行治疗的用户ID
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     */
    addHealing(uid, healing, isCrit, isLucky) {
        const user = this.getUser(uid);
        user.addHealing(healing, isCrit, isLucky);
    }

    /** 添加承伤记录
     * @param {number} uid - 承受伤害的用户ID
     * @param {number} damage - 承受的伤害值
     * */
    addTakenDamage(uid, damage) {
        const user = this.getUser(uid);
        user.addTakenDamage(damage);
    }

    /** 设置用户职业
     * @param {number} uid - 用户ID
     * @param {string} profession - 职业名称
     * */
    setProfession(uid, profession) {
        const user = this.getUser(uid);
        user.setProfession(profession);
    }

    /** 设置用户姓名
     * @param {number} uid - 用户ID
     * @param {string} name - 姓名
     * */
    setName(uid, name) {
        const user = this.getUser(uid);
        user.setName(name);
    }

    /** 设置用户总评分
     * @param {number} uid - 用户ID
     * @param {number} fightPoint - 总评分
     */
    setFightPoint(uid, fightPoint) {
        const user = this.getUser(uid);
        user.setFightPoint(fightPoint);
    }

    /** 更新所有用户的实时DPS和HPS */
    updateAllRealtimeDps() {
        for (const user of this.users.values()) {
            user.updateRealtimeDps();
        }
    }

    /** 获取所有用户数据 */
    getAllUsersData() {
        const result = {};
        for (const [uid, user] of this.users.entries()) {
            result[uid] = user.getSummary();
        }
        return result;
    }

    /** 清除所有用户数据 */
    clearAll() {
        this.users.clear();
    }

    /** 获取用户列表 */
    getUserIds() {
        return Array.from(this.users.keys());
    }
}

const userDataManager = new UserDataManager();

// 暂停统计状态
let isPaused = false;

async function main() {
    print('Welcome to use Damage Counter for Star Resonance!');
    print('Version: V2.2.2');
    print('GitHub: https://github.com/dmlgzs/StarResonanceDamageCounter');
    for (let i = 0; i < devices.length; i++) {
        print(i + '.\t' + devices[i].description);
    }

    // 从命令行参数获取设备号和日志级别
    const args = process.argv.slice(2);
    let num = args[0];
    let log_level = args[1];

    // 参数验证函数
    function isValidLogLevel(level) {
        return ['info', 'debug'].includes(level);
    }

    // 如果命令行没传或者不合法，使用交互
    if (num === undefined || !devices[num]) {
        num = await ask('Please enter the number of the device used for packet capture: ');
        if (!devices[num]) {
            print('Cannot find device ' + num + '!');
            process.exit(1);
        }

    }
    if (log_level === undefined || !isValidLogLevel(log_level)) {
        log_level = await ask('Please enter log level (info|debug): ') || 'info';
        if (!isValidLogLevel(log_level)) {
            print('Invalid log level!');
            process.exit(1);
        }
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

    //瞬时DPS更新
    setInterval(() => {
        if (!isPaused) {
            userDataManager.updateAllRealtimeDps();
        }
    }, 100);

    //express 和 socket.io 设置
    app.use(cors());
    app.use(express.json()); // 解析JSON请求体
    app.use(express.static('public'));
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    app.get('/api/data', (req, res) => {
        const userData = userDataManager.getAllUsersData();
        const data = {
            code: 0,
            user: userData,
        };
        res.json(data);
    });
    app.get('/api/clear', (req, res) => {
        userDataManager.clearAll();
        logger.info('Statistics have been cleared!');
        res.json({
            code: 0,
            msg: 'Statistics have been cleared!',
        });
    });

    // 暂停/开始统计API
    app.post('/api/pause', (req, res) => {
        const { paused } = req.body;
        isPaused = paused;
        logger.info(`Statistics ${isPaused ? 'paused' : 'resumed'}!`);
        res.json({
            code: 0,
            msg: `Statistics ${isPaused ? 'paused' : 'resumed'}!`,
            paused: isPaused
        });
    });

    // 获取暂停状态API
    app.get('/api/pause', (req, res) => {
        res.json({
            code: 0,
            paused: isPaused
        });
    });

    // WebSocket 连接处理
    io.on('connection', (socket) => {
        logger.info('WebSocket client connected: ' + socket.id);
        
        socket.on('disconnect', () => {
            logger.info('WebSocket client disconnected: ' + socket.id);
        });
    });

    // 每50ms广播数据给所有WebSocket客户端
    setInterval(() => {
        if (!isPaused) {
            const userData = userDataManager.getAllUsersData();
            const data = {
                code: 0,
                user: userData,
            };
            io.emit('data', data);
        }
    }, 50);

    server.listen(8989, () => {
        logger.info('Web Server started at http://localhost:8989');
        logger.info('WebSocket Server started');
    });

    logger.info('Welcome!');
    logger.info('Attempting to find the game server, please wait!');

    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = {};
    let tcp_cache_size = 0;
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

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
    c.on('packet', async function (nbytes, trunc) {
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
                            if (buf[4] == 0) {
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
                    // logger.debug('TCP next seq: ' + tcp_next_seq);
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
                        let packetSize = _data.readUInt32BE();

                        if (_data.length < packetSize) break;

                        if (_data.length >= packetSize) {
                            const packet = _data.subarray(0, packetSize);
                            _data = _data.subarray(packetSize);
                            const processor = new PacketProcessor({ logger, userDataManager });
                            if (!isPaused) processor.processPacket(packet);
                        } else if (packetSize > 999999) {
                            logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                            process.exit(1);
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