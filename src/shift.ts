/*
排班表相关类
大致结构为: ShiftTable -> shiftTable -> rows -> player

排班表交互逻辑设计：
shiftTable初始化时提供startTs: number, endTs: number, timezone: string = 'Asia/Tokyo'

填班时让名字放在同一列
注意一行只能放5人，不能多，少的用null补位确保对齐
删除方法removeShift(day: number, startHour: number, endHour: number, person: string): number[]
 */
import { Context } from "koishi";
import { GoogleSheetAuth, GoogleSheetHandler, GoogleSheetParams } from './googleSheetHandler';

export const HOUR_COLORS = ['none', 'black', 'gray', 'invalid'] as const;
export const RANKINGS = ["main", "10", "50", "100", "1000"] as const;
export const SHIFT_ERROR_CODES = ['INVALID_TIME_FORMAT', 'OUT_OF_BOUNDS'] as const;
export type HourColor = typeof HOUR_COLORS[number];
export type Ranking = typeof RANKINGS[number];
export type ShiftErrorCodes = typeof SHIFT_ERROR_CODES[number];
const SHIFT_COMPLETED_COLOR = "#696969";
const SHIFT_NOT_COMPLETE_COLOR = "#FFB6B2";
const runnerColor = {
    'main': '#B6FEFD',
    '10': '#FEED55',
    '50': '#FAC467',
    '100': '#FA6767',
    '1000': '#79FA67'
}
const SHIFT_COLORS = {
    START: '#F0FFFF',
    RUNNING: '#FFFFF0',
    END: '#FFE4E1',
    ONE_HOUR: '#F0FFF0',
    BLACK: '#000000',
    GRAY: '#B7B7B7'
}
// 必须按顺序，(前一小时有班)<<1 +(后一小时有班)*1得出的索引即为颜色
const SHIFT_PLAYER_COLORS = [SHIFT_COLORS.ONE_HOUR, SHIFT_COLORS.START, SHIFT_COLORS.END, SHIFT_COLORS.RUNNING] as const;
const SYMBOL_MAP: Record<string, string> = {
    "main": "★",
    // "10": "■",
    // "50": "●",
    // "100": "◆",
    // "1000": "▲",
    "10": " ",
    "50": " ",
    "100": " ",
    "1000": " "
};

interface HourBlock {
    hourColor: HourColor;        // 黑/灰/无
    persons: (string | null)[];
}

type DaySchedule = HourBlock[];  // 24 个小时

interface memberTable {
    [name: string]: Ranking;
}

const coverRunnerColor = false;

interface ShiftExchange {
    onDuty: string[];    // 上班的人
    offDuty: string[];   // 下班的人
}

export class ShiftTable {
    get manager_channels(): string[] { return this._manager_channels; }

    get shift_channels(): { [channelId:string]: number; } { return this._shift_channels; }

    set timezone(value: string) {this._timezone = value;}

    get eventEndTime(): string {return this._eventEndTime;}

    set eventEndTime(value: string) {
        this._eventEndTime = value;
        this._eCache = undefined;
    }

    get eventStartTime(): string {return this._eventStartTime;}

    set eventStartTime(value: string) {
        this._eventStartTime = value;
        this._sCache = undefined;
    }

    get days(): number { return this._days }

    set days(value: number) { this._days = value }

    // 统一解析逻辑：返回对象，这样 Getter 只需要访问属性，不产生二次计算
    private _parse(t: string) {
        const [y, m, d, h] = [t.slice(0, 4), t.slice(4, 6), t.slice(6, 8), t.slice(8, 10)].map(Number);
        return { year: y, month: m, day: d, hour: h };
    }

    // 缓存解析结果
    private _sCache?: ReturnType<typeof this._parse>;
    private _eCache?: ReturnType<typeof this._parse>;

    get startProperties() { return this._sCache ??= this._parse(this.eventStartTime); }

    get endProperties() { return this._eCache ??= this._parse(this.eventEndTime);}

    get startYear() { return this.startProperties.year }

    get startMonth() { return this.startProperties.month }

    get startDay() { return this.startProperties.day }

