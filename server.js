const cap = require('cap');
const cors = require('cors');
const readline = require('readline');
const winston = require("winston");
const zlib = require('zlib');
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs');
const PacketProcessor = require('./algo/packet');
const Readable = require("stream").Readable;
const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;
const print = console.log;
const app = express();
const { exec } = require('child_process');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const devices = cap.deviceList();

const elementMap = {
        fire: '🔥火',
        ice: '❄️冰',
        thunder: '⚡雷',
        earth: '🍀森',
        wind: '💨风',
        light: '✨光',
        dark: '🌙暗',
        physics: '⚔️'
};

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer);
        });
    });
}

function getSubProfessionBySkillId(skillId) {
    switch (skillId) {
        case 1241:
            return '射线';
        case 55302:
            return '协奏';
        case 20301:
        case 21418:
            return '愈合';
        case 1518:
        case 1541:
            return '惩戒';
        case 2306:
            return '狂音';
        case 120902:
            return '冰矛';
        case 1714:
        case 1734:
            return '居合';
        case 44701:
            return '月刃';
        case 220112:
        case 2203622:
            return '鹰弓';
        case 1700827:
            return '狼弓';
        case 1419:
            return '空枪';
        case 1405:
        case 1418:
            return '重装';
        case 2405:
            return '防盾';
        case 2406:
            return '光盾';
        case 199902:
            return '岩盾';
        default:
            return '';
    }
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
    constructor(user, type) {
        this.user = user;
        this.type = type || '';
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
        this.damageStats = new StatisticData(this, '伤害');
        this.healingStats = new StatisticData(this, '治疗');
        this.takenDamage = 0; // 承伤
        this.profession = '未知';
        this.skillUsage = new Map(); // 技能使用情况
        this.fightPoint = 0; // 总评分
        this.subProfession = '';
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
            this.skillUsage.set(skillId, new StatisticData(this, '伤害'));
        }
        this.skillUsage.get(skillId).addRecord(damage, isCrit, isLucky, hpLessenValue);
        this.skillUsage.get(skillId).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** 添加治疗记录
     * @param {number} skillId - 技能ID/Buff ID
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     */
    addHealing(skillId, healing, isCrit, isLucky) {
        this.healingStats.addRecord(healing, isCrit, isLucky);
        // 记录技能使用情况
        if (!this.skillUsage.has(skillId)) {
            this.skillUsage.set(skillId, new StatisticData(this, '治疗'));
        }
        this.skillUsage.get(skillId).addRecord(healing, isCrit, isLucky);
        this.skillUsage.get(skillId).realtimeWindow.length = 0;

        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** 添加承伤记录
     * @param {number} damage - 承受的伤害值
     * */
    addTakenDamage(damage) {
        this.takenDamage += damage;
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
            profession: this.profession + (this.subProfession ? `-${this.subProfession}` : ''),
            name: this.name,
            fightPoint: this.fightPoint,
        };
    }

    /** 获取技能统计数据 */
    getSkillSummary() {
        const skills = {};
        for (const [skillId, stat] of this.skillUsage) {
            const total = stat.stats.normal + stat.stats.critical +
                stat.stats.lucky + stat.stats.crit_lucky;
            const critCount = stat.count.critical;
            const luckyCount = stat.count.lucky;
            const critRate = stat.count.total > 0 ? critCount / stat.count.total : 0;
            const luckyRate = stat.count.total > 0 ? luckyCount / stat.count.total : 0;
            const skillConfig = require('./skill_config.json').skills;
            const cfg = skillConfig[skillId];
            const name = cfg ? cfg.name : skillId;
            const elementype = elementMap[cfg?.element] ?? "";

            skills[skillId] = {
                displayName: name,
                type: stat.type,
                elementype: elementype,
                totalDamage: stat.stats.total,
                totalCount: stat.count.total,
                critCount: stat.count.critical,
                luckyCount: stat.count.lucky,
                critRate: critRate,
                luckyRate: luckyRate,
                damageBreakdown: { ...stat.stats },
                countBreakdown: { ...stat.count }
            };
        }
        return skills;
    }

    /** 设置职业
     * @param {string} profession - 职业名称
     * */
    setProfession(profession) {
        if (profession !== this.profession) this.setSubProfession('');
        this.profession = profession;
    }

    /** 设置子职业
     * @param {string} subProfession - 子职业名称
     * */
    setSubProfession(subProfession) {
        this.subProfession = subProfession;
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
        this.skillUsage.clear();
        this.fightPoint = 0;
    }
}

