import {Context, Schema, Session} from 'koishi'
import * as utils from "./utils";
import {HourColor, ShiftTable} from "./shift";
import {} from 'koishi-plugin-puppeteer'
import {} from '@koishijs/plugin-adapter-discord'

export const name = 'bangdream-shift'
export const using = ['puppeteer','database'] as const


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
    is_manager: boolean,
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

    ctx.model.extend('bangdream_shift', {
        id: 'unsigned',
        name: 'string',
        shiftTable: 'json',
    }, {primary: 'id', autoInc: true});

    ctx.model.extend('bangdream_shift_group', {
        gid: 'string',
        shift_id: 'unsigned',
        using: 'boolean',
        is_manager: 'boolean'
    }, {primary: ['gid', 'shift_id']});

    ctx.model.extend('bangdream_speed_tracker', {
        group_gid: 'string',
        tracker: 'json',
    }, {primary: 'group_gid'})

    //班表功能
    if (cfg.openShift){
        // 创建班表，名字不能和已有的重复
        ctx.command('create-shift <name:string> 班表名称 <start:string> 开始时间 <end:string> 结束时间')
            .usage('create-shift 315真里歌 20251210150000 20251219205959')
            .action(async ({ session }, name, start, end) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!start || !end) return session.text('lack', { params: 'start/end' });
                if (!name) return session.text('lack', { params: 'name' });

                let startTs: string,endTs: string;
                try {
                    const nearestStart = roundToNearestHour(start);
                    const nearestEnd   = roundToNearestHour(end);  // 最终结束时间是整点前1ms
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
                    is_manager: true,
                })

                return session.text('.success',{ name: name })
            });

        ctx.command('remove-shift <name:string>')
            .action(async ({ session }, name) => {
                if (!name) return session.text('lack', { params: 'name' });

                // 查找班表
                const table = await ctx.database.get('bangdream_shift', { name })
                if (!table.length) {
                    return session.text('.noShift');
                }

                const shift = table[0]

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

        ctx.command('set-shift-ending <end:string> 结束时间>')
            .action(async ({ session }, end) => {
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
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return '请提供班表名！'

                // 查询该群所有班表
                const groupShift = await ctx.database.get('bangdream_shift_group', { gid: getGid(session) })
                const groupShiftIds = groupShift.map(gs => gs.shift_id)

                // 查询班表id
                const shift = await ctx.database.get('bangdream_shift', { name })
                const shift_id = shift.at(0)?.id;
                if (!shift?.length || !groupShiftIds.includes(shift_id)) return `无法使用班表 ${name}`
                // 先把当前群的所有班表 using = false
                await ctx.database.set('bangdream_shift_group', { gid: getGid(session) }, { using: false })
                // 把指定班表设为使用中
                await ctx.database.set('bangdream_shift_group', { gid: getGid(session), shift_id: shift_id }, { using: true })

                return `已切换到班表 "${shift.at(0)?.name}"`
            })


        ctx.command('add-shift <person:string> 玩家名 <day:number> 天数，从1开始计 <startHour:number> 开始小时时刻 <endHour:number> 结束小时时刻')
            .action(async ({ session }, person, day, startHour, endHour) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) return session.text('缺少参数，用法：\nadd_shift <person:string> 玩家名 <day:number> 天数，从1开始计 <startHour:number> 开始小时时刻 <endHour:number> 结束小时时刻');
                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager');

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                const ok = row.shiftTable.addShift(day - 1, startHour, endHour, person)

                await saveShift(ctx, row)

                return ok ? session.text('.success', { person, day, startHour, endHour }) : session.text('.conflict')
            });

        ctx.command('del-shift <person:string> 人员姓名 <day:number> 天数，从1开始计 <startHour:number> 开始小时时刻 <endHour:number> 结束小时时刻')
            .action(async ({ session }, person, day, startHour, endHour) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!person || !day || startHour === undefined || endHour === undefined) return session.text('缺少参数，用法：\ndel_shift <person:string> 玩家名 <day:number> 天数，从1开始计 <startHour:number> 开始小时时刻 <endHour:number> 结束小时时刻');
                const curr = await getCurrentShift(ctx, getGid(session));
                if (!curr) return session.text('noGroups');

                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager');

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 删除逻辑
                const hours = row.shiftTable.removeShift(
                    day - 1, startHour, endHour, person
                )

                await saveShift(ctx, row);

                return session.text('.success', { person, day, startHour, endHour })
            });

        ctx.command('exchange-shift <oldName:string> 被替换的人员名字 <newName:string> 进行替换的人员名字 <day:number> 天数，从1开始计 <start:number> 开始小时时刻 <end:number> 结束小时时刻')
            .action(async ({ session }, oldName, newName, day, startHour, endHour) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager')

                const row = await loadShift(ctx, curr.shift_id);
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // 替换逻辑
                const removed = row.shiftTable.removeShift(
                    day - 1, startHour, endHour, oldName
                )
                removed.forEach(hour => {
                    row.shiftTable.addShift(day - 1, hour, hour + 1, newName)
                })

                await saveShift(ctx, row)

                return session.text('.success', { day, startHour, endHour, oldName, newName })
            });

        ctx.command('set-runner <name:string> <ranking:string>', '设置人员身份')
            .action(async ({ session }, name, ranking) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name || !ranking) return session.text('lack',{ params: 'name/ranking' });
                const validRankings = ['main', '10', '50', '100', '1000'];
                if (!validRankings.includes(ranking)) return session.text('.invalidRanking', { validRankings: validRankings.join(',') });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');
                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager')

                const row = await loadShift(ctx, curr.shift_id)
                row.shiftTable.setRanking(name, ranking as any);

                await saveShift(ctx, row)

                return session.text('.success', { name,ranking });
            });

        ctx.command('del-runner <name:string>', '删除人员身份')
            .action(async ({ session }, name) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                if (!name) return session.text('lack',{ params: 'name' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');
                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager')

                const row = await loadShift(ctx, curr.shift_id)

                row.shiftTable.setRanking(name, undefined);
                await saveShift(ctx, row)
                return session.text('.success', { name });
            });

        //返回图片
        ctx.command('show-shift <day:number> 天数，从1开始计')
            .action(async ({ session }, day) => {
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');

                // puppeteer 截图
                return await row.shiftTable.renderShiftImage(ctx, day - 1)
            });

        ctx.command('show-shift-exchange <day:number> 天数，从1开始计')
            .action(async ({ session }, day) => {
                if (!day) return session.text('lack', { params: 'day' });

                const curr = await getCurrentShift(ctx, getGid(session))
                if (!curr) return session.text('noGroups');

                const row = await loadShift(ctx, curr.shift_id)
                if (day <= 0 || day > row.shiftTable.days) return session.text('outOfDay');
                // puppeteer 截图
                // console.dir(row.shiftTable.shiftExchange, {depth: null})
                return await row.shiftTable.renderShiftExchangeImage(ctx, day - 1)
            });

        /*
        显示空缺人数，相邻小时如果缺的人数一样可以合并，返回如下格式的字符串
        残り枠
        3-6 @1
        6-7 @2
        7-9 @1
        9-11 @3
        11-12 @2
        13-14 @1
        17-20 @1
        23-24 @1
         */
        ctx.command('show-shift-left <day:number> 天数，从1开始计')
            .action(async ({ session }, day) => {
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

        ctx.command('shift-my-gid')
            .action(async ({ session }) => {
                return getGid(session);
            })

        ctx.command('share-shift <shift_name:string> 表的名字 <group_gid:string> 分享群组的gid')
            .userFields(['authority'])
            .action(async ({ session }, shift_name, group_gid) => {

                if (!await canGrant(session)) return session.text('permission-denied');
                if (!shift_name || !group_gid) return session.text('lack', { params: 'shift_name/group_gid' });
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name });
                const shift_id = shift[0].id

                // 当前群必须是 manager 才能授权
                if (!await isGroupManager(ctx, getGid(session), shift_id))
                    return session.text('notManager')

                // 给指定群绑定管理权限
                await ctx.database.create('bangdream_shift_group', {
                    gid: group_gid,
                    shift_id,
                    using: false,
                    is_manager: false,
                })

                return session.text('.success', { group_gid, shift_name });
            });

        // 列出可管理的群
        ctx.command('shift-group-ls <shift_name:string> 班表名称')
            .action(async ({ session }, shift_name) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name });
                const shift_id = shift[0].id

                if (!await isGroupManager(ctx, getGid(session), shift_id))
                    return session.text('notManager')

                const groups = await ctx.database.get('bangdream_shift_group', { shift_id })
                if (!groups.length) return session.text('.noGroups');
                return groups.map(g => `${g.gid} ${g.using ? '(*)' : ''}`).join('\n')
            })

        // 撤销某群管理权限
        ctx.command('revoke-shift <shift_name:string> 班表名称 <group_gid:string> 群号')
            .action(async ({ session }, shift_name, group_gid) => {
                if (!await canGrant(session)) return session.text('permission-denied');
                const shift = await ctx.database.get('bangdream_shift', { name: shift_name })
                if (!shift[0]) return session.text('.noShift', { shift_name });
                const shift_id = shift[0].id

                if (!await isGroupManager(ctx, getGid(session), shift_id))
                    return session.text('notManager')

                await ctx.database.remove('bangdream_shift_group', { gid: group_gid, shift_id })
                return session.text('.success', { group_gid, shift_name })
            })

        ctx.command('set-shift-color <day:number> 天数，从1开始计 <start:number> 开始小时时刻 <end:number> 结束小时时刻 <color:string> 颜色，可选none、gray和black')
            .action(async ({ session }, day, start, end, color:HourColor) => {
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

                if (!await isGroupManager(ctx, getGid(session), curr.shift_id))
                    return session.text('notManager')

                const row = await loadShift(ctx, curr.shift_id)

                row.shiftTable.setShiftColor(
                    day - 1,
                    start,
                    end,
                    color
                )

                await saveShift(ctx, row)

                return session.text('.success', { start, end, color })
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
 * 检查该群是否是该班表的 manager
 */
async function isGroupManager(ctx: Context, gid: string, shift_id: number) {
    const record = await ctx.database.get('bangdream_shift_group', {
        gid,
        shift_id,
    })
    return record[0]?.is_manager ?? false
}

/**
 * 检查用户权限（用户 authority > 5 才能授权）
 */
async function canGrant(session) {
    // 获取 session.event.member.roles 和 session.author.roles
    const eventMemberRoles = session.event.member?.roles || [];
    const authorRoles = session.author.roles || [];
    // 合并两个角色列表并去重
    const roles = Array.from(new Set([...eventMemberRoles, ...authorRoles]));
    // 检查是否有所需角色
    if (session.discord){
        const ownerId = (await session.discord.getGuild(session.guildId)).owner_id;
        if (session.userId === ownerId) return true;
        const ADMIN = 8;
        const dcRoles = (await session.discord.getGuildRoles(session.guildId)).filter((r)=>(r.permissions & ADMIN) !== 0).map(r => r.id);
        const userRoles = (await session.discord.getGuildMember(session.guildId, session.userId)).roles
        if (userRoles.some((ur: string)=>dcRoles.includes(ur))) return true;
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
