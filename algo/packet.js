const zlib = require('zlib');
const pb = require('./blueprotobuf');
const Long = require('long');
const pbjs = require('protobufjs/minimal');
const pb2 = require('./BlueProtobuf_pb');
const fs = require('fs');

class BinaryReader {
    constructor(buffer, offset = 0) {
        this.buffer = buffer;
        this.offset = offset;
    }

    readUInt64() {
        const value = this.buffer.readBigUInt64BE(this.offset);
        this.offset += 8;
        return value;
    }

    peekUInt64() {
        return this.buffer.readBigUInt64BE(this.offset);
    }

    readUInt32() {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    peekUInt32() {
        return this.buffer.readUInt32BE(this.offset);
    }

    readInt32() {
        const value = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readUInt32LE() {
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    peekInt32() {
        return this.buffer.readInt32BE(this.offset);
    }

    readUInt16() {
        const value = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    peekUInt16() {
        return this.buffer.readUInt16BE(this.offset);
    }

    readBytes(length) {
        const value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    peekBytes(length) {
        return this.buffer.subarray(this.offset, this.offset + length);
    }

    remaining() {
        return this.buffer.length - this.offset;
    }

    readRemaining() {
        const value = this.buffer.subarray(this.offset);
        this.offset = this.buffer.length;
        return value;
    }
}

const MessageType = {
    None: 0,
    Call: 1,
    Notify: 2,
    Return: 3,
    Echo: 4,
    FrameUp: 5,
    FrameDown: 6,
};

const NotifyMethod = {
    SyncNearEntities: 0x00000006,
    SyncContainerData: 0x00000015,
    SyncContainerDirtyData: 0x00000016,
    SyncNearDeltaInfo: 0x0000002d,
    SyncToMeDeltaInfo: 0x0000002e,
};

const AttrType = {
    AttrName: 0x01,
    AttrProfessionId: 0xdc,
    AttrFightPoint: 0x272e,
    AttrLevel: 0x2710,
    AttrRankLevel: 0x274c,
    AttrCri: 0x2b66,
    AttrLucky: 0x2b7a,
    AttrHp: 0x2c2e,
    AttrMaxHp: 0x2c38,
    AttrElementFlag: 0x646d6c,
    AttrReductionLevel: 0x64696d,
    AttrReduntionId: 0x6f6c65,
    AttrEnergyFlag: 0x543cd3c6,
};

const ProfessionType = {
    雷影剑士: 1,
    冰魔导师: 2,
    涤罪恶火_战斧: 3,
    青岚骑士: 4,
    森语者: 5,
    雷霆一闪_手炮: 8,
    巨刃守护者: 9,
    暗灵祈舞_仪刀_仪仗: 10,
    神射手: 11,
    神盾骑士: 12,
    灵魂乐手: 13,
};

const getProfessionNameFromId = (professionId) => {
    switch (professionId) {
        case ProfessionType.雷影剑士:
            return '雷影剑士';
        case ProfessionType.冰魔导师:
            return '冰魔导师';
        case ProfessionType.涤罪恶火_战斧:
            return '涤罪恶火·战斧';
        case ProfessionType.青岚骑士:
            return '青岚骑士';
        case ProfessionType.森语者:
            return '森语者';
        case ProfessionType.雷霆一闪_手炮:
            return '雷霆一闪·手炮';
        case ProfessionType.巨刃守护者:
            return '巨刃守护者';
        case ProfessionType.暗灵祈舞_仪刀_仪仗:
            return '暗灵祈舞·仪刀/仪仗';
        case ProfessionType.神射手:
            return '神射手';
        case ProfessionType.神盾骑士:
            return '神盾骑士';
        case ProfessionType.灵魂乐手:
            return '灵魂乐手';
        default:
            return '';
    }
};

const isUuidPlayer = (uuid) => {
    return (uuid.toBigInt() & 0xffffn) === 640n;
};

const doesStreamHaveIdentifier = (reader) => {
    let identifier = reader.readUInt32LE();
    reader.readInt32();
    if (identifier !== 0xfffffffe) return false;
    identifier = reader.readInt32();
    reader.readInt32();
    //if (identifier !== 0xfffffffd) return false;
    return true;
};

const streamReadString = (reader) => {
    const length = reader.readUInt32LE();
    reader.readInt32();
    const buffer = reader.readBytes(length);
    reader.readInt32();
    return buffer.toString();
};

let currentUserUuid = Long.ZERO;

class PacketProcessor {
    constructor({ logger, userDataManager }) {
        this.logger = logger;
        this.userDataManager = userDataManager;
    }

    _decompressPayload(buffer) {
        if (!zlib.zstdDecompressSync) {
            this.logger.warn('zstdDecompressSync is not available! Please check your Node.js version!');
            return;
        }
        return zlib.zstdDecompressSync(buffer);
    }

    _processAoiSyncDelta(aoiSyncDelta) {
        if (!aoiSyncDelta) return;

        let targetUuid = aoiSyncDelta.Uuid;
        if (!targetUuid) return;
        const isTargetPlayer = isUuidPlayer(targetUuid);
        targetUuid = targetUuid.shiftRight(16);

        const skillEffect = aoiSyncDelta.SkillEffects;
        if (!skillEffect) return;

        if (!skillEffect.Damages) return;
        for (const syncDamageInfo of skillEffect.Damages) {
            const skillId = syncDamageInfo.OwnerId;
            if (!skillId) continue;

            let attackerUuid = syncDamageInfo.TopSummonerId || syncDamageInfo.AttackerUuid;
            if (!attackerUuid) continue;
            const isAttackerPlayer = isUuidPlayer(attackerUuid);
            attackerUuid = attackerUuid.shiftRight(16);

            const value = syncDamageInfo.Value;
            const luckyValue = syncDamageInfo.LuckyValue;
            const damage = value ?? luckyValue ?? Long.ZERO;
            if (damage.isZero()) continue;

            // syncDamageInfo.IsCrit doesn't seem to be set by server, use typeFlag instead
            // const isCrit = syncDamageInfo.IsCrit !== null ? syncDamageInfo.IsCrit : false;

            // TODO: from testing, first bit is set when there's crit, 3rd bit for lucky, require more testing here
            const isCrit = syncDamageInfo.TypeFlag != null ? (syncDamageInfo.TypeFlag & 1) === 1 : false;

            const isMiss = syncDamageInfo.IsMiss != null ? syncDamageInfo.IsMiss : false;
            const isHeal = syncDamageInfo.Type === pb.EDamageType.Heal;
            const isDead = syncDamageInfo.IsDead != null ? syncDamageInfo.IsDead : false;
            const isLucky = !!luckyValue;
            const hpLessenValue = syncDamageInfo.HpLessenValue != null ? syncDamageInfo.HpLessenValue : Long.ZERO;

            if (isTargetPlayer) {
                //玩家目标
                if (isHeal) {
                    //玩家被治疗
                    if (isAttackerPlayer) {
                        //只记录玩家造成的治疗
                        this.userDataManager.addHealing(attackerUuid.toNumber(), skillId, damage.toNumber(), isCrit, isLucky, targetUuid.toNumber());
                    }
                } else {
                    //玩家受到伤害
                    this.userDataManager.addTakenDamage(targetUuid.toNumber(), damage.toNumber());
                }
            } else {
                //非玩家目标
                if (isHeal) {
                    //非玩家被治疗
                } else {
                    //非玩家受到伤害
                    if (isAttackerPlayer) {
                        //只记录玩家造成的伤害
                        this.userDataManager.addDamage(
                            attackerUuid.toNumber(),
                            skillId,
                            damage.toNumber(),
                            isCrit,
                            isLucky,
                            hpLessenValue.toNumber(),
                        );
                    }
                }
            }

            let extra = [];
            if (isCrit) extra.push('Crit');
            if (isLucky) extra.push('Lucky');
            if (extra.length === 0) extra = ['Normal'];

            const actionType = isHeal ? 'Healing' : 'Damage';

            let infoStr = `Src: ${attackerUuid.toString()}`;
            if (isAttackerPlayer) {
                const attacker = this.userDataManager.getUser(attackerUuid.toNumber());
                if (attacker.name) {
                    infoStr = `Src: ${attacker.name}`;
                } else {
                    infoStr += ' (player)';
                }
            }

            let targetName = `${targetUuid.toString()}`;
            if (isTargetPlayer) {
                const target = this.userDataManager.getUser(targetUuid.toNumber());
                if (target.name) {
                    targetName = target.name;
                } else {
                    targetName += ' (player)';
                }
            }
            infoStr += ` Tgt: ${targetName}`;

            this.logger.info(
                `${infoStr} Skill/Buff: ${skillId} ${actionType}: ${damage} ${isHeal ? '' : ` HpLessen: ${hpLessenValue}`} Extra: ${extra.join('|')}`,
            );
        }
    }

    _processSyncNearDeltaInfo(payloadBuffer) {
        const syncNearDeltaInfo = pb.SyncNearDeltaInfo.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncNearDeltaInfo, null, 2));

        if (!syncNearDeltaInfo.DeltaInfos) return;
        for (const aoiSyncDelta of syncNearDeltaInfo.DeltaInfos) {
            this._processAoiSyncDelta(aoiSyncDelta);
        }
    }

    _processSyncToMeDeltaInfo(payloadBuffer) {
        const syncToMeDeltaInfo = pb.SyncToMeDeltaInfo.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncToMeDeltaInfo, null, 2));

        const aoiSyncToMeDelta = syncToMeDeltaInfo.DeltaInfo;

        const uuid = aoiSyncToMeDelta.Uuid;
        if (uuid && !currentUserUuid.eq(uuid)) {
            currentUserUuid = uuid;
            this.logger.info('Got player UUID! UUID: ' + currentUserUuid + ' UID: ' + currentUserUuid.shiftRight(16));
        }

        const aoiSyncDelta = aoiSyncToMeDelta.BaseDelta;
        if (!aoiSyncDelta) return;

        this._processAoiSyncDelta(aoiSyncDelta);
    }

    _processSyncContainerData(payloadBuffer) {
        // for some reason protobufjs doesn't work here, we use google-protobuf instead
        try {
            const syncContainerData = pb.SyncContainerData.decode(payloadBuffer);
            // this.logger.debug(JSON.stringify(syncContainerData, null, 2));
            // fs.writeFileSync('SyncContainerData.json', JSON.stringify(syncContainerData, null, 2));

            if (!syncContainerData.VData) return;
            const vData = syncContainerData.VData;

            if (!vData.CharId) return;
            const playerUid = vData.CharId.toNumber();

            if (vData.RoleLevel && vData.RoleLevel.Level) this.userDataManager.setAttrKV(playerUid, 'level', vData.RoleLevel.Level);

            if (vData.Attr && vData.Attr.CurHp) this.userDataManager.setAttrKV(playerUid, 'hp', vData.Attr.CurHp.toNumber());

            if (vData.Attr && vData.Attr.MaxHp) this.userDataManager.setAttrKV(playerUid, 'max_hp', vData.Attr.MaxHp.toNumber());

            if (!vData.CharBase) return;
            const charBase = vData.CharBase;

            if (charBase.Name) this.userDataManager.setName(playerUid, charBase.Name);

            if (charBase.FightPoint) this.userDataManager.setFightPoint(playerUid, charBase.FightPoint);

            if (!vData.ProfessionList) return;
            const professionList = vData.ProfessionList;
            if (professionList.CurProfessionId)
                this.userDataManager.setProfession(playerUid, getProfessionNameFromId(professionList.CurProfessionId));
        } catch (err) {
            fs.writeFileSync('./SyncContainerData.dat', payloadBuffer);
            this.logger.warn(`Failed to decode SyncContainerData for player ${currentUserUuid.shiftRight(16)}. Please report to developer`);
            throw err;
        }
    }

    _processSyncContainerDirtyData(payloadBuffer) {
        if (currentUserUuid.isZero()) return;

        const syncContainerDirtyData = pb.SyncContainerDirtyData.decode(payloadBuffer);
        if (!syncContainerDirtyData.VData || !syncContainerDirtyData.VData.Buffer) return;
        this.logger.debug(syncContainerDirtyData.VData.Buffer.toString('hex'));
        const messageReader = new BinaryReader(Buffer.from(syncContainerDirtyData.VData.Buffer));

        if (!doesStreamHaveIdentifier(messageReader)) return;

        let fieldIndex = messageReader.readUInt32LE();
        messageReader.readInt32();
        switch (fieldIndex) {
            case 2: // CharBase
                if (!doesStreamHaveIdentifier(messageReader)) break;

                fieldIndex = messageReader.readUInt32LE();
                messageReader.readInt32();
                switch (fieldIndex) {
                    case 5: // Name
                        const playerName = streamReadString(messageReader);
                        if (!playerName || playerName === '') break;
                        this.userDataManager.setName(currentUserUuid.shiftRight(16).toNumber(), playerName);
                        break;
                    case 35: // FightPoint
                        const fightPoint = messageReader.readUInt32LE();
                        messageReader.readInt32();
                        this.userDataManager.setFightPoint(currentUserUuid.shiftRight(16).toNumber(), fightPoint);
                        break;
                    default:
                        // unhandle
                        break;
                }
                break;
            case 16: // UserFightAttr
                if (!doesStreamHaveIdentifier(messageReader)) break;

                fieldIndex = messageReader.readUInt32LE();
                messageReader.readInt32();
                switch (fieldIndex) {
                    case 1: // CurHp
                        const curHp = messageReader.readUInt32LE();
                        this.userDataManager.setAttrKV(currentUserUuid.shiftRight(16).toNumber(), 'hp', curHp);
                        break;
                    case 2: // MaxHp
                        const maxHp = messageReader.readUInt32LE();
                        this.userDataManager.setAttrKV(currentUserUuid.shiftRight(16).toNumber(), 'max_hp', maxHp);
                        break;
                    default:
                        // unhandle
                        break;
                }
                break;
            case 61: // ProfessionList
                if (!doesStreamHaveIdentifier(messageReader)) break;

                fieldIndex = messageReader.readUInt32LE();
                messageReader.readInt32();
                switch (fieldIndex) {
                    case 1: // CurProfessionId
                        const curProfessionId = messageReader.readUInt32LE();
                        messageReader.readInt32();
                        if (curProfessionId)
                            this.userDataManager.setProfession(currentUserUuid.shiftRight(16).toNumber(), getProfessionNameFromId(curProfessionId));
                        break;
                    default:
                        // unhandle
                        break;
                }
                break;
            default:
                // unhandle
                break;
        }

        // this.logger.debug(syncContainerDirtyData.VData.Buffer.toString('hex'));
    }

    _processSyncNearEntities(payloadBuffer) {
        const syncNearEntities = pb.SyncNearEntities.decode(payloadBuffer);
        // this.logger.debug(JSON.stringify(syncNearEntities, null, 2));

        if (!syncNearEntities.Appear) return;
        for (const entity of syncNearEntities.Appear) {
            if (entity.EntType !== pb.EEntityType.EntChar) continue;

            let playerUuid = entity.Uuid;
            if (!playerUuid) continue;
            playerUuid = playerUuid.shiftRight(16);

            const attrCollection = entity.Attrs;
            if (!attrCollection) continue;

            if (!attrCollection.Attrs) continue;
            for (const attr of attrCollection.Attrs) {
                if (!attr.Id || !attr.RawData) continue;
                const reader = pbjs.Reader.create(attr.RawData);

                switch (attr.Id) {
                    case AttrType.AttrName:
                        const playerName = reader.string();
                        this.userDataManager.setName(playerUuid.toNumber(), playerName);
                        break;
                    case AttrType.AttrProfessionId:
                        const professionId = reader.int32();
                        const professionName = getProfessionNameFromId(professionId);
                        this.userDataManager.setProfession(playerUuid.toNumber(), professionName);
                        break;
                    case AttrType.AttrFightPoint:
                        const playerFightPoint = reader.int32();
                        this.userDataManager.setFightPoint(playerUuid.toNumber(), playerFightPoint);
                        break;
                    case AttrType.AttrLevel:
                        const playerLevel = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'level', playerLevel);
                        break;
                    case AttrType.AttrRankLevel:
                        const playerRankLevel = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'rank_level', playerRankLevel);
                        break;
                    case AttrType.AttrCri:
                        const playerCri = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'cri', playerCri);
                        break;
                    case AttrType.AttrLucky:
                        const playerLucky = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'lucky', playerLucky);
                        break;
                    case AttrType.AttrHp:
                        const playerHp = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'hp', playerHp);
                        break;
                    case AttrType.AttrMaxHp:
                        const playerMaxHp = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'max_hp', playerMaxHp);
                        break;
                    case AttrType.AttrElementFlag:
                        const playerElementFlag = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'element_flag', playerElementFlag);
                        break;
                    case AttrType.AttrEnergyFlag:
                        const playerEnergyFlag = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'energy_flag', playerEnergyFlag);
                        break;
                    case AttrType.AttrReductionLevel:
                        const playerReductionLevel = reader.int32();
                        this.userDataManager.setAttrKV(playerUuid.toNumber(), 'reduction_level', playerReductionLevel);
                        break;
                    default:
                        // this.logger.debug(`Found unknown attrId ${attr.Id} ${attr.RawData.toString('base64')}`);
                        break;
                }
            }
        }
    }

    _processNotifyMsg(reader, isZstdCompressed) {
        const serviceUuid = reader.readUInt64();
        const stubId = reader.readUInt32();
        const methodId = reader.readUInt32();

        if (serviceUuid !== 0x0000000063335342n) {
            this.logger.debug(`Skipping NotifyMsg with serviceId ${serviceUuid}`);
            return;
        }

        let msgPayload = reader.readRemaining();
        if (isZstdCompressed) {
            msgPayload = this._decompressPayload(msgPayload);
        }

        switch (methodId) {
            case NotifyMethod.SyncNearEntities:
                this._processSyncNearEntities(msgPayload);
                break;
            case NotifyMethod.SyncContainerData:
                this._processSyncContainerData(msgPayload);
                break;
            case NotifyMethod.SyncContainerDirtyData:
                this._processSyncContainerDirtyData(msgPayload);
                break;
            case NotifyMethod.SyncToMeDeltaInfo:
                this._processSyncToMeDeltaInfo(msgPayload);
                break;
            case NotifyMethod.SyncNearDeltaInfo:
                this._processSyncNearDeltaInfo(msgPayload);
                break;
            default:
                this.logger.debug(`Skipping NotifyMsg with methodId ${methodId}`);
                break;
        }
        return;
    }

    _processReturnMsg(reader, isZstdCompressed) {
        this.logger.debug(`Unimplemented processing return`);
    }

    processPacket(packets) {
        try {
            const packetsReader = new BinaryReader(packets);

            do {
                let packetSize = packetsReader.peekUInt32();
                if (packetSize < 6) {
                    this.logger.debug(`Received invalid packet`);
                    return;
                }

                const packetReader = new BinaryReader(packetsReader.readBytes(packetSize));
                packetSize = packetReader.readUInt32(); // to advance
                const packetType = packetReader.readUInt16();
                const isZstdCompressed = packetType & 0x8000;
                const msgTypeId = packetType & 0x7fff;

                switch (msgTypeId) {
                    case MessageType.Notify:
                        this._processNotifyMsg(packetReader, isZstdCompressed);
                        break;
                    case MessageType.Return:
                        this._processReturnMsg(packetReader, isZstdCompressed);
                        break;
                    case MessageType.FrameDown:
                        const serverSequenceId = packetReader.readUInt32();
                        if (packetReader.remaining() == 0) break;

                        let nestedPacket = packetReader.readRemaining();

                        if (isZstdCompressed) {
                            nestedPacket = this._decompressPayload(nestedPacket);
                        }

                        // this.logger.debug("Processing FrameDown packet.");
                        this.processPacket(nestedPacket);
                        break;
                    default:
                        // this.logger.debug(`Ignore packet with message type ${msgTypeId}.`);
                        break;
                }
            } while (packetsReader.remaining() > 0);
        } catch (e) {
            this.logger.error(`Fail while parsing data for player ${currentUserUuid.shiftRight(16)}.\nErr: ${e}`);
        }
    }
}

module.exports = PacketProcessor;
