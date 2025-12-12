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
import * as fs from "node:fs";

export type HourColor = 'none' | 'black' | 'gray' | 'invalid';
type ranking = 'main' | '10' | '50' | '100' | '1000';
const shiftCompleteColor = "#696969";
const shiftNotCompleteColor = "#FFB6B2";
const runnerColor = {
    'main': '#B6FEFD',
    '10': '#FEED55',
    '50': '#FAC467',
    '100': '#FA6767',
    '1000': '#79FA67',
}
const shiftColor = {
    'start': '#F0FFFF',
    'running': '#FFFFF0',
    'end': '#FFE4E1',
    'oneHour': '#F0FFF0',
}
const symbolMap: Record<string, string> = {
    "main": "★",
    // "10": "■",
    // "50": "●",
    // "100": "◆",
    // "1000": "▲",
    "10": " ",
    "50": " ",
    "100": " ",
    "1000": " ",
};

interface HourBlock {
    hourColor: HourColor;        // 黑/灰/无
    persons: (string | null)[];
}

type DaySchedule = HourBlock[];  // 24 个小时

interface memberTable {
    [name: string]: ranking;
}

const coverRunnerColor = false;


interface ShiftExchange {
    onDuty: string[];    // 上班的人
    offDuty: string[];   // 下班的人
}

export class ShiftTable {
    get days(): number {
        return this._days;
    }

    set days(value: number) {
        this._days = value;
    }

    /** 这里day是0开始 */
    private shift_table: DaySchedule[] = []; // 行：小时，列：人员
    private member_table: memberTable = {};
    private eventStartTime: string;
    private eventEndTime: string;
    private _days: number; // 总天数
    private timezone: string;
    shiftExchange: ShiftExchange[][] = []; // key: "day","hour"

    /**
     * 初始化活动班表
     * @param startTime 活动开始时间 yyyyMMddHH
     * @param endTime 活动结束时间 yyyyMMddHH
     * @param timezone (可选)指定时区，默认UTC+9
     */
    constructor(startTime: string, endTime: string, timezone: string = 'Asia/Tokyo') {
        this.eventStartTime = startTime;
        this.eventEndTime = endTime;
        this.timezone = timezone;
        this._days = this.calcDays(startTime, endTime);
        // 初始化表格，全部填充0-24的[null, null, null, null, null]
        this.shift_table = Array.from({length: this._days}, () =>
            Array.from({length: 24}, () => ({
                hourColor: 'none',
                persons: [null, null, null, null, null],
            }))
        );
        this.markInvalidHours();
    }

    private markInvalidHours() {
        const getHour = (t: string) => Number(t.slice(8, 10));

        const startHour = getHour(this.eventStartTime);
        const endHour = getHour(this.eventEndTime);
        const lastDay = this._days - 1;

        // 第一天：startHour 前 invalid
        for (let h = 0; h < startHour; h++) this.shift_table[0][h].hourColor = "invalid";

        // 最后一天：endHour 后 invalid
        for (let h = endHour; h < 24; h++) this.shift_table[lastDay][h].hourColor = "invalid";
    }


    /**
     * 计算活动跨越的天数
     * @param startTime 活动开始时间 yyyyMMddHH
     * @param endTime 活动结束时间 yyyyMMddHH
     * @return 活动跨越的天数
     * @private
     */
    private calcDays(startTime: string, endTime: string): number {
        // 取 yyyyMMdd
        const sY = Number(startTime.slice(0, 4));
        const sM = Number(startTime.slice(4, 6)) - 1;
        const sD = Number(startTime.slice(6, 8));

        const eY = Number(endTime.slice(0, 4));
        const eM = Number(endTime.slice(4, 6)) - 1;
        const eD = Number(endTime.slice(6, 8));

        // 用纯 UTC 日期构建，不受本地时区影响
        const sUTC = Date.UTC(sY, sM, sD);
        const eUTC = Date.UTC(eY, eM, eD);

        // 计算天数差 + 1
        const diff = Math.floor((eUTC - sUTC) / (24 * 3600 * 1000)) + 1;

        return diff;
    }


