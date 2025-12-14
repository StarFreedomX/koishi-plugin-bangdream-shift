import {Context, Schema, Session, Logger, h} from 'koishi'
import * as utils from "./utils";
import {HourColor, ShiftTable} from "./shift";
import {} from 'koishi-plugin-puppeteer'
import {} from '@koishijs/plugin-adapter-discord'

export const name = 'bangdream-shift'
export const using = ['puppeteer','database'] as const
export const bdShiftLogger: Logger = new Logger("bangdream-shift");


export const inject = ['database'];
declare module 'koishi' {
    interface Tables {
        bangdream_shift: bangdream_shift;
        bangdream_shift_group: bangdream_shift_group;
        bangdream_speed_tracker:bangdream_speed_tracker;
    }
}

export interface bangdream_shift {
    id: number,
    name: string,
    shiftTable: ShiftTable
}

export interface bangdream_shift_group{
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
        Schema.const(Server.kr).description('kr'),
    ]).default(Server.jp).description('默认服务器'),
    backendUrl: Schema.string().default('http://localhost:3000').description('后端服务器地址'),
})

export async function apply(ctx: Context, cfg: Config) {
    ctx.i18n.define('zh-CN', require('./locales/zh-CN'));
    ctx.i18n.define('ja-JP', require('./locales/ja-JP'));
    ctx.i18n.define('zh-TW', require('./locales/zh-TW'));

    ctx.model.extend('bangdream_shift', {
        id: 'unsigned',
        name: 'string',
        shiftTable: 'json',
    }, {primary: 'id', autoInc: true});

    ctx.model.extend('bangdream_shift_group', {
        gid: 'string',
        shift_id: 'unsigned',
        using: 'boolean',
        is_owner: {
            type: 'boolean',
            legacy: ['is_manager'],
        }
    }, {primary: ['gid', 'shift_id']});

    ctx.model.extend('bangdream_speed_tracker', {
        group_gid: 'string',
        tracker: 'json',
    }, {primary: 'group_gid'})

    //班表功能
    if (cfg.openShift){
        // 创建班表，名字不能和已有的重复
        ctx.command('create-shift <name:string> <start:string> <end:string>')
            .action(async ({ session }, name, start, end) => {
                bdShiftLogger.info(session.userId, 'try to create shift: ', name, start, end);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!start || !end) return session.text('lack', { params: 'start/end' });
                if (!name) return session.text('lack', { params: 'name' });

                let startTs: string,endTs: string;
                try {
                    const nearestStart = roundToNearestHour(start);
                    const nearestEnd   = roundToNearestHour(end);
                    [startTs, endTs] = [nearestStart, nearestEnd]
                }catch (e) {
                    if(e.message === 'Invalid Time Format'){
                        return session.text('.timeFormat')
                    }
                    return e.message;
                }
                // 创建 shiftTable 实例
                const table = new ShiftTable(startTs, endTs, cfg.defaultTimezone)

                // 插入班表
                const bangdream_shift = await ctx.database.create('bangdream_shift', {
                    name: name,
                    shiftTable: table,
                })
                // 当前群绑定该表
                // 先把当前群所有班表置为未使用
                await ctx.database.set('bangdream_shift_group', { gid: getGid(session) }, { using: false })

                // 当前群绑定该表
                await ctx.database.create('bangdream_shift_group', {
                    gid: getGid(session),
                    shift_id: bangdream_shift.id,
                    using: true,
                    is_owner: true,
                })

                return session.text('.success',{ name: name })
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
                    shift_id: shift.id,
                })

                // 删除班表本体
                await ctx.database.remove('bangdream_shift', {
                    id: shift.id,
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
                }catch (e) {
                    if(e.message === 'Invalid Time Format'){
                        return session.text('.timeFormat')
                    }
                    return e.message;
                }
                const row = await loadShift(ctx, curr.shift_id)
                row.shiftTable.setEndTime(endTs)
                return session.text('.success', { name: name })
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

                return shifts.map(s => `[${using.includes(s.id)?"*":" "}] ${s.name}`).join('\n')


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
                await ctx.database.set('bangdream_shift_group', { gid: getGid(session), shift_id: shift_id }, { using: true })

                return session.text('.success', { name })
            })

        ctx.command('add-shift <person:string> <day:number> <startHour:number> <endHour:number> [startHour2:number] [endHour2:number] [startHour3:number] [endHour3:number] [startHour4:number] [endHour4:number] [startHour5:number] [endHour5:number]')
            .action(async ({ session }, person, day, startHour, endHour, startHour2, endHour2, startHour3, endHour3, startHour4, endHour4, startHour5, endHour5) => {
                bdShiftLogger.info(session.userId, 'try to add shift: ', person, day,
                    ...[[startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5]].filter(([s,t])=>s!==undefined || t!==undefined),
                );

                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) {
                    return session.text('lack', { params: 'person/day/startHour/endHour' });
                }

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5],
                ].filter(([s, e]) => s !== undefined && e !== undefined && s < e) as [number, number][];
                if (!segments?.length) return session.text('.errorTime');
                // 用于汇总成功/失败的小时
                let allSuccess: number[] = [];
                let allFailed: number[] = [];

                // 逐段插入
                for (const [s, e] of segments) {
                    const { success, failed } = row.shiftTable.addShift(day - 1, s, e, person);
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
                        [startHour5, endHour5]].filter(([s,t])=>s!==undefined || t!==undefined)
                );

                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) {
                    return session.text('lack', { params: 'person/day/startHour/endHour' });
                }

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5],
                ].filter(([s, e]) => s < e && s !== undefined && e !== undefined) as [number, number][];

                if (!segments?.length) return session.text('.errorTime');

                const allRemoved = new Set<number>();

                // 逐段删除
                for (const [s, e] of segments) {
                    const removed = row.shiftTable.delShift(day - 1, s, e, person);
                    removed.forEach(h => allRemoved.add(h));
                }

                await saveShift(ctx, row);

                const removedRanges = hoursToRanges([...allRemoved]);

                if (!removedRanges.length) {
                    return session.text('.fail', { person, day, hourRange: segments.map(([s, e]) => `${s}-${e}`).join(' ') });
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
                        [startHour5, endHour5]].filter(([s,t])=>s!==undefined || t!==undefined)
                );

                if (!await canGrant(session)) return session.text('permission-denied');

                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 收集所有时间段
                const segments: [number, number][] = [
                    [startHour, endHour],
                    [startHour2, endHour2],
                    [startHour3, endHour3],
                    [startHour4, endHour4],
                    [startHour5, endHour5],
                ].filter(([s, e]) => s !== undefined && e !== undefined && s < e) as [number, number][];
                if (!segments?.length) return session.text('.errorTime');
                // 用于汇总成功/失败的小时
                let allSuccess: number[] = [];
                let allFailed: number[] = [];

                // 逐段替换
                for (const [s, e] of segments) {
                    const { success, failed } = row.shiftTable.exchangeShift(day - 1, s, e, oldName, newName);
                    allSuccess.push(...success);
                    allFailed.push(...failed);
                }

                await saveShift(ctx, row);

                // 转成连续区间
                const successRanges = hoursToRanges(allSuccess);
                const failedRanges = hoursToRanges(allFailed);

                const msg: string[] = [];

                if (successRanges.length) {
                    msg.push(session.text('.success', { day, fromPerson: oldName, toPerson: newName, hourRange: successRanges.join(' ') }));
                }

                if (failedRanges.length) {
                    msg.push(session.text('.fail', { day, toPerson: newName, hourRange: failedRanges.join(' ') }));
                }

                return msg.length ? msg.join('\n') : session.text('.noShift');
            });

        ctx.command('set-runner <name:string> <ranking:string>')
            .action(async ({ session }, name, ranking) => {
                bdShiftLogger.info(session.userId, 'try to set runner: ', name, ranking);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name || !ranking) return session.text('lack',{ params: 'name/ranking' });
                const validRankings = ['main', '10', '50', '100', '1000'];
                if (!validRankings.includes(ranking)) return session.text('.invalidRanking', { validRankings: validRankings.join(',') });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)
                row.shiftTable.setRanking(name, ranking as any);

                await saveShift(ctx, row)

                return session.text('.success', { name,ranking });
            });

        ctx.command('del-runner <name:string>')
            .action(async ({ session }, name) => {
                bdShiftLogger.info(session.userId, 'try to del runner: ', name);
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return session.text('lack',{ params: 'name' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)

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

                const row = await loadShift(ctx, curr.shift_id);

                row.shiftTable.renamePerson(oldName, newName);

                await saveShift(ctx, row)

                return session.text('.success', { oldName, newName });
            })

        ctx.command('show-shift <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                const image = await row.shiftTable.renderShiftImage(ctx, day - 1);
                console.log(image.slice(0,100))
                // puppeteer 截图
                return session.text('.success', {
                    day: day,
                }) + image;
            });

        ctx.command('show-shift-exchange <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift exchange: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');
                // puppeteer 截图
                // console.dir(row.shiftTable.shiftExchange, {depth: null})
                const image = await row.shiftTable.renderShiftExchangeImage(ctx, day - 1);
                // puppeteer 截图
                return session.text('.success', {
                    day: day,
                }) + image;
            });

        ctx.command('show-shift-left <day:number>')
            .action(async ({ session }, day) => {
                bdShiftLogger.info(session.userId, 'try to show shift left: ', day);
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id);
                const missingCount = row.shiftTable.getMissingCount(day - 1);
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
                    is_owner: false,
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
            .action(async ({ session }, day, start, end, color:HourColor) => {
                bdShiftLogger.info(session.userId, 'try to set shift color: ', day, start, end, color);
                if (!await canGrant(session)) return session.text('permission-denied');
                const validColors: HourColor[] = ['none', 'gray', 'black', 'invalid']

                // 参数检查
                if (!day) return session.text('lack', { params: 'day' });
                if (start == null || end == null) return session.text('lack', { params: 'start/end' });
                if (!color) return session.text('lack', { params: 'color' });

                // 颜色校验
                if (!validColors.includes(color as HourColor)) {
                    return session.text('.invalidColors', { validColors: validColors.join(' / ')});
                }
                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups')

                const row = await loadShift(ctx, curr.shift_id)

                row.shiftTable.setShiftColor(
                    day - 1,
                    start,
                    end,
                    color
                )

                await saveShift(ctx, row)

                return session.text('.success', { day, start, end, color })
            });

    }

    //车速定时功能
    if (cfg.openSpeedTracker) {
        ctx.command('interval-speed-on [server:string]')
            .alias('开启车速定时推送')
            .option('player', '-p <player> 比对玩家')
            .action(async ({session, options}, server) => {
                if (!session.channelId) return session.text('.notInChannel');
                const nowTracker = await ctx.database.get('bangdream_speed_tracker', {group_gid: session.cid});
                if (nowTracker?.length) return session.text('.alreadyOn');
                let mainServer: Server;
                if (server) {
                    const serverFromServerNameFuzzySearch = await utils.serverNameFuzzySearchResult(ctx, cfg, server)
                    if (serverFromServerNameFuzzySearch == -1) {
                        return session.text('noMatchServer');
                    }
                    mainServer = serverFromServerNameFuzzySearch;
                } else {
                    mainServer = cfg.defaultServer
                }
                let eventInfo: { eventId: string, startAt: number, endAt: number } = undefined;
                const now = Date.now()
                for (const [key, value] of Object.entries(await utils.readJson(ctx, `${BestdoriAPI}/events/all.5.json`)).reverse()) {
                    const start = +(value?.['startAt']?.[mainServer])
                    const end = +(value?.['endAt']?.[mainServer])
                    if (start < now && now < end) {
                        eventInfo = {eventId: key, startAt: start, endAt: end}
                        break;
                    }
                }
                if (!eventInfo) {
                    return session.text('noEvent');
                }
                const trackerData = {
                    group_gid: session.cid,
                    tracker: {
                        trackerPlayer: options.player,
                        mainServer: mainServer,
                        deadlineStamp: eventInfo.endAt,
                    },
                }
                await ctx.database.create('bangdream_speed_tracker', trackerData)
                return session.text('.success', {
                    server: ['jp', 'en', 'tw', 'cn', 'kr'][trackerData.tracker.mainServer],
                    player: trackerData.tracker.trackerPlayer ?? 'null'
                })
            });

        ctx.command('interval-speed-off')
            .alias('关闭车速定时推送')
            .action(async ({session}) => {
                if (!session.channelId) return session.text('.noChannel');
                await ctx.database.remove('bangdream_speed_tracker', {group_gid: session.cid})
                return session.text('.success')
            })

        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setMinutes(0, 0, 0);
        nextHour.setHours(now.getHours() + 1);
        const delayToNextHour = nextHour.getTime() - now.getTime();
        setTimeout(() => {
            executeTask();
            const interval = setInterval(() => {
                executeTask();
            }, 3600 * 1000); // 每小时执行一次
            ctx.on('dispose', () => {
                clearInterval(interval);
            })
        }, delayToNextHour);
        async function executeTask() {
            const rows = await ctx.database.get('bangdream_speed_tracker', {})
            for (const row of rows) {
                const trackerInfo: speedIntervalTracker = row.tracker;
                if (Date.now() > trackerInfo.deadlineStamp) {
                    await ctx.database.remove('bangdream_speed_tracker', {group_gid: row.group_gid})
                }
                const list = await utils.commandTopRateRanking(cfg, trackerInfo.mainServer, 60, undefined, trackerInfo.trackerPlayer)
                await ctx.broadcast([row.group_gid], utils.paresMessageList(list))
            }
        }
    }

}