    get startHour() { return this.startProperties.hour }

    get endYear() { return this.endProperties.year }

    get endMonth() { return this.endProperties.month }

    get endDay() { return this.endProperties.day }

    get endHour() { return this.endProperties.hour }


    /** 这里day是0开始 */
    private shift_table: DaySchedule[] = []; // 行：小时，列：人员
    private member_table: memberTable = {};
    private _manager_channels: string[] = [];
    private _shift_channels: {
        [channelId:string]: number;
    } = {}
    // 换班通知配置（存频道、启用开关和语言）
    private _change_notice?: { channel?: string, enabled?: boolean, locale?: string };
    private _eventStartTime: string;
    private _eventEndTime: string;
    private _days: number; // 总天数
    private _timezone: string;
    private readonly googleSheetHandler?: GoogleSheetHandler;
    private readonly gParams?: GoogleSheetParams;
    shiftExchange: ShiftExchange[][] = []; // key: "day","hour"

    /**
     * 初始化活动班表
     * @param startTime 活动开始时间 yyyyMMddHH
     * @param endTime 活动结束时间 yyyyMMddHH
     * @param timezone (可选)指定时区，默认UTC+9
     * @param gParams (可选)Google Sheet 选项，用于构造处理器
     * @param gAuth
     */
    constructor(startTime: string, endTime: string, timezone: string = 'Asia/Tokyo', gParams?: GoogleSheetParams, gAuth?: GoogleSheetAuth) {
        // 基础格式校验 (yyyyMMddHH 长度应为 10)
        if (startTime.length !== 10 || endTime.length !== 10) {
            throw new ShiftError("INVALID_TIME_FORMAT", "Invalid time format: expected yyyyMMddHH");
        }

        this.eventStartTime = startTime;
        this.eventEndTime = endTime;
        this.timezone = timezone;
        this.gParams = gParams;
        this.googleSheetHandler = gParams ? new GoogleSheetHandler(gParams.spreadsheetId, gAuth, gParams.options) : undefined;
        this.days = this._calcDays();

        // 逻辑校验：结束时间不能早于开始时间
        if (this.days <= 0 || Number(endTime) - Number(startTime) <= 0) {
            throw new ShiftError("OUT_OF_BOUNDS", "Shift must last at least one hour");
        }

        // 表结构初始化
        this.shift_table = Array.from({ length: this.days }, () =>
            Array.from({ length: 24 }, () => ({
                hourColor: 'none',
                persons: Array(5).fill(null) // 使用 fill 保证一致性
            }))
        );

        // 初始化状态标记
        this.markInvalidHours();
    }

    static fromJSON(data: {
        eventStartTime: string,
        eventEndTime: string,
        timezone: string,
        gParams?: GoogleSheetParams,
        shift_table: DaySchedule[],
        member_table: memberTable,
        shiftExchange: ShiftExchange[][],
        manager_channels?: string[],
        shift_channels?: { [channelId:string]: number; },
        change_notice?: { channel?: string; enabled?: boolean; locale?: string }
    }, gAuth?: GoogleSheetAuth): ShiftTable {
        // 调用构造函数，触发 Handler 的初始化
        const instance = new ShiftTable(
            data.eventStartTime,
            data.eventEndTime,
            data.timezone,
            data.gParams,
            gAuth
        );

        instance.shift_table = data.shift_table || [];
        instance.member_table = data.member_table || {};
        instance.shiftExchange = data.shiftExchange || [];
        instance._manager_channels = data.manager_channels || [];
        instance._shift_channels = data.shift_channels || {};
        // 允许从持久化数据中恢复换班通知配置
        if (data.change_notice) {
            // 兼容旧版字段，但这里直接读取已声明的属性
            const cn = data.change_notice;
            instance._change_notice = { channel: cn.channel, enabled: cn.enabled, locale: cn.locale };
        }

        return instance;
    }

    toJSON() {
        return {
            eventStartTime: this.eventStartTime,
            eventEndTime: this.eventEndTime,
            timezone: this.timezone,
            gParams: this.gParams,
            shift_table: this.shift_table,
            member_table: this.member_table,
            shiftExchange: this.shiftExchange,
            manager_channels: this._manager_channels,
            shift_channels: this._shift_channels,
            change_notice: this._change_notice,
        };
    }

