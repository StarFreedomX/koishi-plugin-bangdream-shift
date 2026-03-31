import { Context, Schema, Session, Logger } from 'koishi'
import * as utils from "./utils";
import { HourColor, ShiftTable, Ranking, ShiftError, GoogleSheetOptions, GoogleSheetAuth } from "./shift";
import {} from 'koishi-plugin-puppeteer'
import {} from '@koishijs/plugin-adapter-discord'

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

export interface Config {
    openSpeedTracker: boolean,
    openShift: boolean,
    defaultTimezone: string,
    defaultServer: Server,
    backendUrl: string,
    googleAuth?: {
        client_email: string;
        private_key: string;
    };
}

export enum Server {
    jp, en, tw, cn, kr
}

export const Config = Schema.object({
    openSpeedTracker: Schema.boolean().default(false).description('允许群聊开启定时查询车速'),
    openShift: Schema.boolean().default(false).description('开启班表管理功能'),
    defaultTimezone: Schema.string().default('Asia/Tokyo'),
    defaultServer: Schema.union([
        Schema.const(Server.jp).description('jp'),
        Schema.const(Server.cn).description('cn'),
        Schema.const(Server.en).description('en'),
        Schema.const(Server.tw).description('tw'),
        Schema.const(Server.kr).description('kr')
    ]).default(Server.jp).description('默认服务器'),
    backendUrl: Schema.string().default('http://localhost:3000').description('后端服务器地址'),
    googleAuth: Schema.object({
        client_email: Schema.string().description('Google Service Account Client Email'),
        private_key: Schema.string().description('Google Service Account Private Key')
    }).description('Google Sheets认证信息')
})

export async function apply(ctx: Context, cfg: Config) {
    ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
    ctx.i18n.define('ja-JP', require('./locales/ja-JP'));
    ctx.i18n.define('zh-TW', require('./locales/zh-TW'));

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
                        const gOptions: GoogleSheetOptions = {
                            spreadsheetId: options.spreadsheetId,
                            sheetName: options.sheetName,
                            startCell: options.startCell,
                            colInterval: options.colInterval,
                            rowInterval: options.rowInterval,
                            dayInterval: options.dayInterval,
                            startHour: options.startHour,
                        };
                        table = await ShiftTable.create(startTs, endTs, cfg.defaultTimezone, gOptions, cfg.googleAuth);
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
                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');
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
                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)
                row.shiftTable.setEndTime(endTs)
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

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
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

                // 逐段插入
                for (const [s, e] of segments) {
                    const { success, failed } = await row.shiftTable.addShift(day - 1, s, e, person);
                    allSuccess.push(...success);
                    allFailed.push(...failed);
                }

                await saveShift(ctx, row);

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

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
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

                // 逐段删除
                for (const [s, e] of segments) {
                    const removed = await row.shiftTable.delShift(day - 1, s, e, person);
                    removed.forEach(h => void allRemoved.add(h));
                }

                await saveShift(ctx, row);

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

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
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

                // 逐段替换
                for (const [s, e] of segments) {
                    const { success, failed } = await row.shiftTable.exchangeShift(day - 1, s, e, oldName, newName);
                    allSuccess.push(...success);
                    allFailed.push(...failed);
                }

                await saveShift(ctx, row);

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

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
                // 校验天数范围（1 到 n）
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

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
                        const { success, failed } = await row.shiftTable.addShift(day - 1, s, e, task.person);
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

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)
                row.shiftTable.setRanking(name, ranking);

                await saveShift(ctx, row)

                return session.text('.success', { name, ranking });
            });

        ctx.command('del-runner <name:string>')
            .action(async ({ session }, name) => {
                bdShiftLogger.info(session.userId, 'try to del runner: ', name);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return session.text('lack', { params: 'name' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)

                row.shiftTable.setRanking(name, undefined);
                await saveShift(ctx, row)
                return session.text('.success', { name });
            });

        ctx.command('rename-person <oldName:string> <newName:string>')
            .action(async ({ session }, oldName, newName) => {
                bdShiftLogger.info(session.userId, 'try to rename person: ', oldName, newName);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!oldName || !newName) return session.text('lack', { params: 'oldName/newName' });
                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);

                await row.shiftTable.renamePerson(oldName, newName);

                await saveShift(ctx, row)

                return session.text('.success', { oldName, newName });
            })

        ctx.command('show-shift <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)
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

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)
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

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth);
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
                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups')

                const row = await loadShift(ctx, curr.shift_id, cfg.googleAuth)

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
                    const fuzzy = await utils.serverNameFuzzySearchResult(ctx, cfg, server);
                    if (fuzzy === -1) return session.text('noMatchServer');
                    mainServer = fuzzy;
                }

                // 获取当前活动信息
                const events = await utils.readJson(ctx, `${BestdoriAPI}/events/all.5.json`);
                const now = Date.now();
                const eventEntry = Object.entries(events).reverse().find(([_, v]) => {
                    const start = +v?.['startAt']?.[mainServer], end = +v?.['endAt']?.[mainServer];
                    return start < now && now < end;
                });

                if (!eventEntry) return session.text('noEvent');

                const [eventId, value] = eventEntry;
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
                    const list = await utils.commandTopRateRanking(cfg, tracker.mainServer, 60, undefined, tracker.trackerPlayer);
                    await ctx.broadcast([group_gid], utils.paresMessageList(list));
                } catch (e) {
                    ctx.logger('speed-tracker').error(e);
                }
            }
        }
    }

}
/**
 * 找到当前群正在使用的班表记录
 */