/**
 * 找到当前群正在使用的班表（shift_id）
 */
async function getCurrentShift(ctx: Context, gid: string) {
    const record = await ctx.database.get('bangdream_shift_group', {
        gid,
        using: true,
    })
    return record[0] || null
}

/**
 * 根据 shift_id 加载 ShiftTable 实例
 */
async function loadShift(ctx: Context, shift_id: number): Promise<bangdream_shift | null> {
    const data = await ctx.database.get('bangdream_shift', { id: shift_id })
    if (!data[0]) return null;

    const row = data[0];
    // 反序列化 shiftTable
    row.shiftTable = Object.assign(new ShiftTable('2025121100', '2025121900'), row.shiftTable);
    return row;
}

/**
 * 保存 ShiftTable 实例
 */
async function saveShift(ctx: Context, row: bangdream_shift) {
    // koishi 的 json 字段自动序列化
    await ctx.database.set('bangdream_shift', { id: row.id }, {
        name: row.name,
        shiftTable: row.shiftTable,
    })
}

/**
 * 检查该群是否是该班表的 owner
 */
async function isShiftOwner(ctx: Context, gid: string, shift_id: number) {
    const record = await ctx.database.get('bangdream_shift_group', {
        gid,
        shift_id,
    })
    return record[0]?.is_owner ?? false
}