    /** 换班通知相关接口，存储在 ShiftTable 实例内并会被序列化到数据库 */
    setChangeNotice(channel: string, locale = 'zh-CN') {
        this._change_notice = { channel, enabled: true, locale };
    }

    deleteChangeNotice() {
        this._change_notice = undefined;
    }

    getChangeNotice(): { channel?: string, enabled?: boolean, locale?: string } | undefined {
        return this._change_notice;
    }

    private markInvalidHours() {
        // 第一天：startHour 前 invalid;最后一天：endHour 及后 invalid
        for (let h = 0; h < this.startHour; h++) this.shift_table[0][h].hourColor = "invalid";
        for (let h = this.endHour; h < 24; h++) this.shift_table[this.days - 1][h].hourColor = "invalid";
    }


    /**
     * 计算活动跨越的天数
     * @return 活动跨越的天数
     * @private
     */
    private _calcDays(): number {
        const { year: sY, month: sM, day: sD } = this.startProperties;
        const { year: eY, month: eM, day: eD } = this.endProperties;

        // 使用 Date.UTC 规避时区干扰，纯粹计算日期差
        const start = Date.UTC(sY, sM - 1, sD);
        const end = Date.UTC(eY, eM - 1, eD);
        // 864e5是一天的毫秒数
        return Math.floor((end - start) / 864e5) + 1;
    }


    /**
     * 辅助函数，解析传入的上下班时间，返回存在班表的小时数列表
     * @param dayIndex 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param onlyNone
     */
    private normalizeHour(dayIndex: number, startHour: number, endHour: number, onlyNone = true): number[] {
        // 基础转换：处理 24点/0点 的边界字面量
        let s = startHour === 24 ? 0 : startHour;
        let e = endHour === 0 ? 24 : endHour;

        // 获取当天活动范围
        const dS = dayIndex === 0 ? this.startHour : 0;
        const dE = dayIndex === this.days - 1 ? this.endHour : 24;

        // 裁切范围：取交集
        s = Math.max(s, dS);
        e = Math.min(e, dE);

        // 安全检查：如果裁切后开始时间大于等于结束时间，说明完全不在活动范围内
        if (s >= e) return [];

        // 冲突检查：在裁切后的范围内检查是否有颜色冲突
        const table = this.shift_table[dayIndex];
        if (!table) return []; // 容错处理

        const hours = Array.from({ length: e - s }, (_, i) => s + i);

        if (onlyNone && !hours.every(hIdx => table[hIdx].hourColor === 'none')) {
            return [];
        }

        return hours;
    }

    setRanking(name: string, ranking: Ranking) {
        if (!name) return;
        this.member_table[name] = ranking;
    }

    /**
     * 【手动拉取】从 Google Sheets 同步最新数据到内存
     */
    async pull(): Promise<void> {
        if (this.googleSheetHandler) {
            await this.googleSheetHandler.pull(this);
        }
    }

    /**
     * 专门给同步工具使用的接口
     */
    public setRow(dayIndex: number, hour: number, persons: (string | null)[], color: HourColor) {
        if (!this.shift_table[dayIndex] || !this.shift_table[dayIndex][hour]) return;

        // 执行赋值
        this.shift_table[dayIndex][hour].persons = [...persons];
        this.shift_table[dayIndex][hour].hourColor = color;
    }

    /**
     * 获取某单元格数据用于推送
     */
    public getRow(dayIndex: number, hour: number): HourBlock | null {
        return this.shift_table[dayIndex]?.[hour] || null;
    }

    /**
     * 【局部推送】将内存中某一天的班表同步到 Google Sheets
     * 适用于单次修改某天后的快速同步
     * @param dayIndex 第几天 (0开始)
     */
    async pushDay(dayIndex: number): Promise<void> {
        if (this.googleSheetHandler) {
            if (dayIndex < 0 || dayIndex >= this.days) return;
            await this.googleSheetHandler.pushDay(dayIndex, this);
        }
    }

