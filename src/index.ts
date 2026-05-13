import { Context, Schema, Session, Logger, h } from 'koishi'
import * as utils from "./utils";
import { HourColor, ShiftTable, Ranking, ShiftError, ShiftTableSchema, LegacyShiftTableSchema } from "./shift";
import Bottleneck from 'bottleneck';
import { Discord } from '@koishijs/plugin-adapter-discord'
import {} from 'koishi-plugin-puppeteer'
import { GoogleSheetAuth, GoogleSheetParams } from "./googleSheetHandler";
import { PendingShift, QueueManager } from "./queueManager";
import { paresMessageList, getGid, canGrant, isShiftOwner,
    getCurrentShift, loadShift, saveShift, roundToNearestHour,
    getTaskQueueKey, hoursToRanges, getDataFromBackend,
    getReplyFromBackend, parseChannelId, readJson,
    commandTopRateRanking, getFuzzySearchResult,
    serverNameFuzzySearchResult, executeShiftChangeNoticeTask
} from './utils'

export const name = 'bangdream-shift'
export const using = ['puppeteer', 'database'] as const
export const bdShiftLogger: Logger = new Logger("bangdream-shift");


export const inject = ['database'];
declare module 'koishi' {
    interface Tables {
        bangdream_shift: bangdream_shift;
        bangdream_shift_group: bangdream_shift_group;
        bangdream_speed_tracker: bangdream_speed_tracker;
    }
}

export interface bangdream_shift {
    id: number,
    name: string,
    shiftTable: ShiftTable
}

export interface bangdream_shift_group {
    gid: string,
    shift_id: number,
    using: boolean,
    is_owner: boolean,
}

export interface bangdream_speed_tracker {
    id: number,
    group_gid: string,
    tracker: speedIntervalTracker,
}

const BestdoriAPI = 'https://bestdori.com/api'

interface speedIntervalTracker {
    trackerPlayer: number,
    mainServer: Server,
    deadlineStamp: number,
}

export enum Server {
    jp, en, tw, cn, kr
}

export interface Config {
    openSpeedTracker: boolean,
    openShift: boolean,
    autoRecognize: boolean,
    autoRecognizeRegex: string,
    defaultTimezone: string,
    defaultServer: Server,
    backendUrl: string,
    googleAuth?: {
        client_email: string;
        private_key: string;
    };
    enableDataRepair: boolean;
    test?: {
        test1: boolean,
        test2: boolean
    },
    limiter: {
        minTime: number,
        maxConcurrent: number,
        timeout: number,
        maxRetryCounts: number
    }
}



export const Config = Schema.intersect([
    Schema.object({
        openSpeedTracker: Schema.boolean().default(false).description('允许群聊开启定时查询车速'),
        openShift: Schema.boolean().default(false).description('开启班表管理功能'),
        autoRecognize: Schema.boolean().default(false).description('班表自动识别'),
        autoRecognizeRegex: Schema.string().default("(\\d{1,2})[ー\\-\\~～;；](\\d{1,2})").description('识别填班的正则表达式'),
        defaultTimezone: Schema.string().default('Asia/Tokyo'),
    }).description('班表基础设置'),
    Schema.object({
        defaultServer: Schema.union([
            Schema.const(Server.jp).description('jp'),
            Schema.const(Server.cn).description('cn'),
            Schema.const(Server.en).description('en'),
            Schema.const(Server.tw).description('tw'),
            Schema.const(Server.kr).description('kr')
        ]).default(Server.jp).description('默认服务器'),
        backendUrl: Schema.string().default('http://localhost:3000').description('后端服务器地址'),
    }).description('数据推送设置'),
    Schema.object({
        googleAuth: Schema.object({
            client_email: Schema.string().description('Google Service Account Client Email'),
            private_key: Schema.string().role('secret').description('Google Service Account Private Key')
        }),
    }).description('Google Sheets认证信息'),
    Schema.object({
        enableDataRepair: Schema.boolean().default(false).description('加载时扫描并修复数据库结构'),
        test: Schema.object({
            test1: Schema.boolean().default(false),
            test2: Schema.boolean().default(false)
        }),
        limiter: Schema.object({
            minTime: Schema.number().default(400).description('限流器最短请求间隔'),
            maxConcurrent: Schema.number().default(1).description('限流器最大并发数'),
            timeout: Schema.number().default(1000 * 60 * 5).description('限流器清理内存时间'),
            maxRetryCounts: Schema.number().default(3).description('限流器重试次数')
        }).description('限流器设置')
    }).description('高级选项'),


])

