import { Context, Element, h, Session } from 'koishi'
import { bangdream_shift, Config, Server } from "./index";
import axios, { AxiosResponse } from "axios";
import { ShiftError, ShiftTable } from "./shift";
import { GoogleSheetAuth } from "./googleSheetHandler";


// 将messageList转换为Array<Element | string>  用于session.send
export function paresMessageList(list?: Array<Buffer | string>): Array<Element | string> {
    if (!list) {
        return []
    }
    let messageList = []
    for (let i = 0; i < list.length; i++) {
        parseMessage(list[i])
    }

    function parseMessage(message: Buffer | string) {
        if (typeof message === 'string') {
            messageList.push(message)
        } else if (message instanceof Buffer) {
            messageList.push(h.image(message, 'image/png'))
        }
    }

    return messageList
}

export async function serverNameFuzzySearchResult(ctx: Context, config: Config, serverNameText: string): Promise<number> {
    const result = await getFuzzySearchResult(ctx, config, serverNameText);
    if (result && result['server']) {
        return result['server'][0] as number;
    }
    return -1;
}

export async function getFuzzySearchResult(ctx: Context, config: Config, text: string): Promise<object> {
    return await getDataFromBackend(`${config.backendUrl}/fuzzySearch`, {
        text
    }, ctx);
}

export async function getDataFromBackend(url: string, data: Object, ctx: Context): Promise<object> {
    const result = await ctx.http.post(url, data)
    if (result?.data?.status != 'success') {
        return {};
    }
    return result.data.data;
}

export async function commandTopRateRanking(config: Config, mainServer: Server, time: number, compareTier?: number, compareUid?: number): Promise<Array<Buffer | string>> {
    return await getReplyFromBackend(`${config.backendUrl}/topRateRanking`, {
        mainServer,
        time,
        compareTier,
        compareUid,
        compress: true
    })
}

export async function getReplyFromBackend(url: string, data: any): Promise<Array<Buffer | string>> {
    const result: any = await sendPostRequest(url, data);
    return base64ToList(result)
}

async function sendPostRequest(url: string, data: any): Promise<Object> {
    try {
        const response: AxiosResponse = await axios.post(url, data);
        const result: any = response.data as Object;
        switch (response.status) {
            case 200:
                // 将下载的 JSON 文件转换为对象
                return result;
            case 400:
                return [{
                    type: 'string',
                    string: `错误: 请求参数错误, 可能因为版本与后端服务器版本不一致`
                }];
            case 404:
                return [{
                    type: 'string',
                    string: `错误: 无法连接至后端服务器`
                }];
            case 422:
                return [{
                    type: 'string',
                    string: `错误: 无效的请求 (${result})`
                }];
            case 500:
                return [{
                    type: 'string',
                    string: `内部错误`
                }];
            default:
                return [{
                    type: 'string',
                    string: `错误: 未知错误`
                }];
        }
    } catch (error) {
        // 在此处处理错误
        if (axios.isAxiosError(error)) {
            // 处理由 Axios 抛出的错误
            console.error('Axios Error:', error.message);
            return [{
                type: 'string',
                string: '错误: 后端服务器连接出错'
            }];
        } else {
            // 处理其他错误
            console.error('Error:', error.message);
        }
        return [{
            type: 'string',
            string: '内部错误'
        }];
    }
}

function base64ToList(basd64List: Array<{ type: 'string' | 'base64', string: string }>): Array<Buffer | string> {
    const result: Array<Buffer | string> = []
    for (let i = 0; i < basd64List.length; i++) {
        const element = basd64List[i];
        if (element.type === 'string') {
            //result.push(element.string)
            console.log(element.string);
        } else if (element.type === 'base64') {
            result.push(Buffer.from(element.string, 'base64'))
        }
    }
    return result
}

export async function readJson(ctx: Context, url: string, retryTimes = 3) {
    do {
        try {
            const json: Promise<JSON> = ctx.http.get(url, { responseType: 'json' });
            return json;
        } catch (err) {
            console.error(err);
        }
    } while (retryTimes-- > 0);
    return undefined;
}


/**
 * 找到当前群正在使用的班表记录
 */
export async function getCurrentShift(ctx: Context, gid: string) {
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
export async function loadShift(ctx: Context, shift_id: number, gAuth?: GoogleSheetAuth): Promise<bangdream_shift | null> {
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
export async function saveShift(ctx: Context, row: bangdream_shift) {
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
export async function isShiftOwner(ctx: Context, gid: string, shift_id: number) {
    const record = await ctx.database.get('bangdream_shift_group', {
        gid,
        shift_id
    })
    return record[0]?.is_owner ?? false
}

/**
 * 检查用户权限
 */
export async function canGrant(session: Session) {
    // 单人作用域直接放行
    if (!session.guildId) return true;

    // 本地权限
    // 使用 Set 提高查找效率
    const rolesSet = new Set<string>([
        ...(session.event.member?.roles || []).map(r => {
            if (typeof r === 'string') return r;
            return r.id;
        })
    ]);

    const user = await session.observeUser(['authority']);
    if (user.authority > 1 || rolesSet.has('admin') || rolesSet.has('owner')) {
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

export function getGid(session: Session) {
    return session.guild || session.event.guild ? session.gid ?? `${session.event.platform}:${session.event.guild.id}` : session.uid
}

export function getTaskQueueKey(channelId: string, type: string) {
    return `${channelId}-${type}`
}


/**
 * 解析 Discord 频道 ID (匹配字符串中最后一个 17-20 位的数字串)
 * 支持:
 * - Mention: <#1234567890123456789>
 * - URL: https://discord.com/channels/.../1234567890123456789
 * - Raw ID: 1234567890123456789
 * - Koishi Element: <sharp id="1234567890123456789"/>
 */
export function parseChannelId(input: string): string | null {
    if (!input) return null;

    // 使用全局匹配获取所有符合 ID 特征的数字串
    const matches = input.match(/\d{17,20}/g);

    // 如果有匹配项，取最后一个
    return matches ? matches[matches.length - 1] : null;
}


export function roundToNearestHour(str: string): string {
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

export function hoursToRanges(hours: number[]): string[] {
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