    /**
     * 【全量推送】将内存中所有天的班表同步到 Google Sheets
     * 适用于批量修改、重命名、或是修改活动结束时间后的同步
     */
    async pushAllDays(): Promise<void> {
        if (this.googleSheetHandler) {
            await this.googleSheetHandler.pushAllDays(this);
        }
    }

    addManagerChannel(channelId: string) {
        if (!this._manager_channels.includes(channelId)) {
            this._manager_channels.push(channelId);
        }
    }

    deleteManagerChannel(channelId: string): boolean {
        const i = this._manager_channels.indexOf(channelId);
        if (i !== -1) {
            this._manager_channels.splice(i, 1);
            return true;
        }
        return false;
    }

    /**
     * 添加或更新频道的排班日期
     * @param channelId 频道ID
     * @param dayIndex 对应的日期索引（0开始），表示该频道显示第几天的班表
     */
    addShiftChannel(channelId: string, dayIndex: number) {
        // 直接赋值即可，如果已存在则会更新为新的 dayIndex
        this._shift_channels[channelId] = dayIndex;
    }

    /**
     * 删除指定频道的排班映射
     * @param channelId 频道ID
     * @returns 是否删除成功
     */
    deleteShiftChannel(channelId: string): boolean {
        if (channelId in this._shift_channels) {
            delete this._shift_channels[channelId];
            return true;
        }
        return false;
    }

    /**
     * 添加班表人员（返回成功/失败小时列表）
     */
    async addShift(dayIndex: number, startHour: number, endHour: number, person: string, skipSync = false): Promise<{
        success: number[],
        failed: number[]
    }> {
        if (!skipSync) await this.pull();

        const hours = this.normalizeHour(dayIndex, startHour, endHour), d = this.shift_table[dayIndex];
        const res = { success: [] as number[], failed: [] as number[] };
        if (!hours?.length) return res;

        hours.forEach(h => {
            const p = d[h].persons, idx = p.indexOf(null);
            // 判定：无空位 或 已存在该人 则失败
            if (idx === -1 || p.includes(person)) {
                res.failed.push(h);
            } else {
                p[idx] = person;
                res.success.push(h);
            }
        });

        if (res.success.length) {
            this.adjustDay(dayIndex);
            if (!skipSync) await this.pushDay(dayIndex);
        }
        return res;
    }


    /**
     * 删除班表人员（删除指定时间段内的该人员信息）
     * @param dayIndex 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param person 人名
     * @param skipSync 是否跳过自动同步
     * @return 返回该人员被删除的所有小时列表
     */
    async delShift(dayIndex: number, startHour: number, endHour: number, person: string, skipSync = false): Promise<number[]> {

        if (!skipSync) await this.pull();

        const hours = this.normalizeHour(dayIndex, startHour, endHour), d = this.shift_table[dayIndex];
        const removed: number[] = [];

        hours?.forEach(h => {
            const i = d[h].persons.indexOf(person);
            if (i !== -1) {
                d[h].persons[i] = null;
                removed.push(h);
            }
        });

        if (removed.length && !skipSync) await this.pushDay(dayIndex);

        return removed;
    }

    /**
     * 批量替换班表人员（区分成功和失败）
     * @param dayIndex 第几天（0开始）
     * @param startHour 开始小时
     * @param endHour 结束小时
     * @param fromPerson 被替换的人
     * @param toPerson 替换成的人
     * @param skipSync 是否跳过自动同步
     * @returns { success: number[], failed: number[] } 成功/失败的小时列表
     */
    async exchangeShift(dayIndex: number, startHour: number, endHour: number, fromPerson: string, toPerson: string, skipSync = false): Promise<{
        success: number[],
        failed: number[]
    }> {
        if (!skipSync) await this.pull();

        const hours = this.normalizeHour(dayIndex, startHour, endHour), d = this.shift_table[dayIndex];
        const res = { success: [] as number[], failed: [] as number[] };

        if (!hours?.length) return res;

        hours.forEach(h => {
            const p = d[h].persons;
            const i = p.indexOf(fromPerson);
            if (i === -1) return; // 该小时无此人，跳过

            // 目标人已在班则失败，否则替换索引位置并记录成功
            if (p.includes(toPerson)) {
                res.failed.push(h);
            } else {
                p[i] = toPerson;
                res.success.push(h);
            }
        });

        if (res.success.length) this.adjustDay(dayIndex);
        if (res.success.length && !skipSync) await this.pushDay(dayIndex);

        return res;
    }