export async function apply(ctx: Context, cfg: Config) {
    ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
    ctx.i18n.define('ja-JP', require('./locales/ja-JP'));
    ctx.i18n.define('zh-TW', require('./locales/zh-TW'));

    const queue = new QueueManager(ctx, cfg);


    ctx.model.extend('bangdream_shift', {
        id: 'unsigned',
        name: 'string',
        shiftTable: 'json'
    }, { primary: 'id', autoInc: true });

    ctx.model.extend('bangdream_shift_group', {
        gid: 'string',
        shift_id: 'unsigned',
        using: 'boolean',
        is_owner: {
            type: 'boolean',
            legacy: ['is_manager']
        }
    }, { primary: ['gid', 'shift_id'] });

    ctx.model.extend('bangdream_speed_tracker', {
        group_gid: 'string',
        tracker: 'json'
    }, { primary: 'group_gid' })

    //班表功能
    if (cfg.openShift) {
        // 创建班表，名字不能和已有的重复
        ctx.command('create-shift <name:string> <start:string> <end:string>')
            .option('spreadsheetId', '-s <spreadsheetId:string>(可选)谷歌表格ID，提供后将从谷歌表格同步数据')
            .option('sheetName', '--sheet <sheetName:string> (可选)谷歌选择工作表，默认マーク式')
            .option('startCell', '--start <startCell:string> (可选)谷歌表格排版开始单元格')
            .option('colInterval', '--col <colInterval:number> (可选)谷歌表格的列间隔')
            .option('rowInterval', '--row <rowInterval:number> (可选)谷歌表格的行间隔')
            .option('dayInterval', '--day <dayInterval:number> (可选)谷歌表格的日间隔')
            .option('startHour', '--hour <startHour:number>　(可选)谷歌表格的开始小时')
            .action(async ({ session, options }, name, start, end) => {
                bdShiftLogger.info(session.userId, 'try to create shift: ', name, start, end);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!start || !end) return session.text('lack', { params: 'start/end' });
                if (!name) return session.text('lack', { params: 'name' });
                try {
                    let startTs: string, endTs: string;

                    const nearestStart = roundToNearestHour(start);
                    const nearestEnd = roundToNearestHour(end);
                    [startTs, endTs] = [nearestStart, nearestEnd]

                    // 创建 shiftTable 实例
                    let table: ShiftTable;
                    if (options.spreadsheetId) {
                        if (!cfg.googleAuth) return session.text('noGoogleAuth');
                        const gParams: GoogleSheetParams = {
                            spreadsheetId: options.spreadsheetId,
                            options:{
                                sheetName: options.sheetName,
                                startCell: options.startCell,
                                colInterval: options.colInterval,
                                rowInterval: options.rowInterval,
                                dayInterval: options.dayInterval,
                                startHour: options.startHour,
                            }
                        };
                        table = await ShiftTable.create(startTs, endTs, cfg.defaultTimezone, gParams, cfg.googleAuth);
                    } else {
                        table = new ShiftTable(startTs, endTs, cfg.defaultTimezone);
                    }

                    // 插入班表
                    const bangdream_shift = await ctx.database.create('bangdream_shift', {
                        name: name,
                        shiftTable: table
                    })
                    // 当前群绑定该表
                    // 先把当前群所有班表置为未使用
                    await ctx.database.set('bangdream_shift_group', { gid: getGid(session) }, { using: false })

                    // 当前群绑定该表
                    await ctx.database.create('bangdream_shift_group', {
                        gid: getGid(session),
                        shift_id: bangdream_shift.id,
                        using: true,
                        is_owner: true
                    })

                    return session.text('.success', { name: name })
                } catch (e) {
                    if (e instanceof ShiftError) {
                        if (e.code === "INVALID_TIME_FORMAT") {
                            return session.text('.timeFormat')
                        } else if (e.code === "OUT_OF_BOUNDS") {
                            return session.text('.invalidShiftLength')
                        }
                    }
                    throw e;
                }
            });

        ctx.command('remove-shift <name:string>')
            .action(async ({ session }, name) => {
                bdShiftLogger.info(session.userId, 'try to remove shift: ', name);
                if (!name) return session.text('lack', { params: 'name' });

                // 查找班表
                const table = await ctx.database.get('bangdream_shift', { name })
                if (!table.length) {
                    return session.text('.noShift');
                }

                const shift = table[0];

                // 当前群必须是 owner 才能删除
                if (!await isShiftOwner(ctx, getGid(session), shift.id))
                    return session.text('notOwner')

                // 删除引用该班表的 bangdream_shift_group
                await ctx.database.remove('bangdream_shift_group', {
                    shift_id: shift.id
                })

                // 删除班表本体
                await ctx.database.remove('bangdream_shift', {
                    id: shift.id
                })

                return session.text('.success', { name: name })
            });

        ctx.command('set-shift-ending <end:string>')
            .action(async ({ session }, end) => {
                bdShiftLogger.info(session.userId, 'try to set shift ending: ', end);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!end) return session.text('lack', { params: 'start/end' });
                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                let endTs: string;
                try {
                    endTs = roundToNearestHour(end)
                } catch (e) {
                    if (e instanceof ShiftError) {
                        if (e.code === "INVALID_TIME_FORMAT") {
                            return session.text('.timeFormat')
                        } else if (e.code === "OUT_OF_BOUNDS") {
                            return session.text('.invalidShiftLength')
                        }
                    }
                    throw e;
                }
                await row.shiftTable.setEndTime(endTs)
                await saveShift(ctx, row)
                return session.text('.success', { name: row.name })
            });

        ctx.command('ls-shift')
            .action(async ({ session }) => {
                bdShiftLogger.info(session.userId, 'try to list shift');
                if (!await canGrant(session)) return session.text('permission-denied');


                const gid = getGid(session)

                // 先拿 bangdream_shift_group 中该 gid 的 shift_id
                const groups = await ctx.database.get('bangdream_shift_group', { gid })
                if (!groups.length) return session.text('noGroups');
                const using = groups.filter(g => g.using).map(g => g.shift_id)

                // 一次性查询所有对应 shift_id 的班表
                const shifts = await ctx.database.get('bangdream_shift', { id: { $in: groups.map(g => g.shift_id) } })

                return shifts.map(s => `[${using.includes(s.id) ? "*" : " "}] ${s.name}`).join('\n')


            });

        ctx.command('switch-shift <name:string>')
            .action(async ({ session }, name) => {
                bdShiftLogger.info(session.userId, 'try to switch to shift: ', name);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return session.text('lack', { params: 'name' });

                // 查询该群所有班表
                const groupShift = await ctx.database.get('bangdream_shift_group', { gid: getGid(session) })
                const groupShiftIds = groupShift.map(gs => gs.shift_id)

                // 查询班表id
                const shift = await ctx.database.get('bangdream_shift', { name })
                const shift_id = shift.at(0)?.id;
                if (!shift?.length || !groupShiftIds.includes(shift_id)) return session.text('.noShift', { name: name });
                // 先把当前群的所有班表 using = false
                await ctx.database.set('bangdream_shift_group', { gid: getGid(session) }, { using: false })
                // 把指定班表设为使用中
                await ctx.database.set('bangdream_shift_group', {
                    gid: getGid(session),
                    shift_id: shift_id
                }, { using: true })

                return session.text('.success', { name })
            })

        ctx.command('add-shift <person:string> <day:number> <startHour:number> <endHour:number> [startHour2:number] [endHour2:number] [startHour3:number] [endHour3:number] [startHour4:number] [endHour4:number] [startHour5:number] [endHour5:number]')
            .action(async ({ session }, person, day, startHour, endHour, startHour2, endHour2, startHour3, endHour3, startHour4, endHour4, startHour5, endHour5) => {
                bdShiftLogger.info(session.userId, 'try to add shift: ', person, day,
                    ...[[startHour, endHour],
                        [startHour2, endHour2],
                        [startHour3, endHour3],
                        [startHour4, endHour4],
                        [startHour5, endHour5]].filter(([s, t]) => s !== undefined || t !== undefined)
                );

                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) {
                    return session.text('lack', { params: 'person/day/startHour/endHour' });
                }

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5]
                ].filter(([s, e]) => s !== undefined && e !== undefined && s < e) as [number, number][];
                if (!segments?.length) return session.text('.errorTime');
                // 用于汇总成功/失败的小时
                let allSuccess: number[] = [];
                let allFailed: number[] = [];

                // 手动同步
                await row.shiftTable.pull();
                // 逐段插入
                for (const [s, e] of segments) {
                    const { success, failed } = await row.shiftTable.addShift(day - 1, s, e, person, true);
                    allSuccess.push(...success);
                    allFailed.push(...failed);
                }

                await saveShift(ctx, row);
                // 手动同步
                await row.shiftTable.pushDay(day - 1);

                // 转成连续区间
                const successRanges = hoursToRanges(allSuccess);
                const failedRanges = hoursToRanges(allFailed);

                const msg: string[] = [];

                if (successRanges.length) {
                    msg.push(session.text('.success', { day, person, hourRange: successRanges.join(' ') }));
                }

                if (failedRanges.length) {
                    msg.push(session.text('.fail', { day, person, hourRange: failedRanges.join(' ') }));
                }

                return msg.length ? msg.join('\n') : session.text('.errorTime');
            });

        ctx.command('del-shift <person:string> <day:number> <startHour:number> <endHour:number> [startHour2:number] [endHour2:number] [startHour3:number] [endHour3:number] [startHour4:number] [endHour4:number] [startHour5:number] [endHour5:number]')
            .action(async ({ session }, person, day, startHour, endHour, startHour2, endHour2, startHour3, endHour3, startHour4, endHour4, startHour5, endHour5) => {

                bdShiftLogger.info(session.userId, 'try to del shift: ', person, day,
                    ...[[startHour, endHour],
                        [startHour2, endHour2],
                        [startHour3, endHour3],
                        [startHour4, endHour4],
                        [startHour5, endHour5]].filter(([s, t]) => s !== undefined || t !== undefined)
                );

                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) {
                    return session.text('lack', { params: 'person/day/startHour/endHour' });
                }

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5]
                ].filter(([s, e]) => s < e && s !== undefined && e !== undefined) as [number, number][];

                if (!segments?.length) return session.text('.errorTime');

                const allRemoved = new Set<number>();

                // 手动同步
                await row.shiftTable.pull();

                // 逐段删除
                for (const [s, e] of segments) {
                    const removed = await row.shiftTable.delShift(day - 1, s, e, person, true);
                    removed.forEach(h => void allRemoved.add(h));
                }

                await saveShift(ctx, row);
                // 手动同步
                await row.shiftTable.pushDay(day - 1);

                const removedRanges = hoursToRanges([...allRemoved]);

                if (!removedRanges.length) {
                    return session.text('.fail', {
                        person,
                        day,
                        hourRange: segments.map(([s, e]) => `${s}-${e}`).join(' ')
                    });
                }

                return session.text('.success', { person, day, hourRange: removedRanges.join(' ') });
            });

        ctx.command('exchange-shift <oldName:string> <newName:string> <day:number> <startHour:number> <endHour:number> [startHour2:number] [endHour2:number] [startHour3:number] [endHour3:number] [startHour4:number] [endHour4:number] [startHour5:number] [endHour5:number]')
            .action(async ({ session }, oldName, newName, day, startHour, endHour, startHour2, endHour2, startHour3, endHour3, startHour4, endHour4, startHour5, endHour5) => {

                bdShiftLogger.info(session.userId, 'try to exchange shift: ', oldName, newName, day,
                    ...[[startHour, endHour],
                        [startHour2, endHour2],
                        [startHour3, endHour3],
                        [startHour4, endHour4],
                        [startHour5, endHour5]].filter(([s, t]) => s !== undefined || t !== undefined)
                );

                if (!await canGrant(session)) return session.text('permission-denied');

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5]
                ].filter(([s, e]) => s !== undefined && e !== undefined && s < e) as [number, number][];
                if (!segments?.length) return session.text('.errorTime');
                // 用于汇总成功/失败的小时
                let allSuccess: number[] = [];
                let allFailed: number[] = [];

                // 手动同步
                await row.shiftTable.pull();

                // 逐段替换
                for (const [s, e] of segments) {
                    const { success, failed } = await row.shiftTable.exchangeShift(day - 1, s, e, oldName, newName, true);
                    allSuccess.push(...success);
                    allFailed.push(...failed);
                }

                await saveShift(ctx, row);
                // 手动同步
                await row.shiftTable.pushDay(day - 1);

                // 转成连续区间
                const successRanges = hoursToRanges(allSuccess);
                const failedRanges = hoursToRanges(allFailed);

                const msg: string[] = [];

                if (successRanges.length) {
                    msg.push(session.text('.success', {
                        day,
                        fromPerson: oldName,
                        toPerson: newName,
                        hourRange: successRanges.join(' ')
                    }));
                }

                if (failedRanges.length) {
                    msg.push(session.text('.fail', { day, toPerson: newName, hourRange: failedRanges.join(' ') }));
                }

                return msg.length ? msg.join('\n') : session.text('.noShift');
            });

        ctx.command('add-shift-once <day:number> <text:text>')
            .action(async ({ session }, day, text) => {
                bdShiftLogger.info(session.userId, 'try to add shift once: ', day, text);
                // 基础校验与权限检查
                if (!day || !text) return session.text('lack', { params: 'day/text' });
                if (!await canGrant(session)) return session.text('permission-denied');

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                // 校验天数范围（1 到 n）
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 手动同步
                await row.shiftTable.pull();

                const tasks: { person: string, segments: [number, number][] }[] = [];

                // 解析逻辑
                // 匹配逻辑：只有当 数字-数字 前后是空格或边界，且在 0-24 之间时才视为时间段
                const timeRegex = /(?:^|\s)(\d{1,2})-(\d{1,2})(?:\s|$)/g;
                let lastIndex = 0;
                let currentPerson = "";
                let match: RegExpExecArray | null;

                while ((match = timeRegex.exec(text)) !== null) {
                    let s = parseInt(match[1]);
                    let e = parseInt(match[2]);
                    if (e === 0) e = 24;
                    if (s === 24) s = 0;
                    // 校验是否为合法小时区间
                    // 这里手动微调 exec 的起始位置，防止因为正则内部的空格捕获导致跳过下一个可能的匹配
                    timeRegex.lastIndex = match.index + match[0].length - 1;
                    if (s >= 0 && s <= 24 && e >= 0 && e <= 24 && s < e) {
                        // 提取匹配项之前的内容作为人名
                        const leadText = text.substring(lastIndex, match.index).trim();

                        if (leadText) {
                            currentPerson = leadText;
                            tasks.push({ person: currentPerson, segments: [] });
                        }

                        // 如果已经确定了当前人员，则记录该时间段
                        if (currentPerson) {
                            tasks[tasks.length - 1].segments.push([s, e]);
                        }
                        // 更新搜索起始位置，跳过已处理的文本
                        lastIndex = timeRegex.lastIndex;
                    }
                }

                if (tasks.length === 0) return session.text('.errorTime');

                // 执行添加逻辑并收集结果
                const successEntries: string[] = [];
                const failEntries: string[] = [];

                for (const task of tasks) {
                    if (task.segments.length === 0) continue;

                    let personAllSuccess: number[] = [];
                    let personAllFailed: number[] = [];

                    for (const [s, e] of task.segments) {
                        // 内部 addShift 会调用 normalizeHour 进行自动裁切
                        const { success, failed } = await row.shiftTable.addShift(day - 1, s, e, task.person, true);
                        personAllSuccess.push(...success);
                        personAllFailed.push(...failed);
                    }

                    // 格式化输出：将小时列表转回 9-12 14-16 格式
                    if (personAllSuccess.length > 0) {
                        successEntries.push(session.text('.person-hours', {
                            person: task.person,
                            hourRange: hoursToRanges(personAllSuccess).join(' ')
                        }));
                    }
                    if (personAllFailed.length > 0) {
                        failEntries.push(session.text('.person-hours', {
                            person: task.person,
                            hourRange: hoursToRanges(personAllFailed).join(' ')
                        }));
                    }
                }

                // 存储数据并返回格式化消息
                await saveShift(ctx, row);
                // 手动同步
                await row.shiftTable.pushDay(day - 1);

                const finalMsg: string[] = [];
                if (successEntries.length > 0) {
                    finalMsg.push(session.text('.success', { day, message: successEntries.join('\n') }));
                }

                if (failEntries.length > 0) {
                    finalMsg.push(session.text('.fail', { day, message: failEntries.join('\n') }));
                }

                if (successEntries.length === 0 && failEntries.length === 0) return session.text('.errorTime');

                return finalMsg.join('\n');
            });

        ctx.command('set-runner <name:string> <ranking:string>')
            .action(async ({ session }, name, ranking: Ranking) => {
                bdShiftLogger.info(session.userId, 'try to set runner: ', name, ranking);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name || !ranking) return session.text('lack', { params: 'name/ranking' });
                const validRankings = ['main', '10', '50', '100', '1000'];
                if (!validRankings.includes(ranking)) return session.text('.invalidRanking', { validRankings: validRankings.join(',') });

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');
                row.shiftTable.setRanking(name, ranking);

                await saveShift(ctx, row)

                return session.text('.success', { name, ranking });
            });

        ctx.command('del-runner <name:string>')
            .action(async ({ session }, name) => {
                bdShiftLogger.info(session.userId, 'try to del runner: ', name);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return session.text('lack', { params: 'name' });

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                row.shiftTable.setRanking(name, undefined);
                await saveShift(ctx, row)
                return session.text('.success', { name });
            });

        ctx.command('rename-person <oldName:string> <newName:string>')
            .action(async ({ session }, oldName, newName) => {
                bdShiftLogger.info(session.userId, 'try to rename person: ', oldName, newName);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!oldName || !newName) return session.text('lack', { params: 'oldName/newName' });
                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                await row.shiftTable.renamePerson(oldName, newName);

                await saveShift(ctx, row)

                return session.text('.success', { oldName, newName });
            })

        ctx.command('show-shift <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                const image = await row.shiftTable.renderShiftImage(ctx, day - 1);
                // puppeteer 截图
                return session.text('.success', {
                    day: day
                }) + image;
            });

        ctx.command('show-shift-exchange <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift exchange: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');
                // puppeteer 截图
                const image = await row.shiftTable.renderShiftExchangeImage(ctx, day - 1);
                // puppeteer 截图
                return session.text('.success', {
                    day: day
                }) + image;
            });

        ctx.command('show-shift-left <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift left: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                const missingCount = await row.shiftTable.getMissingCount(day - 1);
                if (!missingCount || missingCount.length !== 24) return session.text('outOfDay');


                const ranges: string[] = [];
                let startHour = 0;
                let count = missingCount[0];

                for (let h = 1; h <= 24; h++) { // 最后一轮用 h=24 触发输出
                    const currCount = h < 24 ? missingCount[h] : -1; // 超过24时刻触发输出
                    if (currCount !== count) {
                        if (count > 0) {
                            ranges.push(`${startHour}-${h} @${count}`);
                        }
                        startHour = h;
                        count = currCount;
                    }
                }
                return session.text('.success', { ranges: ranges.join('\n') });
            });

        ctx.command('share-shift <shift_name:string> <group_gid:string>')
            .userFields(['authority'])
            .action(async ({ session }, shift_name, group_gid) => {
                bdShiftLogger.info(session.userId, 'try to share shift: ', shift_name, group_gid);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!shift_name || !group_gid) return session.text('lack', { params: 'shift_name/group_gid' });
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name: shift_name });
                const shift_id = shift[0].id

                // 当前群必须是 owner 才能授权
                if (!await isShiftOwner(ctx, getGid(session), shift_id))
                    return session.text('notOwner')

                // 给指定群绑定管理权限
                await ctx.database.create('bangdream_shift_group', {
                    gid: group_gid,
                    shift_id,
                    using: false,
                    is_owner: false
                })

                return session.text('.success', { group_gid, shift_name });
            });

        // 列出某个班表的managers
        ctx.command('shift-group-ls <shift_name:string>')
            .action(async ({ session }, shift_name) => {
                bdShiftLogger.info(session.userId, 'try to list manager shift: ', shift_name);
                if (!await canGrant(session)) return session.text('permission-denied');
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name });
                const shift_id = shift[0].id

                if (!await isShiftOwner(ctx, getGid(session), shift_id))
                    return session.text('notOwner')

                const groups = await ctx.database.get('bangdream_shift_group', { shift_id })
                if (!groups.length) return session.text('.noGroups');
                return groups.map(g => `${g.gid} ${g.using ? '(*)' : ''}`).join('\n')
            })

        // 撤销某群管理权限
        ctx.command('revoke-shift <shift_name:string> <group_gid:string>')
            .action(async ({ session }, shift_name, group_gid) => {
                bdShiftLogger.info(session.userId, 'try to revoke shift management: ', shift_name, group_gid);
                if (!await canGrant(session)) return session.text('permission-denied');
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name });
                const shift_id = shift[0].id

                if (!await isShiftOwner(ctx, getGid(session), shift_id))
                    return session.text('notOwner')

                await ctx.database.remove('bangdream_shift_group', { gid: group_gid, shift_id })
                return session.text('.success', { group_gid, shift_name })
            })

        ctx.command('set-shift-color <day:number> <start:number> <end:number> <color:string>')
            .action(async ({ session }, day, start, end, color: HourColor) => {
                bdShiftLogger.info(session.userId, 'try to set shift color: ', day, start, end, color);
                if (!await canGrant(session)) return session.text('permission-denied');
                const validColors: HourColor[] = ['none', 'gray', 'black', 'invalid']

                // 参数检查
                if (!day) return session.text('lack', { params: 'day' });
                if (start === null || end === null) return session.text('lack', { params: 'start/end' });
                if (!color) return session.text('lack', { params: 'color' });

                // 颜色校验
                if (!validColors.includes(color as HourColor)) {
                    return session.text('.invalidColor', { validColors: validColors.join(' / ') });
                }
                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');


                const hours = await row.shiftTable.setShiftColor(
                    day - 1,
                    start,
                    end,
                    color
                )

                await saveShift(ctx, row)
                if (!hours?.length) return session.text('.fail')
                const hourRange = hoursToRanges(hours)
                return session.text('.success', { day, hourRange, color })
            });

        ctx.command('shift-change-notice <enable:boolean> [channelId:string]')
            .action(async ({ session }, enable, channelId) => {
                bdShiftLogger.info(session.userId, 'try to set shift change notice: ', enable, channelId);
                if (!await canGrant(session)) return session.text('permission-denied');

                let finalCid: string;
                if (channelId) {
                    const parsed = parseChannelId(channelId);
                    if (!parsed) return session.text('.notInChannel');
                    finalCid = `${session.platform}:${parsed}`;
                } else {
                    finalCid = session.cid;
                }

                const row = await autoLoadShift(session);
                if (!row) return session.text('noGroups');

                const { shiftTable } = row;
                if (enable) {
                    const noticeLocale = (session as any).locales?.[0] || (session as any).locale || 'ja-JP';
                    shiftTable.setChangeNotice(finalCid, noticeLocale);
                    await saveShift(ctx, row);
                    return session.text('.enabled', { channel: finalCid });
                } else {
                    shiftTable.deleteChangeNotice();
                    await saveShift(ctx, row);
                    return session.text('.disabled', { channel: finalCid });
                }
            });

        // 换班通知调度：每小时检查一次，提前 MINUTES_BEFORE 分钟触发（MINUTES_BEFORE 写死在程序中）
        const MINUTES_BEFORE = 5;

        const alignToHourlyNotice = () => {
            const now = Date.now();
            // 计算距离下一个整点再减去提前分钟数的毫秒数
            let delay = 3600000 - (now % 3600000) - MINUTES_BEFORE * 60000;
            if (delay <= 0) delay += 3600000; // 保证为正

            ctx.setTimeout(async () => {
                try {
                    await executeShiftChangeNoticeTask(ctx, cfg, bdShiftLogger);
                } catch (e) {
                    bdShiftLogger.error('[ShiftNotice] 执行异常', e);
                }
                // 每小时触发一次
                ctx.setInterval(async () => {
                    try {
                        await executeShiftChangeNoticeTask(ctx, cfg, bdShiftLogger);
                    } catch (e) {
                        bdShiftLogger.error('[ShiftNotice] 定时任务异常', e);
                    }
                }, 3600000);
            }, delay);
        };

        alignToHourlyNotice();

        if (cfg.autoRecognize) {

            ctx.command('ls-channels')
                .action(async ({ session }) => {
                    bdShiftLogger.info(session.userId, 'try to list channel');

                    const curr = await getCurrentShift(ctx, getGid(session));
                    if (!curr) return session.text('.notfound');

                    const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
                    const { shiftTable } = row;
                    const shifts = await ctx.database.get('bangdream_shift', { id: curr.shift_id });
                    let output = [session.text('.title', { id: curr.shift_id, name: shifts[0]?.name}), '---'];

                    // 列出报班频道
                    output.push(session.text(".shiftChannels"));

                    // 获取 entries 并根据 dayIndex (数组的第二个元素) 进行排序
                    const sc = Object.entries(shiftTable.shift_channels)
                        .sort(([, dayA], [, dayB]) => dayA - dayB); // 升序排列

                    if (sc.length === 0) {
                        output.push(session.text('.none'));
                    } else {
                        // 遍历排序后的数组
                        sc.forEach(([id, dayIndex]) => {
                            output.push(session.text('.shiftChannelItem', {
                                id: `<#${id}>`,
                                day: dayIndex + 1
                            }));
                        });
                    }
                    output.push('');

                    // 列出管理频道
                    output.push(session.text('.managerChannels'));
                    const mc = shiftTable.manager_channels;
                    if (!mc || mc.length === 0) output.push(session.text('.none'));
                    else mc.forEach(id => output.push(session.text('.managerChannelItem', { id: `${id}` })));

                    return output.join('\n');
                });

            ctx.command('set-shift-channel <day:number> <channel:string>')
                .option('delete', '-d')
                .action(async ({ session, options }, day, channel) => {
                    bdShiftLogger.info(session.userId, 'try to add shift channel: ', day, channel);
                    // 基础校验与权限检查
                    if (!day || !channel) return session.text('lack', { params: 'day/channel' });
                    if (!await canGrant(session)) return session.text('permission-denied');

                    channel = parseChannelId(channel);

                    const row = await autoLoadShift(session);
                    if (!row) return;
                    const { shiftTable } = row;
                    if (options.delete) {
                        shiftTable.deleteShiftChannel(channel);
                        await saveShift(ctx, row);
                        return session.text('.remove', { channel: channel, day: day });
                    }
                    shiftTable.addShiftChannel(channel, day - 1);
                    await saveShift(ctx, row)
                    return session.text('.success', { channel: channel, day: day });
                })

            ctx.command('set-manager-channel <channel:string>')
                .option('delete', '-d')
                .action(async ({ session, options }, channel) => {
                    bdShiftLogger.info(session.userId, 'try to add manager channel: ', channel);
                    // 基础校验与权限检查
                    if (!channel) return session.text('lack', { params: 'channel' });
                    if (!await canGrant(session)) return session.text('permission-denied');

                    channel = parseChannelId(channel);

                    const row = await autoLoadShift(session);
                    if (!row) return;
                    const { shiftTable } = row;

                    if (options.delete) {
                        shiftTable.deleteManagerChannel(channel);
                        await saveShift(ctx, row);
                        return session.text('.remove', { channel: channel });
                    }

                    shiftTable.addManagerChannel(channel);
                    await saveShift(ctx, row);
                    return session.text('.success', { channel: channel});
                })

            ctx.middleware(async (session, next) => {
                await processShiftMessage(session);
                return next();
            });

            async function processShiftMessage(session: Session){
                // 1. 基础过滤：必须有回复内容，且不是机器人自己发出的
                const quoteId = session.quote?.id;
                if (!quoteId || !session.content || session.userId === session.selfId) return;

                // 2. 检查被回复的消息是否在待处理列表里
                const data = queue.pendingShifts.get(quoteId);
                if (!data) return;

                if (!await canGrant(session)) return session.send(session.text('permission-denied'));

                const content = session.content.trim();
                let isModified = false;

                // --- 回复的是“根消息” ---
                if (data.childIds?.length) {
                    // 规则：根消息只允许改天数和名字，不允许改时间

                    // 检查是否是纯数字 (修改天数)
                    if (/^\d+$/.test(content)) {
                        data.dayIndex = parseInt(content, 10) - 1;
                        isModified = true;
                    }
                    // 检查是否是时间段格式 (报错拦截)
                    else if (/^\d+\s*-\s*\d+$/.test(content)) {
                        await session.send(session.text('auto-shift.noSupportTime'));
                        return;
                    }
                    // 其它字符串 (修改名字)
                    else {
                        data.userName = content;
                        isModified = true;
                    }

                    if (isModified) {
                        // 批量同步所有子消息
                        for (const childId of [...data.childIds]) {
                            const childData = queue.pendingShifts.get(childId);
                            if (!childData) continue;
                            childData.userName = data.userName;
                            childData.dayIndex = data.dayIndex;

                            const newChildText = session.text('auto-shift.info', {
                                day: childData.dayIndex + 1,
                                userName: childData.userName,
                                start: childData.slot.start,
                                end: childData.slot.end
                            });
                            await updateMessageUI(session, childId, newChildText, childData);
                        }
                        await session.send(session.text('auto-shift.editTotal', { day: data.dayIndex + 1, name: data.userName }));
                    }
                }

                // --- 回复的是“子消息”（具体时间段） ---
                else if (data.slot) {
                    // 1. 检查是否是时间段 hh-hh
                    const timeMatch = content.match(/^(\d+)\s*-\s*(\d+)$/);
                    if (timeMatch) {
                        data.slot.start = parseInt(timeMatch[1], 10);
                        data.slot.end = parseInt(timeMatch[2], 10);
                        isModified = true;
                    }
                    // 2. 检查是否是纯数字 (修改天数)
                    else if (/^\d+$/.test(content)) {
                        data.dayIndex = parseInt(content, 10) - 1;
                        isModified = true;
                    }
                    // 3. 其它字符串 (修改名字)
                    else {
                        data.userName = content;
                        isModified = true;
                    }

                    if (isModified) {
                        const newText = session.text('auto-shift.info', {
                            day: data.dayIndex + 1,
                            userName: data.userName,
                            start: data.slot.start,
                            end: data.slot.end
                        });
                        await updateMessageUI(session, quoteId, newText, data);
                    }
                }
            }

            /**
             * 统一的消息 UI 更新函数
             * @param session 当前执行指令的 session
             * @param oldMsgId 要修改的目标消息 ID
             * @param newContent 渲染后的新文本 (auto-shift.info)
             * @param data 内存中的 shift 数据对象
             */
            async function updateMessageUI(session: Session, oldMsgId: string, newContent: string, data: PendingShift) {
                const channelId = session.channelId;
                const bot = session.bot;

                // 构造最终展示文本
                const finalContent = h.parse(`${newContent}\n*(已修正)*`);

                if (session.platform === 'discord') {
                    try {
                        // Discord 平台：直接原地编辑
                        await bot.editMessage(channelId, oldMsgId, finalContent);
                        // 内存数据已在外部修改，直接 set 确保同步
                        queue.pendingShifts.set(oldMsgId, data);
                    } catch (e) {
                        console.error('[Shift-Edit-Error]', e);
                        throw new Error('Discord 消息编辑失败');
                    }
                } else {
                    try {
                        // 非 Discord 平台：清除旧反应 -> 发送新消息 -> 迁移 ID
                        await bot.clearReaction(channelId, oldMsgId).catch(() => {});

                        const [newMsgId] = await bot.sendMessage(channelId, finalContent);

                        if (newMsgId) {
                            // 1. 迁移内存索引
                            queue.pendingShifts.delete(oldMsgId);
                            queue.pendingShifts.set(newMsgId, data);

                            // 2. 如果是子消息（即 data.rootId 存在），需要同步更新根消息里的 childIds 指向
                            if (data.rootId && queue.pendingShifts.has(data.rootId)) {
                                const rootData = queue.pendingShifts.get(data.rootId);
                                const index = rootData.childIds.indexOf(oldMsgId);
                                if (index !== -1) {
                                    rootData.childIds[index] = newMsgId; // 把旧 ID 替换为新 ID
                                }
                            }

                            // 3. 重新贴上表情
                            const emojis = ['👍', '👎', '🙌'];
                            // 只有原本是该组最后一个消息时才加 ✅ (这里可以根据业务逻辑判断)
                            // 简单处理：全部重新贴一遍，或者从原 data 记录状态
                            for (const emoji of emojis) {
                                void queue.addTaskToQueue(getTaskQueueKey(channelId, 'emoji'), () => bot.createReaction(channelId, newMsgId, emoji), `task-${newMsgId}-${emoji}`);
                            }
                        }
                    } catch (e) {
                        console.error('[Shift-Reissue-Error]', e);
                        throw new Error('非 Discord 平台消息重发失败');
                    }
                }
            }





            // --- 识别填班并拆分发送 ---
            ctx.middleware(async (session, next) => {
                if (!session.channelId || !session.content || session.userId === session.selfId) return;
                // --- 提取文本内容 ---
                const elements = h.parse(session.content);
                const pureText = elements
                    .map(el => {
                        if (el.type === 'text') {
                            return el.attrs.content;
                        } else {
                            return `[${el.type}]`;
                        }
                    })
                    .join('')
                    .trim();

                // --- 预检：如果没有文字内容且不包含数字，直接跳过 ---
                if (!pureText && !/\d/.test(session.content)) return next();

                const gid = getGid(session);
                const curr = await getCurrentShift(ctx, gid);
                if (!curr) return next();

                // 只有确定可能有排班信息（有数字或文字），才去加载表格数据
                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
                const { shiftTable } = row;

                // 匹配频道天数
                const dayIndex = shiftTable.shift_channels[session.channelId] ??
                    shiftTable.shift_channels[`${session.platform}:${session.channelId}`];
                if (dayIndex === undefined) return next();

                const guildMember = await session.bot.getGuildMember(session.guildId, session.userId);
                const nickname = guildMember.nick || session?.event?.member?.nick || guildMember.user.nick || session?.event?.user?.nick || session.username || guildMember.user.name || session.userId;
                const timeRegex = new RegExp(cfg.autoRecognizeRegex, 'g');
                const matches = [...session.content.matchAll(timeRegex)];

                // 构造引用内容（此时 pureText 肯定不为空，或者是包含数字的内容）

                const channelTitle = (await session.bot.getChannel(session.channelId).catch(() => ({ name: '未知' }))).name;
                const messageLink = session.platform === 'discord' ? `https://discord.com/channels/${session.guildId}/${session.channelId}/${session.messageId}` : channelTitle;

                const quoteContent = `> ${messageLink}\n> ${nickname}: \n> ${pureText.replaceAll('\n', '\n> ')}`;

                if (matches.length > 0) {
                    const userName = nickname;
                    // 用于收集当前这一组发出的子消息 ID
                    // const currentGroupIds: string[] = [];
                    // 遍历内存中所有还在等待的消息，移除它们的提交勾，防止多处提交导致冲突
                    for (const [oldMsgId, oldData] of queue.pendingShifts.entries()) {
                        if (oldData.shiftId === curr.shift_id && oldData.last) {
                            for (let targetChannel of shiftTable.manager_channels) {
                                const cleanId = targetChannel.includes(':') ? targetChannel.split(':').pop() : targetChannel;
                                // 使用 reactionQueue 异步处理，避免阻塞主流程
                                void queue.addTaskToQueue(getTaskQueueKey(cleanId, 'emoji'), async () => {
                                    // 执行前检查：如果已经被别人改过了，直接退出
                                    const currentData = queue.pendingShifts.get(oldMsgId);
                                    if (!currentData || !currentData.last) return;
                                    await session.bot.deleteReaction(cleanId, oldMsgId, '✅');
                                    const freshData = queue.pendingShifts.get(oldMsgId);
                                    if (freshData) {
                                        queue.pendingShifts.set(oldMsgId, { ...freshData, last: false });
                                    }
                                }, `delete-check-${oldMsgId}`);
                            }
                        }
                    }
                    await Promise.all(shiftTable.manager_channels.map(async (targetChannel) => {
                        try {
                            const cleanId = targetChannel.includes(':') ? targetChannel.split(':').pop() : targetChannel;
                            queue.latestVersionMap.set(`CHECK-${getTaskQueueKey(cleanId, 'emoji')}`, -1);
                            // 1. 发送根引用消息
                            const [rootId] = await queue.addTaskToQueue(
                                getTaskQueueKey(cleanId, 'message'),
                                () => session.bot.sendMessage(cleanId, quoteContent),
                                `root-${ cleanId }-${ session.messageId }`
                            ).catch(e => {
                                bdShiftLogger.error(`[Shift] 根消息发送失败:`, e.message);
                                return [null];
                            });

                            if (!rootId) return;

                            // 初始化根消息数据
                            queue.pendingShifts.set(rootId, {
                                userName,
                                dayIndex: dayIndex,
                                shiftId: curr.shift_id,
                                last: false,
                                timestamp: Date.now(),
                                childIds: [] // 稍后填充
                            });

                            const childIdsForThisRoot: string[] = [];

                            // 2. 发送各个时间段消息
                            for (let i = 0; i < matches.length; i++) {
                                const start = parseInt(matches[i][1], 10);
                                const end = parseInt(matches[i][2], 10);
                                const isLast = (i === matches.length - 1);
                                const confirmContent = session.text('auto-shift.info', {
                                    day: dayIndex + 1,
                                    userName,
                                    start,
                                    end
                                });

                                void queue.addTaskToQueue(
                                    getTaskQueueKey(cleanId, 'message'),
                                    () => session.bot.sendMessage(cleanId, confirmContent),
                                    `child-${cleanId}-${i}-${Date.now()}`
                                ).then(([sentMsgId]) => {
                                    // 只有当消息真的发出去（从队列里轮到它并执行完）后，才会进到这里
                                    if (!sentMsgId) return;

                                    // 存入内存
                                    queue.pendingShifts.set(sentMsgId, {
                                        userName,
                                        dayIndex: dayIndex,
                                        slot: { start, end, action: 'none' },
                                        shiftId: curr.shift_id,
                                        last: isLast,
                                        timestamp: Date.now(),
                                        rootId: rootId
                                    });

                                    childIdsForThisRoot.push(sentMsgId);

                                    // 2. 贴表情（进入 emoji 队列）
                                    const emojis = ['👍', '👎', '🙌'];
                                    // if (isLast) emojis.push('✅');
                                    for (const emoji of emojis) {
                                        void queue.addTaskToQueue(
                                            getTaskQueueKey(cleanId, 'emoji'),
                                            () => session.bot.createReaction(cleanId, sentMsgId, emoji),
                                            `task-${sentMsgId}-${emoji}`
                                        );
                                    }
                                    if (isLast) {
                                        void queue.addTaskToQueue(
                                            getTaskQueueKey(cleanId, 'emoji'),
                                            () => session.bot.createReaction(cleanId, sentMsgId, '✅'),
                                            `CHECK-${getTaskQueueKey(cleanId, 'emoji')}`
                                        );
                                    }
                                });
                            }

                            // 3. 将子消息 ID 关联到根消息
                            const rootData = queue.pendingShifts.get(rootId);
                            rootData.childIds = childIdsForThisRoot;
                            queue.pendingShifts.set(rootId, rootData);
                        } catch (err) {
                            bdShiftLogger.error(`[Shift] 频道处理异常:`, err);
                        }
                    }))
                } else if (/\d/.test(session.content)) {
                    // --- 没识别到填班但包含数字：提示未识别 ---
                    for (let targetChannel of shiftTable.manager_channels) {
                        const cleanId = targetChannel.includes(':') ? targetChannel.split(':').pop() : targetChannel;
                        try {
                            await session.bot.sendMessage(cleanId, session.text('auto-shift.noMatch', { quote: quoteContent }));
                        } catch (e) {
                            bdShiftLogger.error(e);
                        }
                    }
                }
                await next();
            });

            // 处理表情标记与最终提交
            // 计数器
            const forceSubmitCounter = new Map();
            ctx.on('reaction-added', async (session) => {
                if (session.userId === session.selfId) return;
                const currentPending = queue.pendingShifts.get(session.messageId);
                if (!currentPending || !currentPending.slot) return;

                const cleanId= session.channelId;
                const sid = currentPending.shiftId;

                // 在 reaction-added 监听中
                if (['👍', '👎', '🙌'].includes(session.content)) {
                    const actionMap = {
                        '👍': 'add',
                        '👎': 'del',
                        '🙌': 'skip' // 标记为跳过
                    };
                    currentPending.slot.action = actionMap[session.content];
                    bdShiftLogger.info(`[标记] ${session?.event?.user?.nick ?? session?.event?.user?.name ??session?.username } 操作 消息 ${session.messageId} 状态改为: ${currentPending.slot.action}`);
                    return;
                }

                // 提交动作
                if (session.content === '✅') {
                    const tasksByDay = new Map();
                    const messagesToRemove = [];
                    const skippedItems = [];
                    const unProcessedItems = [];
                    let hasUnprocessed = false;

                    // 第一遍扫描：合法性检查
                    for (const [msgId, data] of queue.pendingShifts.entries()) {
                        // 只检查同一个班表项目下的任务
                        if (data.shiftId === sid) {
                            if (!data.slot) continue;
                            const desc = `${data.userName} ${data.dayIndex + 1}日目 ${data.slot.start}-${data.slot.end}`;

                            if (data.slot.action === 'none') {
                                hasUnprocessed = true;
                                unProcessedItems.push(`- [${session.text('auto-shift.unprocessed') || '未处理'}] ${desc}`);
                                continue;
                            }

                            messagesToRemove.push(msgId);
                            const action = data.slot.action;
                            if (action === 'skip') {
                                skippedItems.push(`- [${session.text('auto-shift.skip')}] ${desc}`);
                            } else if (action === 'add' || action === 'del') {
                                if (!tasksByDay.has(data.dayIndex)) tasksByDay.set(data.dayIndex, []);
                                tasksByDay.get(data.dayIndex).push({ msgId, ...data });
                            }
                        }
                    }

                    // --- 强制提交逻辑检测 ---
                    let count = (forceSubmitCounter.get(sid) || 0) + 1;
                    forceSubmitCounter.set(sid, count);

                    // --- 如果有没点的，直接拦截并提示 ---
                    if (hasUnprocessed && count < 3) {
                        await session.bot.sendMessage(cleanId, session.text('auto-shift.failed'));
                        return;
                    }

                    // --- 执行处理逻辑 ---
                    const results = [];
                    // 只有当确实有 add/del 任务时，才执行数据库操作
                    if (tasksByDay.size > 0) {
                        const row = await loadShift(ctx, sid, cfg.googleAuth);
                        const { shiftTable } = row;
                        await shiftTable.pull();

                        for (const [dayIndex, tasks] of tasksByDay.entries()) {
                            for (const task of tasks) {
                                const actionText = session.text(`auto-shift.${task.slot.action}`);

                                if (task.slot.action === 'add') {
                                    await shiftTable.addShift(dayIndex, task.slot.start, task.slot.end, task.userName, true);
                                } else {
                                    await shiftTable.delShift(dayIndex, task.slot.start, task.slot.end, task.userName, true);
                                }
                                // 记录 add/del 的结果
                                results.push(`- [${actionText}] ${task.userName} ${dayIndex + 1}日目 ${task.slot.start}-${task.slot.end}`);
                            }
                            await shiftTable.pushDay(dayIndex);
                        }
                        await saveShift(ctx, row);
                    }
                    results.push(...skippedItems);
                    // 如果是强制提交(count >= 3)，清理该 shiftId 下的所有消息，防止幽灵残留
                    if (count >= 3) {
                        for (const [msgId, data] of queue.pendingShifts.entries()) {
                            if (data.shiftId === sid) queue.pendingShifts.delete(msgId);
                        }
                        results.push(...unProcessedItems); // 把未处理的项也列出来，提示用户哪些没处理
                        results.push(session.text('auto-shift.force-cleaned')); // 提示已强制清理
                    } else {
                        // 正常清理：只删除本次处理了的消息
                        messagesToRemove.forEach(id => queue.pendingShifts.delete(id));
                    }
                    // 重置计数器
                    forceSubmitCounter.delete(sid);

                    if (results.length > 0) {
                        const summary = session.text('auto-shift.finish', { results: results.join('\n') });
                        await session.bot.sendMessage(session.channelId, summary);
                    }
                }
            });
        }
    }

    //车速定时功能
    if (cfg.openSpeedTracker) {
        // 1. 开启推送指令
        ctx.command('interval-speed-on [server:string]')
            .alias('开启车速定时推送')
            .option('player', '-p <player> 比对玩家')
            .action(async ({ session, options }, server) => {
                if (!session.channelId) return session.text('.notInChannel');

                // 检查是否已开启
                const [nowTracker] = await ctx.database.get('bangdream_speed_tracker', { group_gid: session.cid });
                if (nowTracker) return session.text('.alreadyOn');

                // 确定服务器
                let mainServer = cfg.defaultServer;
                if (server) {
                    const fuzzy = await serverNameFuzzySearchResult(ctx, cfg, server);
                    if (fuzzy === -1) return session.text('noMatchServer');
                    mainServer = fuzzy;
                }

                // 获取当前活动信息
                const events = await readJson(ctx, `${BestdoriAPI}/events/all.5.json`);
                const now = Date.now();
                const eventEntry = Object.entries(events).reverse().find(([_, v]) => {
                    const start = +v?.['startAt']?.[mainServer], end = +v?.['endAt']?.[mainServer];
                    return start < now && now < end;
                });

                if (!eventEntry) return session.text('noEvent');

                const [_eventId, value] = eventEntry;
                const trackerData = {
                    group_gid: session.cid,
                    tracker: {
                        trackerPlayer: options.player,
                        mainServer,
                        deadlineStamp: +value['endAt'][mainServer]
                    }
                };

                await ctx.database.create('bangdream_speed_tracker', trackerData);
                return session.text('.success', {
                    server: ['jp', 'en', 'tw', 'cn', 'kr'][mainServer],
                    player: options.player ?? 'null'
                });
            });

        // 2. 关闭推送指令
        ctx.command('interval-speed-off')
            .alias('关闭车速定时推送')
            .action(async ({ session }) => {
                if (!session.channelId) return session.text('.noChannel');
                await ctx.database.remove('bangdream_speed_tracker', { group_gid: session.cid });
                return session.text('.success');
            });

        // 3. 定时任务逻辑：使用 ctx.setTimeout 配合整点对齐
        const alignToHour = () => {
            const now = Date.now();
            const delay = 3600000 - (now % 3600000); // 距离下一个整点的毫秒数

            ctx.setTimeout(async () => {
                await executeTask();
                alignToHour(); // 递归调用保持整点对齐
            }, delay);
        };

        alignToHour();

        async function executeTask() {
            const rows = await ctx.database.get('bangdream_speed_tracker', {});
            const now = Date.now();

            for (const row of rows) {
                const { tracker, group_gid } = row;
                // 过期自动清理
                if (now > tracker.deadlineStamp) {
                    await ctx.database.remove('bangdream_speed_tracker', { group_gid });
                    continue;
                }
                // 获取数据并推送
                try {
                    const list = await commandTopRateRanking(cfg, tracker.mainServer, 60, undefined, tracker.trackerPlayer);
                    await ctx.broadcast([group_gid], paresMessageList(list));
                } catch (e) {
                    ctx.logger('speed-tracker').error(e);
                }
            }
        }
    }
    if (cfg.test) {
        if (cfg.test.test1) {
            ctx.command('test [param1:text]')
                .alias('test')
                .action(async ({ session }, param1) => {
                    console.log(await session.bot.getGuildMember(session.guildId, session.userId));
                    // await session.send('测试成功');
                });
        }

        if (cfg.test.test2) {
            ctx.command('test2 [param1:text]')
                .alias('test2')
                .action(async ({ session }, param1) => {
                    console.log(param1)
                    // await session.send('测试成功2');
                });
        }
    }

    if (cfg.enableDataRepair){

        const logger = ctx.logger('bangdream-shift/repair');
        logger.info('开始扫描旧版班表数据...');

        // 1. 获取所有班表记录
        const records = await ctx.database.get('bangdream_shift', {});
        let fixedCount = 0;

        for (const record of records) {
            const raw = record.shiftTable as unknown as LegacyShiftTableSchema;

            // 2. 识别标志位：如果存在 _eventStartTime，说明是旧版
            if (raw._eventStartTime || raw._eventEndTime) {
                try {
                    // 3. 执行结构转换
                    const upgraded: ShiftTableSchema = {
                        // 基础时间映射
                        eventStartTime: raw.eventStartTime ?? raw._eventStartTime ?? "",
                        eventEndTime: raw.eventEndTime ?? raw._eventEndTime ?? "",
                        timezone: raw.timezone ?? raw._timezone ?? "Asia/Tokyo",

                        // gParams 补位
                        gParams: raw.gParams ?? undefined,

                        // 表格数据透传
                        shift_table: raw.shift_table ?? [],
                        member_table: raw.member_table ?? {},
                        shiftExchange: raw.shiftExchange ?? [],

                        // 频道配置补位
                        manager_channels: raw.manager_channels ?? [],
                        shift_channels: raw.shift_channels ?? {}
                    };

                    // 4. 更新回数据库（绕过实例，直接存入清洗后的纯对象）
                    await ctx.database.set('bangdream_shift', { id: record.id }, {
                        shiftTable: upgraded as any
                    });

                    fixedCount++;
                } catch (e) {
                    logger.error(`修复记录 ${record.id} 失败:`, e);
                }
            }
        }

        if (fixedCount > 0) {
            logger.success(`成功修复 ${fixedCount} 条旧版班表数据！请记得在配置中关闭修复模式。`);
        } else {
            logger.info('未发现需要修复的旧版数据。');
        }
    }


    async function autoLoadShift(session: Session) {
        const curr = await getCurrentShift(ctx, getGid(session));
        if (!curr) return;
        const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
        if (!row) return;
        return row;
    }
}