// 用户数据管理器
class UserDataManager {
    constructor(logger) {
        this.logger = logger
        this.users = new Map();
        this.userCache = new Map(); // 用户名字和职业缓存
        this.cacheFilePath = './users.json';
        this.loadUserCache();

        // 节流相关配置
        this.saveThrottleDelay = 2000; // 2秒节流延迟，避免频繁磁盘写入
        this.saveThrottleTimer = null;
        this.pendingSave = false;
    }

    /** 加载用户缓存 */
    loadUserCache() {
        try {
            if (fs.existsSync(this.cacheFilePath)) {
                const data = fs.readFileSync(this.cacheFilePath, 'utf8');
                const cacheData = JSON.parse(data);
                this.userCache = new Map(Object.entries(cacheData));
                this.logger.info(`Loaded ${this.userCache.size} user cache entries`);
            }
        } catch (error) {
            this.logger.error('Failed to load user cache:', error);
        }
    }

    /** 保存用户缓存 */
    saveUserCache() {
        try {
            const cacheData = Object.fromEntries(this.userCache);
            fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
        } catch (error) {
            this.logger.error('Failed to save user cache:', error);
        }
    }

    /** 节流保存用户缓存 - 减少频繁的磁盘写入 */
    saveUserCacheThrottled() {
        this.pendingSave = true;

        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
        }