    /**
     * 将班表中所有出现 oldName 的地方改成 newName
     * @param oldName 旧名字
     * @param newName 新名字
     */
    async renamePerson(oldName: string, newName: string): Promise<void> {
        if (!oldName || !newName || oldName === newName) return;

        await this.pull();


        // 替换 shift_table 中的所有匹配项
        this.shift_table.forEach(day =>
            void day.forEach(h => h.persons = h.persons.map(p => p === oldName ? newName : p))
        );

        // 迁移成员表权限/等级数据
        if (this.member_table[oldName]) {
            this.member_table[newName] = this.member_table[oldName];
            delete this.member_table[oldName];
        }

        // 替换 shiftExchange 中的记录
        this.shiftExchange?.forEach(day =>
            day?.forEach(r => {
                r.onDuty = r.onDuty.map(n => n === oldName ? newName : n);
                r.offDuty = r.offDuty.map(n => n === oldName ? newName : n);
            })
        );

        this.adjustAllDays();


        await this.pushAllDays();

    }


    /**
     *
     * @param dayIndex 第几天的班表
     * @param startHour 涂色开始时刻
     * @param endHour 涂色结束时刻
     * @param color 颜色属性
     */
    async setShiftColor(dayIndex: number, startHour: number, endHour: number, color: HourColor): Promise<number[]> {

        await this.pull();

        const hours = this.normalizeHour(dayIndex, startHour, endHour, false);
        for (const h of hours) {
            this.shift_table[dayIndex][h].hourColor = color;
        }
        if (hours.length) await this.pushDay(dayIndex);

        return hours;
    }

    /**
     * 获取 shift 交换表
     * @param dayIndex 天数
     */
    getShiftExchange(dayIndex: number): ShiftExchange[] | undefined {
        this.generateShiftExchange(); // 先生成表
        return this.shiftExchange[dayIndex]; // 直接按索引访问
    }

    /**
     * 获取某天每小时缺的人数
     * @param dayIndex 第几天（0开始）
     * @returns 数组，长度24，每个元素表示缺的人数
     */
    async getMissingCount(dayIndex: number): Promise<number[]> {
        await this.pull();
        if (dayIndex < 0 || dayIndex >= this.shift_table.length) return undefined;
        return this.shift_table[dayIndex].map(block =>
            block.hourColor !== 'none' ? 0 : block.persons.filter(p => p === null).length
        );
    }

    /**
     * 获取特定天、特定小时的块数据
     * @param dayIndex 第几天 (0开始)
     * @param hour 小时 (0-23)
     */
    getHourBlock(dayIndex: number, hour: number): HourBlock | undefined {
        if (dayIndex < 0 || dayIndex >= this.days || hour < 0 || hour > 23) {
            return undefined;
        }
        return this.shift_table[dayIndex][hour];
    }

    /**
     * 导出班表
     * @param dayIndex 可选，导出某一天
     */
    exportSchedule(dayIndex?: number) {
        const exportSingleDay = (day: number) =>
            this.shift_table[day].reduce((result, block, h) => {
                if (block.hourColor !== "invalid") {
                    result[h] = block;
                }
                return result;
            }, {} as Record<number, HourBlock>);

        if (dayIndex !== undefined) return exportSingleDay(dayIndex);

        // 导出全部：用 Array.from 生成索引数组并 reduce 汇总
        return Array.from({ length: this.days }).reduce((acc, _, d) => {
            const dayResult = exportSingleDay(d);
            if (Object.keys(dayResult).length > 0) acc[d] = dayResult;
            return acc;
        }, {} as Record<number, Record<number, HourBlock>>);
    }