/**
 * 检查用户权限
 */
async function canGrant(session) {
    // 单人作用域不需要区分管理身份
    if (!session.guildId) return true;
    // 获取 session.event.member.roles 和 session.author.roles
    const eventMemberRoles = session.event.member?.roles || [];
    const authorRoles = session.author.roles || [];
    // 合并两个角色列表并去重
    const roles = Array.from(new Set([...eventMemberRoles, ...authorRoles]));
    // 检查是否有所需角色
    if (session.discord){
        const ownerId = (await session.discord.getGuild(session.guildId)).owner_id;
        if (session.userId === ownerId) return true;
        const MANAGER_NUMBERS = [8,32];
        const dcManagerRoles = (await session.discord.getGuildRoles(session.guildId))
            .filter((r)=>
                MANAGER_NUMBERS.some(n=>
                    (r.permissions & n) !== 0
                )
            ).map(r => r.id);
        const userRoles = (await session.discord.getGuildMember(session.guildId, session.userId)).roles
        if (userRoles.some((ur: string)=>dcManagerRoles.includes(ur))) return true;
    }
    const hasRequiredRole = roles.includes('admin') || roles.includes('owner');
    // 检查用户是否有足够的权限：authority > 1 或者角色是 admin 或 owner
    return session.user.authority > 1 || hasRequiredRole;
}