    /**
     * 辅助函数，解析传入的上下班时间，返回存在班表的小时数列表
     * @param dayIndex 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     */
    private normalizeHour(dayIndex: number, startHour: number, endHour: number): number[] {
        // 24 → 0
        if (startHour === 24) startHour = 0;
        // 0 → 24
        if (endHour === 0) endHour = 24;

        // 本天活动可用时间的区间（不裁剪，但用来判断合法性）
        const dStart = (dayIndex === 0) ? Number(this.eventStartTime.slice(8, 10)) : 0;
        const dEnd = (dayIndex === this._days - 1) ? Number(this.eventEndTime.slice(8, 10)) : 24;

        // 完整检查：若 start/end 任意一点超出活动范围 → 整段取消
        if (startHour < dStart || endHour > dEnd) {
            return [];
        }

        // 检查每个小时 color 是否都是 'none'
        for (let h = startHour; h < endHour; h++) {
            if (this.shift_table[dayIndex][h].hourColor !== 'none') {
                return []; // 冲突 → 整段取消
            }
        }

        // 全部合法 → 返回完整小时数组
        const hours: number[] = [];
        for (let h = startHour; h < endHour; h++) hours.push(h);

        return hours;
    }

    setRanking(name: string, ranking: ranking) {
        if (!name) return;
        this.member_table[name] = ranking;
    }


    /**
     * 添加班表人员
     * @param dayIndex 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param person 人名
     * @return 操作是否成功，成功为true，失败为false
     */
    addShift(dayIndex: number, startHour: number, endHour: number, person: string): boolean {
        const hours = this.normalizeHour(dayIndex, startHour, endHour);
        if (!hours?.length) {
            console.warn(`存在不支持的时间段，已取消插入`);
            return false;
        }
        const d = this.shift_table[dayIndex];

        // 预检查
        for (let h of hours) {
            if (d[h].persons.indexOf(null) === -1) {
                // 有任何小时满员 → 直接拒绝，不修改原数据
                console.warn(`第 ${dayIndex} 天 ${h} 小时已满 5 个位置，放弃整个插入`);
                return false;
            }
        }

        for (let h of hours) {
            const idx = d[h].persons.indexOf(null);
            d[h].persons[idx] = person;
        }

        // 调整轨道
        this.adjustDay(dayIndex);
        return true; // 返回成功
    }

    /**
     * 删除班表人员（删除指定时间段内的该人员信息）
     * @param dayIndex 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param person 人名
     * @return 返回该人员被删除的所有小时列表
     */
    removeShift(dayIndex: number, startHour: number, endHour: number, person: string): number[] {
        const hours = this.normalizeHour(dayIndex, startHour, endHour);
        const d = this.shift_table[dayIndex];
        const removedHours: number[] = [];

        for (const h of hours) {
            const idx = d[h].persons.indexOf(person);
            if (idx !== -1) {
                d[h].persons[idx] = null;  // 恢复为空位
                removedHours.push(h);      // 记录删除的小时
            }
        }
        return removedHours;
    }


    /**
     *
     * @param dayIndex 第几天的班表
     * @param startHour 涂色开始时刻
     * @param endHour 涂色结束时刻
     * @param color 颜色属性
     */
    setShiftColor(dayIndex: number, startHour: number, endHour: number, color: HourColor) {
        const hours = this.normalizeHour(dayIndex, startHour, endHour);
        for (const h of hours) {
            this.shift_table[dayIndex][h].hourColor = color;
        }
    }