async function getCurrentShift(ctx: Context, gid: string) {
    const [record] = await ctx.database.get('bangdream_shift_group', {
        gid,
        using: true
    });
    return record || null;
}

/**
 * 根据 shift_id 加载并实例化 ShiftTable
 * @param ctx
 * @param shift_id
 * @param gAuth 运行时传入的 Google 服务账号密钥（不存储于数据库）
 */
async function loadShift(ctx: Context, shift_id: number, gAuth?: GoogleSheetAuth): Promise<bangdream_shift | null> {
    const [data] = await ctx.database.get('bangdream_shift', { id: shift_id });
    if (!data) return null;

    // 使用静态工厂方法还原实例
    // data.shiftTable 是数据库存的 JSON，gAuth 是内存中的实时密钥
    if (data.shiftTable) {
        data.shiftTable = ShiftTable.fromJSON(data.shiftTable as any, gAuth);
    }

    return data;
}

/**
 * 保存 ShiftTable 实例
 */
async function saveShift(ctx: Context, row: bangdream_shift) {
    /**
     * 注意：
     * 1. 因为 ShiftTable 实现了 toJSON()，Koishi 在序列化时会自动调用它。
     * 2. toJSON 内部不包含 gAuth，所以数据库里只会存下布局配置（ID/单元格等）和排班数据。
     */
    await ctx.database.set('bangdream_shift', { id: row.id }, {
        name: row.name,
        shiftTable: row.shiftTable // 这里会触发 row.shiftTable.toJSON()
    });
}
/**
 * 检查该群是否是该班表的 owner
 */
async function isShiftOwner(ctx: Context, gid: string, shift_id: number) {
    const record = await ctx.database.get('bangdream_shift_group', {
        gid,
        shift_id
    })
    return record[0]?.is_owner ?? false
}

/**
 * 检查用户权限
 */
async function canGrant(session) {
    // 单人作用域直接放行
    if (!session.guildId) return true;

    // 本地权限
    // 使用 Set 提高查找效率
    const rolesSet = new Set([
        ...(session.event.member?.roles || []),
        ...(session.author.roles || [])
    ]);

    if (session.user.authority > 1 || rolesSet.has('admin') || rolesSet.has('owner')) {
        return true;
    }

    // Discord 权限
    if (session.discord) {
        try {
            // 获取服务器信息并校验 Owner
            const guild = await session.discord.getGuild(session.guildId);
            if (session.userId === guild.owner_id) return true;

            // 权限位掩码 (使用 BigInt 确保 32 位以上也安全)
            // 1n << 3n 是 ADMINISTRATOR, 1n << 5n 是 MANAGE_GUILD
            const MANAGER_MASK = (1n << 3n) | (1n << 5n);

            // 获取服务器所有角色，筛选出具有管理权限的角色 ID 列表
            const dcManagerRoles = (await session.discord.getGuildRoles(session.guildId))
                .filter((r) => (BigInt(r.permissions) & MANAGER_MASK) !== 0n)
                .map(r => r.id);

            // 获取当前成员的角色列表
            const member = await session.discord.getGuildMember(session.guildId, session.userId);
            const userRoles = member.roles || [];

            // 检查用户角色是否包含在管理角色列表中
            if (userRoles.some((ur: string) => dcManagerRoles.includes(ur))) {
                return true;
            }
        } catch (e) {
            console.error("[Permission Check Error]:", e);
        }
    }

    return false;
}

function getGid(session: Session) {
    return session.guild ? session.gid : session.uid
}

function roundToNearestHour(str: string): string {
    if (!/^\d{10,14}$/.test(str) || str.length % 2 !== 0) throw new ShiftError("INVALID_TIME_FORMAT", 'Invalid Time Format');

    // 每 2 或 4 位切割一次：2025 | 12 | 10 | 15 ...
    const [Y, M, D, H, m, s] = (str.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?/) || [])
        .slice(1).map(v => +v || 0);
    // 逻辑：如果>=半小时，则小时 +1
    const d = new Date(Y, M - 1, D, H + Math.round(m / 60 + s / 3600));
    //格式化
    const f = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${f(d.getMonth() + 1)}${f(d.getDate())}${f(d.getHours())}`;
}

function hoursToRanges(hours: number[]): string[] {
    if (!hours.length) return [];

    // 先排序，确保逻辑正确
    const sorted = [...hours].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];

    sorted.forEach((h, i) => {
        // 如果当前小时不是下一位的连续值，或者是最后一个元素
        if (sorted[i + 1] !== h + 1) {
            ranges.push(`${start}-${h + 1}`);
            start = sorted[i + 1];
        }
    });

    return ranges;
}