function getGid(session: Session) {
    return session.guild ? session.gid : session.uid
}

function roundToNearestHour (str: string): string {
    if (!/^\d{10}$/.test(str) && !/^\d{12}$/.test(str) && !/^\d{14}$/.test(str)) {
        throw new Error('Invalid Time Format')
    }

    const year = str.slice(0, 4);
    const month = str.slice(4, 6);
    const day = str.slice(6, 8);
    let hour = Number(str.slice(8, 10));

    const minute = str.length >= 12 ? Number(str.slice(10, 12)) : 0;
    const second = str.length === 14 ? Number(str.slice(12, 14)) : 0;

    // 四舍五入规则
    const shouldRoundUp = minute > 30 || (minute === 30 && second >= 30);

    if (!shouldRoundUp) {
        return `${year}${month}${day}${String(hour).padStart(2, "0")}`;
    }

    // 需要进位
    if (++hour < 24) {
        return `${year}${month}${day}${String(hour).padStart(2, "0")}`;
    }

    // 构造一个 JS Date
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    d.setDate(d.getDate() + 1);

    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, "0");
    const D = String(d.getDate()).padStart(2, "0");

    return `${Y}${M}${D}00`;
}

function hoursToRanges(hours: number[]): string[] {
    if (!hours.length) return [];

    hours = [...hours].sort((a, b) => a - b);
    const result: string[] = [];

    let start = hours[0];
    let prev = hours[0];

    for (let i = 1; i < hours.length; i++) {
        const h = hours[i];
        if (h === prev + 1) {
            // 连续
            prev = h;
        } else {
            // 输出前一段（结束小时 +1）
            result.push(`${start}-${prev + 1}`);
            start = h;
            prev = h;
        }
    }

    // 最后一段
    result.push(`${start}-${prev + 1}`);

    return result;
}