        this.saveThrottleTimer = setTimeout(() => {
            if (this.pendingSave) {
                this.saveUserCache();
                this.pendingSave = false;
                this.saveThrottleTimer = null;
            }
        }, this.saveThrottleDelay);
    }

    /** 强制立即保存用户缓存 - 用于程序退出等场景 */
    forceUserCacheSave() {
        if (this.saveThrottleTimer) {
            clearTimeout(this.saveThrottleTimer);
            this.saveThrottleTimer = null;
        }
        if (this.pendingSave) {
            this.saveUserCache();
            this.pendingSave = false;
        }
    }

    /** 获取或创建用户记录
     * @param {number} uid - 用户ID
     * @returns {UserData} - 用户数据实例
     */
    getUser(uid) {
        if (!this.users.has(uid)) {
            const user = new UserData(uid);

            // 从缓存中设置名字和职业
            const cachedData = this.userCache.get(String(uid));
            if (cachedData) {
                if (cachedData.name) {
                    user.setName(cachedData.name);
                }
                if (cachedData.profession) {
                    user.setProfession(cachedData.profession);
                }
                if (cachedData.fightPoint !== undefined && cachedData.fightPoint !== null) {
                    user.setFightPoint(cachedData.fightPoint);
                }
            }

            this.users.set(uid, user);
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
     * @param {number} skillId - 技能ID/Buff ID
     * @param {number} healing - 治疗值
     * @param {boolean} isCrit - 是否为暴击
     * @param {boolean} [isLucky] - 是否为幸运
     */
    addHealing(uid, skillId, healing, isCrit, isLucky) {
        const user = this.getUser(uid);
        user.addHealing(skillId, healing, isCrit, isLucky);
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
        if (user.profession !== profession) {
            user.setProfession(profession);
            this.logger.info(`Found profession ${profession} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).profession = profession;
            this.saveUserCacheThrottled();
        }
    }

    /** 设置用户姓名
     * @param {number} uid - 用户ID
     * @param {string} name - 姓名
     * */
    setName(uid, name) {
        const user = this.getUser(uid);
        if (user.name !== name) {
            user.setName(name);
            this.logger.info(`Found player name ${name} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).name = name;
            this.saveUserCacheThrottled();
        }
    }

    /** 设置用户总评分
     * @param {number} uid - 用户ID
     * @param {number} fightPoint - 总评分
    */
    setFightPoint(uid, fightPoint) {
        const user = this.getUser(uid);
        if (user.fightPoint != fightPoint) {
            user.setFightPoint(fightPoint);
            this.logger.info(`Found fight point ${fightPoint} for uid ${uid}`);

            // 更新缓存
            const uidStr = String(uid);
            if (!this.userCache.has(uidStr)) {
                this.userCache.set(uidStr, {});
            }
            this.userCache.get(uidStr).fightPoint = fightPoint;
            this.saveUserCacheThrottled();
        }
    }

    /** 更新所有用户的实时DPS和HPS */
    updateAllRealtimeDps() {
        for (const user of this.users.values()) {
            user.updateRealtimeDps();
        }
    }

    /** 获取用户的技能数据 */
    getUserSkillData(uid) {
        const user = this.users.get(uid);
        if (!user) return null;

        return {
            uid: user.uid,
            name: user.name,
            profession: user.profession,
            skills: user.getSkillSummary()
        };
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

// 暂停统计状态
let isPaused = false;

async function main() {
    print('Welcome to use Damage Counter for Star Resonance!');
    print('Version: V2.3');
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

    const userDataManager = new UserDataManager(logger);

    // 进程退出时保存用户缓存
    process.on('SIGINT', () => {
        console.log('\nSaving user cache...');
        userDataManager.forceUserCacheSave();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\nSaving user cache...');
        userDataManager.forceUserCacheSave();
        process.exit(0);
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
    app.use(express.static(path.join(__dirname, 'public'))); // 静态文件服务
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

    // 获取技能数据
    app.get('/api/skill/:uid', (req, res) => {
        const uid = parseInt(req.params.uid);
        const skillData = userDataManager.getUserSkillData(uid);

        if (!skillData) {
            return res.status(404).json({
                code: 1,
                msg: 'User not found'
            });
        }

        res.json({
            code: 0,
            data: skillData
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
        // 自动用默认浏览器打开网页（跨平台兼容）
        const url = 'http://localhost:8989';
        logger.info(`Web Server started at ${url}`);
        logger.info('WebSocket Server started');

        
        let command;
        switch (process.platform) {
            case 'darwin': // macOS
                command = `open ${url}`;
                break;
            case 'win32': // Windows
                command = `start ${url}`;
                break;
            default: // Linux 和其他 Unix-like 系统
                command = `xdg-open ${url}`;
                break;
        }

        exec(command, (error) => {
            if (error) {
                logger.error(`Failed to open browser: ${error.message}`);
            }
        });
    });

    logger.info('Welcome!');
    logger.info('Attempting to find the game server, please wait!');

    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = new Map();
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache.clear();
    };

    const fragmentIpCache = new Map();
    const FRAGMENT_TIMEOUT = 30000;
    const getTCPPacket = (frameBuffer, ethOffset) => {
        const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
        const ipId = ipPacket.info.id;
        const isFragment = (ipPacket.info.flags & 0x1) !== 0;
        const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
        const now = Date.now();

        if (isFragment || ipPacket.info.fragoffset > 0) {
            if (!fragmentIpCache.has(_key)) {
                fragmentIpCache.set(_key, {
                    fragments: [],
                    timestamp: now
                });
            }

            const cacheEntry = fragmentIpCache.get(_key);
            const ipBuffer = Buffer.from(frameBuffer.subarray(ethOffset));
            cacheEntry.fragments.push(ipBuffer);
            cacheEntry.timestamp = now;

            // there's more fragment ip packetm, wait for the rest
            if (isFragment) {
                return null;
            }

            // last fragment received, reassemble
            const fragments = cacheEntry.fragments;
            if (!fragments) {
                logger.error(`Can't find fragments for ${_key}`);
                return null;
            }

            // Reassemble fragments based on their offset
            let totalLength = 0;
            const fragmentData = [];

            // Collect fragment data with their offsets
            for (const buffer of fragments) {
                const ip = decoders.IPV4(buffer);
                const fragmentOffset = ip.info.fragoffset * 8;
                const payloadLength = ip.info.totallen - ip.hdrlen;
                const payload = Buffer.from(buffer.subarray(ip.offset, ip.offset + payloadLength));

                fragmentData.push({
                    offset: fragmentOffset,
                    payload: payload
                });

                const endOffset = fragmentOffset + payloadLength;
                if (endOffset > totalLength) {
                    totalLength = endOffset;
                }
            }

            const fullPayload = Buffer.alloc(totalLength);
            for (const fragment of fragmentData) {
                fragment.payload.copy(fullPayload, fragment.offset);
            }

            fragmentIpCache.delete(_key);
            return fullPayload;
        }

        return Buffer.from(frameBuffer.subarray(ipPacket.offset, ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen)));
    };

    //抓包相关
    const eth_queue = [];
    const c = new Cap();
    const device = devices[num].name;
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);
    const linkType = c.open(device, filter, bufSize, buffer);
    if (linkType !== "ETHERNET") {
        logger.error('WRONG DEVICE!');
        process.exit(1);
    }
    c.setMinBytes && c.setMinBytes(0);
    c.on("packet", async function (nbytes, trunc) {
        eth_queue.push(Buffer.from(buffer));
    });
    const processEthPacket = async (frameBuffer) => {
        // logger.debug('packet: length ' + nbytes + ' bytes, truncated? ' + (trunc ? 'yes' : 'no'));

        var ethPacket = decoders.Ethernet(frameBuffer);

        if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ipPacket = decoders.IPV4(frameBuffer, ethPacket.offset);
        const srcaddr = ipPacket.info.srcaddr;
        const dstaddr = ipPacket.info.dstaddr;

        const tcpBuffer = getTCPPacket(frameBuffer, ethPacket.offset);
        if (tcpBuffer === null) return;
        const tcpPacket = decoders.TCP(tcpBuffer);

        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));

        //logger.debug(' from port: ' + tcpPacket.info.srcport + ' to port: ' + tcpPacket.info.dstport);
        const srcport = tcpPacket.info.srcport;
        const dstport = tcpPacket.info.dstport;
        const src_server = srcaddr + ":" + srcport + " -> " + dstaddr + ":" + dstport;

        await tcp_lock.acquire();
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
                                if (current_server !== src_server) {
                                    current_server = src_server;
                                    clearTcpCache();
                                    tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                    logger.info("Got Scene Server Address: " + src_server);
                                }
                            } catch (e) { }
                        } while (data1 && data1.length);
                    }
                }
                //尝试通过登录返回包识别服务器(仍需测试)
                if (buf.length === 0x62) {
                    // prettier-ignore
                    const signature = Buffer.from([
                        0x00, 0x00, 0x00, 0x62,
                        0x00, 0x03,
                        0x00, 0x00, 0x00, 0x01,
                        0x00, 0x11, 0x45, 0x14,//seq?
                        0x00, 0x00, 0x00, 0x00,
                        0x0a, 0x4e, 0x08, 0x01, 0x22, 0x24
                    ]);
                    if (Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0) {
                        if (current_server !== src_server) {
                            current_server = src_server;
                            clearTcpCache();
                            tcp_next_seq = tcpPacket.info.seqno + buf.length;
                            logger.info("Got Scene Server Address by Login Return Packet: " + src_server);
                        }
                    }
                }
            } catch (e) { }
            tcp_lock.release();
            return;
        }
        // logger.debug(`packet seq ${tcpPacket.info.seqno >>> 0} size ${buf.length} expected next seq ${((tcpPacket.info.seqno >>> 0) + buf.length) >>> 0}`);
        //这里已经是识别到的服务器的包了
        if (tcp_next_seq === -1) {
            logger.error("Unexpected TCP capture error! tcp_next_seq is -1");
            if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                tcp_next_seq = tcpPacket.info.seqno;
            }
        }
        // logger.debug('TCP next seq: ' + tcp_next_seq);
        if (((tcp_next_seq - tcpPacket.info.seqno) << 0) <= 0 || tcp_next_seq === -1) {
            tcp_cache.set(tcpPacket.info.seqno, buf);
        }
        while (tcp_cache.has(tcp_next_seq)) {
            const seq = tcp_next_seq;
            const cachedTcpData = tcp_cache.get(seq);
            _data = _data.length === 0 ? cachedTcpData : Buffer.concat([_data, cachedTcpData]);
            tcp_next_seq = (seq + cachedTcpData.length) >>> 0; //uint32
            tcp_cache.delete(seq);
            tcp_last_time = Date.now();
        }

        while (_data.length > 4) {
            let packetSize = _data.readUInt32BE();

            if (_data.length < packetSize) break;

            if (_data.length >= packetSize) {
                const packet = _data.subarray(0, packetSize);
                _data = _data.subarray(packetSize);
                const processor = new PacketProcessor({ logger, userDataManager });
                if (!isPaused) processor.processPacket(packet);
            } else if (packetSize > 0x0fffff) {
                logger.error(`Invalid Length!! ${_data.length},${len},${_data.toString("hex")},${tcp_next_seq}`);
                process.exit(1);
                break;
            }
        }
        tcp_lock.release();
    }
    (async () => {
        while (true) {
            if (eth_queue.length) {
                const pkt = eth_queue.shift();
                processEthPacket(pkt);
            } else {
                await new Promise(r => setTimeout(r, 1));
            }
        }
    })();

    //定时清理过期的IP分片缓存
    setInterval(async () => {
        const now = Date.now();
        let clearedFragments = 0;
        for (const [key, cacheEntry] of fragmentIpCache) {
            if (now - cacheEntry.timestamp > FRAGMENT_TIMEOUT) {
                fragmentIpCache.delete(key);
                clearedFragments++;
            }
        }
        if (clearedFragments > 0) {
            logger.debug(`Cleared ${clearedFragments} expired IP fragment caches`);
        }

        if (tcp_last_time && Date.now() - tcp_last_time > FRAGMENT_TIMEOUT) {
            logger.warn("Cannot capture the next packet! Is the game closed or disconnected? seq: " + tcp_next_seq);
            current_server = "";
            clearTcpCache();
        }
    }, 10000);
}

if (!zlib.zstdDecompressSync) {
    // 之前总是有人用旧版本nodejs，不看警告还说数据不准，现在干脆不让旧版用算了
    // 还有人对着开源代码写闭源，不遵守许可就算了，还要诋毁开源，什么人啊这是
    print("zstdDecompressSync is not available! Please update your Node.js!");
    process.exit(1);
}

main();