/*
排班表相关类
大致结构为: ShiftTable -> shiftTable -> rows -> player

排班表交互逻辑设计：
shiftTable初始化时提供startTs: number, endTs: number, timezone: string = 'Asia/Tokyo'

填班时让名字放在同一列
注意一行只能放5人，不能多，少的用null补位确保对齐
删除方法removeShift(day: number, startHour: number, endHour: number, person: string): number[]
 */
import * as fs from "node:fs";

type HourColor = 'none' | 'black' | 'gray' | 'invalid';
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
    'start': '#BAE8FC',
    'running': '#FFFAEE',
    'end': '#FFD3D3',
    'oneHour': '#AAFFBF',
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
    /** 这里day是0开始 */
    private shift_table: DaySchedule[] = []; // 行：小时，列：人员
    private member_table: memberTable = {};
    private eventStartTime: number; // 时间戳（毫秒）
    private eventEndTime: number;
    private days: number; // 总天数
    private timezone: string;
    shiftExchange: ShiftExchange[][] = []; // key: "day","hour"

    /**
     * 初始化活动班表
     * @param startTs 活动开始时间戳
     * @param endTs 活动结束时间戳
     * @param timezone (可选)指定时区，默认UTC+9
     */
    constructor(startTs: number, endTs: number, timezone: string = 'Asia/Tokyo') {
        this.eventStartTime = startTs;
        this.eventEndTime = endTs;
        this.timezone = timezone;
        // 通过指定的时区，计算跨越的天数
        this.days = this.calcDaysWithTimezone(startTs, endTs);
        // 初始化表格，全部填充0-24的[null, null, null, null, null]
        this.shift_table = Array.from({length: this.days}, () =>
            Array.from({length: 24}, () => ({
                hourColor: 'none',
                persons: [null, null, null, null, null],
            }))
        );
        this.markInvalidHours();
    }

    private markInvalidHours() {
        const getHour = (ts: number) =>
            Number(new Intl.DateTimeFormat("sv-SE", {
                timeZone: this.timezone,
                hour: "2-digit",
                hour12: false
            }).format(ts));

        const startHour = getHour(this.eventStartTime);
        const endHour = getHour(this.eventEndTime);
        const lastDay = this.days - 1;

        // 第一天：startHour 前 invalid
        for (let h = 0; h < startHour; h++) this.shift_table[0][h].hourColor = "invalid";

        // 最后一天：endHour 后 invalid
        for (let h = endHour; h < 24; h++) this.shift_table[lastDay][h].hourColor = "invalid";
    }


    /**
     * 计算活动跨越的天数
     * @param startTs 活动开始时间戳
     * @param endTs 活动结束时间戳
     * @return 活动跨越的天数
     * @private
     */
    private calcDaysWithTimezone(startTs: number, endTs: number): number {
        const getYMD = (ts: number) => {
            const d = new Date(ts);
            const [year, month, day] = d.toLocaleString("sv-SE", {timeZone: this.timezone}).split(" ")[0].split("-");
            return {year: +year, month: +month, day: +day};
        };

        const start = getYMD(startTs);
        const end = getYMD(endTs);
        const s = new Date(start.year, start.month - 1, start.day).getTime();
        const e = new Date(end.year, end.month - 1, end.day).getTime();
        return Math.round((e - s) / (24 * 3600 * 1000)) + 1;
    }


    /**
     * 辅助函数，解析传入的上下班时间，返回存在班表的小时数列表
     * @param day 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     */
    private normalizeHour(day: number, startHour: number, endHour: number): number[] {
        // 24 → 0
        if (startHour === 24) startHour = 0;
        // 0 → 24
        if (endHour === 0) endHour = 24;

        // 本天活动可用时间的区间（不裁剪，但用来判断合法性）
        const dStart = (day === 0) ? new Date(this.eventStartTime).getHours() : 0;
        const dEnd = (day === this.days - 1) ? new Date(this.eventEndTime).getHours() : 24;

        // 完整检查：若 start/end 任意一点超出活动范围 → 整段取消
        if (startHour < dStart || endHour > dEnd) {
            return [];
        }

        // 检查每个小时 color 是否都是 'none'
        for (let h = startHour; h < endHour; h++) {
            if (this.shift_table[day][h].hourColor !== 'none') {
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
     * @param day 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param person 人名
     * @return 操作是否成功，成功为true，失败为false
     */
    addShift(day: number, startHour: number, endHour: number, person: string): boolean {
        const hours = this.normalizeHour(day, startHour, endHour);
        if (!hours?.length) {
            console.warn(`存在不支持的时间段，已取消插入`);
            return false;
        }
        const d = this.shift_table[day];

        // 预检查
        for (let h of hours) {
            if (d[h].persons.indexOf(null) === -1) {
                // 有任何小时满员 → 直接拒绝，不修改原数据
                console.warn(`第 ${day} 天 ${h} 小时已满 5 个位置，放弃整个插入`);
                return false;
            }
        }

        // 批量写入（现在可以保证不会失败）
        for (let h of hours) {
            const idx = d[h].persons.indexOf(null);
            d[h].persons[idx] = person;
        }

        // 调整轨道
        this.adjustDay(day);
        return true; // 返回成功
    }

    /**
     * 删除班表人员（删除指定时间段内的该人员信息）
     * @param day 第几天的班表
     * @param startHour 上班时刻
     * @param endHour 下班时刻
     * @param person 人名
     * @return 返回该人员被删除的所有小时列表
     */
    removeShift(day: number, startHour: number, endHour: number, person: string): number[] {
        const hours = this.normalizeHour(day, startHour, endHour);
        const d = this.shift_table[day];
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
     * @param day 第几天的班表
     * @param startHour 涂色开始时刻
     * @param endHour 涂色结束时刻
     * @param color 颜色属性
     */
    setShiftColor(day: number, startHour: number, endHour: number, color: HourColor) {
        const hours = this.normalizeHour(day, startHour, endHour);
        for (const h of hours) {
            this.shift_table[day][h].hourColor = color;
        }
    }

    /**
     * 获取某天某小时的人员
     * @param day 天数
     * @param hour 开始小时数，时长为1
     */
    getPersons(day: number, hour: number): string[] {
        return this.shift_table[day][hour].persons.filter(p => p !== null);
    }

    /**
     * 获取 shift 交换表
     * @param day 天数
     * @param hour 小时数
     */
    getShiftExchange(day: number, hour: number): ShiftExchange | undefined {
        this.generateShiftExchange(); // 先生成表
        return this.shiftExchange[day]?.[hour]; // 直接按索引访问
    }

    /**
     * 导出班表
     * @param day 可选，导出某一天
     */
    exportSchedule(day?: number) {
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

        if (day !== undefined) {
            return exportSingleDay(day);
        }

        // 导出全部天，递归调用单天导出
        const result: Record<number, Record<number, { color: HourColor; persons: string[] }>> = {};
        const exportDays = (d: number) => {
            if (d >= this.days) return;
            const dayResult = exportSingleDay(d);
            if (Object.keys(dayResult).length > 0) result[d] = dayResult;
            exportDays(d + 1); // 递归下一天
        };
        exportDays(0);

        return result;
    }


    /**
     * 调整整天班表轨道，保证同一人连续段保持同一列
     * @param day 天数
     */
    adjustDay(day: number) {
        const d = this.shift_table[day];
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

        for (let d = 0; d < this.days; d++) {
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

    renderDay(day: number): string {
        if (day < 0 || day >= this.days) {
            throw new Error(`Day ${day} out of range`);
        }

        const dayData = this.shift_table[day];
        const formatHour = (h: number) => `${String(h).padStart(2, "0")}:00`;



        const getSymbol = (name: string | null) => {
            if (!name) return "";
            const rank = this.member_table[name];
            if (!rank) return "";
            return symbolMap[rank] ?? "";
        };

        // 计算当天日期
        const dayDate = new Date(this.eventStartTime + day * 24 * 3600 * 1000);
        const options: Intl.DateTimeFormatOptions = {
            month: "numeric",
            day: "numeric",
            weekday: "short",
            timeZone: this.timezone
        };
        const dateStr = dayDate.toLocaleDateString("ja-JP", options).replace("曜日", "");
        const dayLabel = `${day + 1}日目`;

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
  <tr><th class="date-header" style="background: #D0E0E3" colspan="${3 + 5 * 2}">${dateStr}    (${dayLabel})</th></tr>
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
            const blockIsHiddenRow = (...blocks: HourBlock[]) => blocks.map(block=>block?.hourColor === "black" || block?.hourColor === "gray");
            const [nextIsHiddenRow, preIsHiddenRow] = blockIsHiddenRow(nextBlock,preBlock);

            const nextPeople = h === 23 || nextIsHiddenRow ? [] : nextBlock?.persons?.filter(Boolean) || [];
            const prePeople = h === 0 || preIsHiddenRow ? [] : preBlock?.persons?.filter(Boolean) || [];
            const rowBg = block.hourColor === "black" ? "#000" : block.hourColor === "gray" ? "#B7B7B7" : "";

            html += `<tr>`;

            // 时间列
            html += `<td class="hour col-time">${formatHour(h)}</td>`;
            html += `<td class="hour col-time">${formatHour((h + 1))}</td>`;

            // null counter
            let nullStyle = `background:${shiftNotCompleteColor}`;
            if (isHiddenRow) {
                nullStyle = `background:${rowBg}; color:${rowBg}; border-bottom-color: ${nextIsHiddenRow ? 'transparent' : '#999'}; border-right-color: transparent;`;
            } else if (nullCount === 0) {
                nullStyle = `background:${shiftCompleteColor}`;
            }
            html += `<td class="col-null null-counter" style="${nullStyle}">${isHiddenRow ? '' : '@' + nullCount}</td>`;

            // 每人：符号 + 人员格
            for (let i = 0; i < persons.length; i++) {
                const p = persons[i];

                // 符号格
                let symbol = getSymbol(p);
                let symbolStyle = "background:#EFEFEF";
                if (isHiddenRow) {
                    symbolStyle = `background:${rowBg}; color:${rowBg}; border-bottom-color: ${nextIsHiddenRow ? 'transparent' : '#999'}; border-right-color: transparent;`;
                    symbol = "";
                } else if (p) {
                    const rank = this.member_table[p];
                    if (rank && runnerColor[rank]) {
                        symbolStyle = `background:${runnerColor[rank]}`;
                        if (coverRunnerColor) symbol = "";
                    }
                }
                html += `<td class="col-symbol" style="${symbolStyle}">${symbol}</td>`;

                // 内部右/下边框透明，最右格恢复右边框
                const personText = isHiddenRow ? '' : p ?? "";
                const personStyle = isHiddenRow
                    ? `background:${rowBg}; color:${rowBg}; border-bottom-color: ${nextIsHiddenRow ? 'transparent' : '#999'}; border-right-color:${i === persons.length - 1 ? '#999' : 'transparent'};`
                    : p?.length
                        ? prePeople.includes(p)
                            ? nextPeople.includes(p)
                                ? `background: ${shiftColor.running}`
                                : `background: ${shiftColor.end}`
                            : nextPeople.includes(p)
                                ? `background: ${shiftColor.start}`
                                : `background: ${shiftColor.oneHour}`
                        : "";
                html += `<td class="col-person" style="${personStyle}">${personText}</td>`;
            }

            html += `</tr>`;
        }

        html += `</table>`;
        return html;
    }
}


// 使用示例
const start = new Date('2025-11-11 14:00:00').getTime();
const end = new Date('2025-11-13 20:00:00').getTime();
const shiftTable = new ShiftTable(start, end);

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
shiftTable.setShiftColor(1, 4, 6, 'black')


// console.dir(shiftTable.exportSchedule(), {depth: null})
// console.dir(shiftTable, {depth: null})
// console.log(shiftTable.renderDay(0));
fs.writeFileSync('test.html', shiftTable.renderDay(0))
// console.log(shiftTable.getPersons(0, 14));
// console.log(shiftTable.getPersons(0, 17));
// console.log(shiftTable.getShiftExchange(0, 15));

