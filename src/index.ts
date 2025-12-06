import {Context, Schema} from 'koishi'
import * as utils from "./utils";
import {ShiftTable} from "./shift";

export const name = 'bangdream-shift'

export const inject = ['database'];
declare module 'koishi' {
    interface Tables {
        bangdream_shift: bangdream_shift;
    }
}

export interface bangdream_shift {
    id: number,
    group_gid: string,
    type: 'tracker' | 'shiftTable',
    tracker: speedIntervalTracker,
    shiftTable: ShiftTable
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
    defaultServer: Server,
    backendUrl: string,
}

export enum Server {
    jp, en, tw, cn, kr
}

export const Config = Schema.object({
    openSpeedTracker: Schema.boolean().default(false).description('允许群聊开启定时查询车速'),
    openShift: Schema.boolean().default(false).description('开启班表管理功能').hidden(),
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
    ctx.model.extend('bangdream_shift', {
        id: 'unsigned',
        group_gid: 'string',
        type: 'string',
        tracker: 'json',
        shiftTable: 'json'
    }, {primary: 'id', autoInc: true})

    //班表功能
    if (cfg.openShift){

    }

    //车速定时功能
    if (cfg.openSpeedTracker) {
        ctx.command('开启车速定时推送 <server:string>')
            .option('player', '-p <player>比对玩家')
            .action(async ({session, options}, server) => {
                if (!session.guildId) return '请在群组中使用该指令'
                const nowTracker = await ctx.database.get('bangdream_shift', {group_gid: session.gid, type: 'tracker'});
                if (nowTracker?.length) return '当前已开启推送，请先删除'
                let mainServer: Server;
                if (server) {
                    const serverFromServerNameFuzzySearch = await utils.serverNameFuzzySearchResult(ctx, cfg, server)
                    if (serverFromServerNameFuzzySearch == -1) {
                        return '错误: 服务器名未能匹配任何服务器'
                    }
                    mainServer = serverFromServerNameFuzzySearch;
                } else {
                    mainServer = cfg.defaultServer
                }
                //console.log(session.guildId)
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
                    return '当前服务器无进行中的活动'
                }
                const trackerData = {
                    group_gid: session.gid,
                    type: 'tracker' as 'tracker',
                    tracker: {
                        trackerPlayer: options.player,
                        mainServer: mainServer,
                        deadlineStamp: eventInfo.endAt,
                    },
                    shiftTable: null,
                }
                //console.log('add to database: ', trackerData)
                await ctx.database.create('bangdream_shift', trackerData)
                return `已开启推送:
服务器: ${['jp', 'en', 'tw', 'cn', 'kr'][trackerData.tracker.mainServer]}${trackerData.tracker.trackerPlayer ? '\n追踪玩家: ' + trackerData.tracker.trackerPlayer : ''}`
            })

        ctx.command('关闭车速定时推送')
            .action(async ({session}) => {
                if (!session.guildId) return '请在群组中使用该指令'
                await ctx.database.remove('bangdream_shift', {group_gid: session.gid, type: 'tracker'})
                return '已关闭推送'
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
            const rows = await ctx.database.get('bangdream_shift', {
                type: 'tracker',
            })
            for (const row of rows) {
                const trackerInfo: speedIntervalTracker = row.tracker;
                if (Date.now() > trackerInfo.deadlineStamp) {
                    await ctx.database.remove('bangdream_shift', {group_gid: row.group_gid, type: 'tracker'})
                }
                const list = await utils.commandTopRateRanking(cfg, trackerInfo.mainServer, 60, undefined, trackerInfo.trackerPlayer)
                await ctx.broadcast([row.group_gid], utils.paresMessageList(list))
            }
        }
    }
}