    async setEndTime(newEndTime: string) {
        // 基础格式校验 (yyyyMMddHH 长度应为 10)
        if (newEndTime.length !== 10) {
            throw new ShiftError("INVALID_TIME_FORMAT", "Invalid time format: expected yyyyMMddHH");
        }
        // 逻辑校验：结束时间不能早于开始时间
        else if (Number(newEndTime) - Number(this.eventStartTime) <= 0) {
            throw new ShiftError("OUT_OF_BOUNDS", "Shift must last at least one hour");
        }
        const oldEndH = this.endHour;
        const oldDays = this.days;
        this.eventEndTime = newEndTime;
        const newDays = this._calcDays();
        this.days = newDays;
        // 调整天数：缩短则自动截断，延长则填充新天
        if (newDays < oldDays) {
            this.shift_table.splice(newDays);
        } else {
            for (let d = oldDays; d < newDays; d++) {
                this.shift_table[d] = Array.from({ length: 24 }, () => ({
                    hourColor: 'none', persons: Array(5).fill(null)
                }));
            }
            // 恢复旧结束点后的状态
            const lastDay = this.shift_table[oldDays - 1];
            if (lastDay) {
                for (let h = oldEndH; h < 24; h++) lastDay[h].hourColor = 'none';
            }
        }

        this.markInvalidHours();

        await this.pushAllDays();

    }

    /**
     * 调整整天班表轨道，保证同一人连续段保持同一列
     * @param dayIndex 天数
     */
    adjustDay(dayIndex: number) {
        const d = this.shift_table[dayIndex];
        for (let h = 0; h < 23; h++) {
            const np = d[h + 1].persons; // next hour
            // 遍历 h 的 5 条轨道
            const swapped = d[h].persons.some((p, i) => {
                const j = p ? np.indexOf(p) : -1;
                if (j === -1 || i === j) return false;
                [np[i], np[j]] = [np[j], np[i]];
                return true;
            });
            if (swapped) h--;
        }
    }

    /**
     * 调整所有天的轨道
     */
    adjustAllDays() {
        this.shift_table.forEach((_, day) => void this.adjustDay(day));
    }

    // 生成整个班表的 shiftExchange
    generateShiftExchange() {
        this.shiftExchange = Array.from({ length: this.days }, (_, d) =>
            this.shift_table[d].map((block, h) => {
                // 获取前一小时：如果是 (d:0, h:0) 则为空数组
                const prev = h > 0 ? this.shift_table[d][h - 1]
                    : d > 0 ? this.shift_table[d - 1][23]
                        : { persons: [] };

                const curP = block.persons.filter(Boolean);
                const preP = prev.persons.filter(Boolean);

                return {
                    onDuty: curP.filter(p => !preP.includes(p)),
                    offDuty: preP.filter(p => !curP.includes(p))
                };
            })
        );
    }

    /**
     * 渲染 shiftExchange 表为 HTML（24 小时形式）
     * @param dayIndex 第几天
     */
    renderShiftExchangeHTML(dayIndex: number): string {
        const s = this.startProperties;
        const date = new Date(Date.UTC(s.year, s.month - 1, s.day + dayIndex, 12));
        const dateStr = date.toLocaleDateString("ja-JP", {
            month: "numeric",
            day: "numeric",
            weekday: "short",
            timeZone: "UTC"
        }).replace("曜日", "");
        const exchange = this.getShiftExchange(dayIndex) || [];

        // 表格上下班内容
        const rows = Array.from({ length: 24 }, (_, h) => {
            const valid = (hour: number) => (this.shift_table[dayIndex]?.[hour]?.hourColor ?? 'invalid') !== 'invalid';
            if (!valid(h) && !valid(h - 1)) return "";
            const { onDuty = [], offDuty = [] } = exchange[h] || {};
            return `<tr><td class="hour col-hour">${String(h).padStart(2, '0')}:00</td><td>${onDuty.join(", ")}</td><td>${offDuty.join(", ")}</td></tr>`;
        }).join("");

        return `
<html>
<head>
<style>
  body { margin: 0; padding: 5px 15px; display: inline-block; font-family: sans-serif; }
  table { border-collapse: collapse; font-size: 16px; font-weight: bold;}
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: center; }
</style>
</head>
<body>
<style>
  .shift-exchange { border-collapse: collapse; font-size: 12px; }
  .shift-exchange th, .shift-exchange td { border: 1px solid #999; padding: 2px 4px; text-align: center; }
  .hour { font-weight: bold; background: #eef; width: 55px; }
  .col-p { width: 120px; white-space: nowrap; }
</style>
<table class="shift-exchange">
  <tr><th colspan="1" style="background:#D0E0E3;text-align:center;padding:2px 8px">${this.days}日間</th>
  <th colspan="2" style="background:#D0E0E3;text-align:center;padding:2px 8px">${dateStr} (${dayIndex + 1}日目) シフト交换</th></tr>
  <tr style="background:#f4f4f4"><th>時間</th><th class="col-p">入</th><th class="col-p">出</th></tr>
  ${rows}
</table></body>
</html>`;
    }