    /**
     * 获取某天某小时的人员
     * @param dayIndex 天数
     * @param hour 开始小时数，时长为1
     */
    getPersons(dayIndex: number, hour: number): string[] {
        return this.shift_table[dayIndex][hour].persons.filter(p => p !== null);
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
    getMissingCount(dayIndex: number): number[] {
        if (dayIndex < 0 || dayIndex >= this.shift_table.length) return undefined;
        const dayData = this.shift_table[dayIndex];
        return dayData.map(block => {
            if (block.hourColor !== 'none') return 0;
            return block.persons.filter(p => p === null).length;
        });
    }

    /**
     * 导出班表
     * @param dayIndex 可选，导出某一天
     */
    exportSchedule(dayIndex?: number) {
        const filterBlock = (block: HourBlock) =>
            block.hourColor !== 'invalid' ? {color: block.hourColor, persons: block.persons} : undefined;

        // 导出某天
        const exportSingleDay = (day: number) => {
            const result: Record<number, { color: HourColor; persons: string[] }> = {};
            this.shift_table[day].forEach((block, h) => {
                const filtered = filterBlock(block);
                if (filtered) result[h] = filtered;
            });
            return result;
        };

        if (dayIndex !== undefined) {
            return exportSingleDay(dayIndex);
        }

        // 导出全部天，递归调用单天导出
        const result: Record<number, Record<number, { color: HourColor; persons: string[] }>> = {};
        const exportDays = (d: number) => {
            if (d >= this._days) return;
            const dayResult = exportSingleDay(d);
            if (Object.keys(dayResult).length > 0) result[d] = dayResult;
            exportDays(d + 1); // 递归下一天
        };
        exportDays(0);

        return result;
    }

    setEndTime(newEndTime: string) {
        const newDays = this.calcDays(this.eventStartTime, newEndTime);

        // 当前已有天数
        const oldDays = this._days;

        // 缩短天数 → 删除多余天
        if (newDays < oldDays) {
            this.shift_table.splice(newDays);
        }

        // 延长天数 → 新增天全部 'none'
        if (newDays > oldDays) {
            for (let d = oldDays; d < newDays; d++) {
                this.shift_table[d] = Array.from({ length: 24 }, () => ({
                    hourColor: 'none',
                    persons: [null, null, null, null, null],
                }));
            }
        }

        this._days = newDays;

        // 恢复最后一天结束小时后的原本小时为 'none'
        const lastDayIndex = oldDays - 1;
        const oldEndHour = Number(this.eventEndTime.slice(8, 10));
        for (let h = oldEndHour; h < 24; h++) {
            this.shift_table[lastDayIndex][h].hourColor = 'none';
        }
        this.eventEndTime = newEndTime;
        // 重新标记 invalid
        this.markInvalidHours();
    }



    /**
     * 调整整天班表轨道，保证同一人连续段保持同一列
     * @param dayIndex 天数
     */
    adjustDay(dayIndex: number) {
        const d = this.shift_table[dayIndex];
        let h = 0;
        while (h < 23) {
            const swapped = d[h].persons.some((person, trackA) => {
                if (!person) return false;
                const trackB = d[h + 1].persons.indexOf(person);
                if (trackB === -1 || trackA === trackB) return false;
                for (let hh = h + 1; hh < 24; hh++) {
                    [d[hh].persons[trackA], d[hh].persons[trackB]] = [d[hh].persons[trackB], d[hh].persons[trackA]];
                }
                return true;
            });
            if (!swapped) h++;
        }
    }

    /**
     * 调整所有天的轨道
     */
    adjustAllDays() {
        this.shift_table.forEach((_, day) => this.adjustDay(day));
    }


    // 生成整个班表的 shiftExchange
    generateShiftExchange() {
        this.shiftExchange = [];

        for (let d = 0; d < this._days; d++) {
            const daySchedule = this.shift_table[d];
            this.shiftExchange[d] = [];

            for (let h = 0; h < daySchedule.length; h++) {
                const block = daySchedule[h];

                const prevPersons = new Set(
                    h > 0
                        ? daySchedule[h - 1].persons.filter(Boolean)
                        : d > 0
                            ? this.shift_table[d - 1][23].persons.filter(Boolean)
                            : []
                );
                const curPersons = new Set(block.persons.filter(Boolean));

                this.shiftExchange[d][h] = {
                    onDuty: [...curPersons].filter(p => !prevPersons.has(p)),
                    offDuty: [...prevPersons].filter(p => !curPersons.has(p))
                };
            }
        }
    }

    /**
     * 渲染 shiftExchange 表为 HTML（24 小时形式）
     * @param dayIndex 第几天
     */
    renderShiftExchangeHTML(dayIndex: number): string {
        // 从 10 位数字字符串解析年月日
        const startStr = String(this.eventStartTime).padStart(10, '0'); // 例如 '2025121015'
        const year = Number(startStr.slice(0, 4));
        const month = Number(startStr.slice(4, 6)) - 1;
        const day = Number(startStr.slice(6, 8));

        // 构造当天 Date 对象
        const dayDate = new Date(year, month, day + dayIndex);

        const options: Intl.DateTimeFormatOptions = {
            month: "numeric",
            day: "numeric",
            weekday: "short",
            timeZone: this.timezone
        };
        const dateStr = dayDate.toLocaleDateString("ja-JP", options).replace("曜日", "");
        const dayLabel = `${dayIndex + 1}日目`;

        let html = `
<style>
table.shift-exchange { border-collapse: collapse; margin: 10px 0; font-size: 12px; table-layout: fixed; width: auto; }
.shift-exchange th, .shift-exchange td { border: 1px solid #999; padding: 2px 4px; text-align: center; white-space: nowrap; }
.col-hour { width: 55px; }
.col-person { width: 120px; }
.hour { font-weight: bold; background: #eef; }
.date-header { text-align: left; font-weight: bold; padding: 4px 8px; }
</style>

<table class="shift-exchange">
  <tr><th class="date-header" style="background: #D0E0E3" colspan="3">${dateStr} (${dayLabel}) シフト交換</th></tr>
  <tr>
    <th class="col-hour">開始</th>
    <th class="col-person">入</th>
    <th class="col-person">出</th>
  </tr>
`;

        const dayExchange = this.getShiftExchange(dayIndex) || [];

        for (let h = 0; h < 24; h++) {
            const ex = dayExchange[h] || { onDuty: [], offDuty: [] };
            const onDuty = ex.onDuty.join(", ");
            const offDuty = ex.offDuty.join(", ");

            html += `<tr>
<td class="hour col-hour">${String(h).padStart(2,'0')}:00</td>
<td class="col-person">${onDuty}</td>
<td class="col-person">${offDuty}</td>
</tr>`;
        }

        html += `</table>`;
        return html;
    }

    /**
     * 使用 Puppeteer 渲染 shiftExchange 为图片
     * @param ctx Koishi 上下文
     * @param dayIndex 第几天
     */
    async renderShiftExchangeImage(ctx: Context, dayIndex: number) {
        const html = `
<html>
<head>
<style>
  body { margin: 0; padding: 5px 15px; display: inline-block; font-family: sans-serif; }
  table { border-collapse: collapse; font-size: 16px; font-weight: bold;}
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: center; }
</style>
</head>
<body>
${this.renderShiftExchangeHTML(dayIndex)}
</body>
</html>
`;
        // ctx.puppeteer.render 返回图片的 buffer
        return ctx.puppeteer.render(html);
    }

    renderShiftHTML(dayIndex: number): string {
        if (dayIndex < 0 || dayIndex >= this._days) {
            throw new Error(`Day ${dayIndex} out of range`);
        }

        const dayData = this.shift_table[dayIndex];

        // 将 startTime 10位字符串的年月日部分 + dayIndex 推算日期
        const startYYYY = Number(String(this.eventStartTime).slice(0, 4));
        const startMM = Number(String(this.eventStartTime).slice(4, 6)) - 1;
        const startDD = Number(String(this.eventStartTime).slice(6, 8));

        // 计算当天日期
        const dayDateObj = new Date(startYYYY, startMM, startDD + dayIndex);
        const options: Intl.DateTimeFormatOptions = {
            month: "numeric",
            day: "numeric",
            weekday: "short",
            timeZone: this.timezone
        };
        let dateStr = dayDateObj.toLocaleDateString("ja-JP", options);
        // 去掉“曜日”，保留短星期
        dateStr = dateStr.replace("曜日", "");

        const dayLabel = `${dayIndex + 1}日目`;


        const formatHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

        const getSymbol = (name: string | null) => {
            if (!name) return "";
            const rank = this.member_table[name];
            return rank ? symbolMap[rank] ?? "" : "";
        };

        let html = `
<style>
    table.shift-day { border-collapse: collapse; margin: 10px 0; font-size: 12px; table-layout: fixed; width: auto; }
    .shift-day th, .shift-day td { border: 1px solid #999; padding: 2px 4px; text-align: center; white-space: nowrap; }
    .col-time { width: 55px; }
    .col-null { width: 20px; }
    .col-symbol { width: 7px; }
    .col-person { width: 80px; }
    .hour { font-weight: bold; background: #eef; }
    .date-header { text-align: left; font-weight: bold; padding: 4px 8px; }
</style>

<table class="shift-day">
<tr><th class="date-header" style="background: #D0E0E3" colspan="${3 + 5 * 2}">${dateStr} (${dayLabel})</th></tr>
<tr>
    <th class="col-time">開始</th>
    <th class="col-time">終了</th>
    <th class="col-null">残</th>
`;

        const headerOrder: ranking[] = ["main", "10", "50", "100", "1000"];
        for (const r of headerOrder) {
            html += `<th style="background: ${runnerColor[r]}">${symbolMap[r]}</th><th class="col-person">${r.replace('main','メイン')}ランナー</th>`;
        }
        html += `</tr>`;

        for (let h = 0; h < 24; h++) {
            const block = dayData[h];
            if (block.hourColor === "invalid") continue;

            const persons = block.persons;
            const nullCount = persons.filter(p => p === null).length;
            const isHiddenRow = block.hourColor === "black" || block.hourColor === "gray";
            const [nextBlock, preBlock] = [dayData.at(h + 1), dayData.at(h - 1)];
            const blockIsHiddenRow = (...blocks: any[]) => blocks.map(b => b?.hourColor === "black" || b?.hourColor === "gray");
            const [nextIsHiddenRow, preIsHiddenRow] = blockIsHiddenRow(nextBlock, preBlock);
            const nextPeople = h === 23 || nextIsHiddenRow ? [] : nextBlock?.persons?.filter(Boolean) || [];
            const prePeople = h === 0 || preIsHiddenRow ? [] : preBlock?.persons?.filter(Boolean) || [];
            const rowBg = block.hourColor === "black" ? "#000" : block.hourColor === "gray" ? "#B7B7B7" : "";

            html += `<tr>`;
            html += `<td class="hour col-time">${formatHour(h)}</td>`;
            html += `<td class="hour col-time">${formatHour(h + 1)}</td>`;

            let nullStyle = `background:${shiftNotCompleteColor}`;
            if (isHiddenRow) {
                nullStyle = `background:${rowBg}; color:${rowBg}; border-bottom-color:${nextIsHiddenRow ? 'transparent':'#999'}; border-right-color:transparent;`;
            } else if (nullCount === 0) {
                nullStyle = `background:${shiftCompleteColor}`;
            }
            html += `<td class="col-null null-counter" style="${nullStyle}">${isHiddenRow ? '' : '@'+nullCount}</td>`;

            for (let i = 0; i < persons.length; i++) {
                const p = persons[i];
                let symbol = getSymbol(p);
                let symbolStyle = "background:#EFEFEF";
                if (isHiddenRow) {
                    symbolStyle = `background:${rowBg}; color:${rowBg}; border-bottom-color:${nextIsHiddenRow ? 'transparent':'#999'}; border-right-color:transparent;`;
                    symbol = "";
                } else if (p) {
                    const rank = this.member_table[p];
                    if (rank && runnerColor[rank]) {
                        symbolStyle = `background:${runnerColor[rank]}`;
                        if (coverRunnerColor) symbol = "";
                    }
                }
                html += `<td class="col-symbol" style="${symbolStyle}">${symbol}</td>`;

                const personText = isHiddenRow ? '' : p ?? '';
                const personStyle = isHiddenRow
                    ? `background:${rowBg}; color:${rowBg}; border-bottom-color:${nextIsHiddenRow ? 'transparent':'#999'}; border-right-color:${i === persons.length-1 ? '#999':'transparent'};`
                    : p?.length
                        ? prePeople.includes(p)
                            ? nextPeople.includes(p)
                                ? `background:${shiftColor.running}`
                                : `background:${shiftColor.end}`
                            : nextPeople.includes(p)
                                ? `background:${shiftColor.start}`
                                : `background:${shiftColor.oneHour}`
                        : '';
                html += `<td class="col-person" style="${personStyle}">${personText}</td>`;
            }

            html += `</tr>`;
        }

        html += `</table>`;
        return html;
    }


    async renderShiftImage(ctx: Context, dayIndex: number) {
        return ctx.puppeteer.render(`
<html>
<head>
<style>
  body {
    margin: 0;
    padding: 5px 15px;
    display: inline-block;
  }
  table {
    border-collapse: collapse;
    font-size: 20px;
    font-weight: bold;
  }
</style>
</head>
<body>
  ${this.renderShiftHTML(dayIndex)}
</body>
</html>
`)
    }
}


/*

const shiftTable = new ShiftTable('202511111400', '202511132000');

shiftTable.setRanking('Main', 'main')
shiftTable.setRanking('Alice', '10')


shiftTable.addShift(0, 15, 24, 'Main');
shiftTable.addShift(1, 0, 24, 'Main');
shiftTable.addShift(1, 2, 5, 'Alice');
shiftTable.addShift(1, 3, 6, 'Bob');
shiftTable.addShift(1, 6, 8, 'CAI');
shiftTable.addShift(1, 5, 7, 'Dod');
shiftTable.addShift(1, 5, 7, 'Err');
shiftTable.addShift(1, 5, 7, 'Faa');
// shiftTable.addShift(0, 4, 8, 'Grok');
shiftTable.setShiftColor(1, 4, 6, 'black');


// console.dir(shiftTable.exportSchedule(), {depth: null})
// console.dir(shiftTable, {depth: null})
// console.log(shiftTable.renderDay(0));
fs.writeFileSync('test.html', shiftTable.renderShiftHTML(0))
// fs.writeFileSync('test.html', shiftTable.renderShiftExchangeHTML(0))
// console.log(shiftTable.getPersons(0, 14));
// console.log(shiftTable.getPersons(0, 17));
// console.log(shiftTable.getShiftExchange(0, 15));
*/