    /**
     * 使用 Puppeteer 渲染 shiftExchange 为图片
     * @param ctx Koishi 上下文
     * @param dayIndex 第几天
     */
    async renderShiftExchangeImage(ctx: Context, dayIndex: number) {
        return ctx.puppeteer.render(this.renderShiftExchangeHTML(dayIndex));
    }

    /**
     * 渲染 shift 表为 HTML（24 小时形式）
     * @param dayIndex 第几天
     */
    renderShiftHTML(dayIndex: number): string {
        if (dayIndex < 0 || dayIndex >= this.days) throw new ShiftError("OUT_OF_BOUNDS", `Day ${dayIndex} out of range`);

        const s = this.startProperties;
        const date = new Date(Date.UTC(s.year, s.month - 1, s.day + dayIndex, 12));
        const dateStr = date.toLocaleDateString("ja-JP", {
            month: "numeric",
            day: "numeric",
            weekday: "short",
            timeZone: "UTC"
        }).replace("曜日", "");
        const headerOrder = RANKINGS;
        const formatH = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

        // 渲染行逻辑
        const rows = this.shift_table[dayIndex].map((b, h) => {
            if (b.hourColor === "invalid") return ""; // invalid 行不渲染
            const isBlackOrGray = ["black", "gray"].includes(b.hourColor),
                rowBg = b.hourColor === "black" ? SHIFT_COLORS.BLACK : SHIFT_COLORS.GRAY;
            const [nb, pb] = [this.shift_table[dayIndex][h + 1], this.shift_table[dayIndex][h - 1]];
            const [nextIsBlackOrGray, prevIsBlackOrGray] = [nb, pb].map(b=>b?.hourColor === "black" || b?.hourColor === "gray");
            const nP = (h === 23 || nextIsBlackOrGray) ? [] : nb?.persons?.filter(Boolean) || [];
            const pP = (h === 0 || prevIsBlackOrGray) ? [] : pb?.persons?.filter(Boolean) || [];

            // 样式辅助：处理隐藏行的边框连贯性
            const hiddenStyle = (i: number) => isBlackOrGray
                ? `background:${rowBg};color:${rowBg};border-bottom-color:${nextIsBlackOrGray ? 'transparent' : '#999'};border-right-color:${i === 4 ? '#999' : 'transparent'};`
                : "";

            // @多少人
            let cells = `<td class="col-null" style="${isBlackOrGray ? hiddenStyle(-1) : `background:${b.persons.filter(p => !p).length ? SHIFT_NOT_COMPLETE_COLOR : SHIFT_COMPLETED_COLOR}`}">${isBlackOrGray ? '' : `@${b.persons.filter(p => !p).length}`}</td>`;

            cells += b.persons.map((p, i) => {
                const r = p ? this.member_table[p] : null;
                const rStyle = isBlackOrGray ? hiddenStyle(-1) : `background:${(r && runnerColor[r]) || '#EFEFEF'}`;
                // 位运算映射颜色：[单小时, 开始, 结束, 持续]
                const pStyle = isBlackOrGray ? hiddenStyle(i) : (p ? `background:${SHIFT_PLAYER_COLORS[(+pP.includes(p) << 1) | +nP.includes(p)]}` : "");
                // 每个位置生成一个player颜色+player名字                非灰黑 && 有目标顺位 && 标记不被颜色覆盖
                return `<td class="col-symbol" style="${rStyle}">${!isBlackOrGray && r && !coverRunnerColor && SYMBOL_MAP[r] || ""}</td>
                    <td class="col-person" style="${pStyle}">${!isBlackOrGray && p || ''}</td>`;
            }).join("");
            // | 开始时间 | 结束时间 | ...班表主体 |
            return `<tr><td class="hour">${formatH(h)}</td><td class="hour">${formatH(h + 1)}</td>${cells}</tr>`;
        }).join("");

        // 组合完整 HTML
        return `
<html><head><style>
  body { margin: 0;padding: 5px 15px;display: inline-block }
  table { border-collapse: collapse;font-size: 20px;font-weight: bold }
</style></head>
<body>
<style>
    .shift-day{border-collapse:collapse;font-size:12px;text-align:center;table-layout:fixed}
    .shift-day th, .shift-day td{border:1px solid #999;padding:2px 4px;white-space:nowrap}
    .hour{font-weight:bold;background:#eef;width:55px}.col-null{width:20px}.col-symbol{width:7px}.col-person{width:80px}
</style>
<table class="shift-day">
    <tr>
    <th colspan="1" style="background:#D0E0E3;text-align:center;padding:2px 8px">${this.startMonth}.${this.startDay}</th>
    <th colspan="1" style="background:#D0E0E3;text-align:center;padding:2px 8px">${this.endMonth}.${this.endDay}</th>
    <th colspan="11" style="background:#D0E0E3;text-align:center;padding:2px 8px">${dateStr} (${dayIndex + 1}日目)</th></tr>
    <tr style="background:#eee"><th>開始</th><th>終了</th><th>残</th>${headerOrder.map(r => `<th style="background:${runnerColor[r]}">${SYMBOL_MAP[r]}</th><th>${r.replace('main', 'メイン')}ランナー</th>`).join("")}</tr>
    ${rows}
</table></body></html>`;
    }

    /**
     * 使用 Puppeteer 渲染 shift 为图片
     * @param ctx Koishi 上下文
     * @param dayIndex 第几天
     */
    async renderShiftImage(ctx: Context, dayIndex: number) {
        await this.pull();
        return ctx.puppeteer.render(this.renderShiftHTML(dayIndex));
    }

    /**
     * 异步创建 ShiftTable 实例，如果提供 gParams，则构造处理器并从 Google Sheet 拉取初始数据
     * @param startTime 活动开始时间 yyyyMMddHH
     * @param endTime 活动结束时间 yyyyMMddHH
     * @param timezone (可选)指定时区，默认UTC+9
     * @param gParams (可选)Google Sheet 选项，用于构造处理器
     * @param gAuth (可选)Google Sheet Auth
     */
    static async create(startTime: string, endTime: string, timezone: string = 'Asia/Tokyo', gParams?: GoogleSheetParams, gAuth?: GoogleSheetAuth): Promise<ShiftTable> {
        const instance = new ShiftTable(startTime, endTime, timezone, gParams, gAuth);
        await instance.pull();

        return instance;
    }
}

// 通用的业务错误基类
export class ShiftError extends Error {
    constructor(
        public code: ShiftErrorCodes,
        message: string
    ) {
        super(message);
        this.name = 'ShiftError';
    }
}


export interface ShiftTableSchema {
    eventStartTime: string,
    eventEndTime: string,
    timezone: string,
    gParams?: GoogleSheetParams,
    shift_table: DaySchedule[],
    member_table: memberTable,
    shiftExchange: ShiftExchange[][],
    manager_channels?: string[],
    shift_channels?: { [channelId:string]: number; }
    change_notice?: { channel?: string; enabled?: boolean; locale?: string }
}

// 历史版本的特征字段（用于识别旧数据）
export interface LegacyShiftTableSchema extends Partial<ShiftTableSchema> {
    _eventStartTime?: string;
    _eventEndTime?: string;
    _timezone?: string;
}
