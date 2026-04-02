// googleSheetHandler.ts
import { google, sheets_v4 } from 'googleapis';
import { HourColor, ShiftTable } from './shift';

// 定义原始数据对象
export const defaultColorCols = {
    black: 'AA',
    gray: 'AB',
} as const;
// 自动提取类型：'black' | 'gray'
export type ColorType = keyof typeof defaultColorCols;
// 自动提取数组：['black', 'gray']
export const colorTypeArray = Object.keys(defaultColorCols) as ColorType[];

export interface GoogleSheetParams {
    spreadsheetId: string;
    options: GoogleSheetOptions;
}
export interface GoogleSheetOptions {
    sheetName?: string;
    startCell?: string;
    colorCol?: { [K in ColorType]?: string };
    colInterval?: number;
    rowInterval?: number;
    dayInterval?: number;
    startHour?: number;
}

export interface GoogleSheetAuth{
    client_email: string;
    private_key: string;
}

export class GoogleSheetHandler {
    private sheets = google.sheets('v4');
    private auth: any;
    private spreadsheetId: string;
    private sheetName: string;

    private startCell: { col: string; row: number };
    private colorCol: { [K in ColorType]?: string } = { ...defaultColorCols };
    private colInterval: number;
    private rowInterval: number;
    private dayInterval: number;
    private startHour: number; // J8 对应的小时，例如 15

    constructor(
        spreadsheetId: string,
        authOptions: { client_email: string; private_key: string },
        options: GoogleSheetOptions = {}
    ) {
        this.spreadsheetId = spreadsheetId;
        this.sheetName = options.sheetName || 'マーク式';
        this.colInterval = options.colInterval ?? 1;
        this.rowInterval = options.rowInterval ?? 0;
        this.dayInterval = options.dayInterval ?? 1; // 天与天之间空的一行
        this.startHour = options.startHour ?? 15;

        const cellMatch = (options.startCell || 'J8').match(/^([A-Z]+)(\d+)$/);
        if (!cellMatch) throw new Error(`Invalid startCell format: ${options.startCell}. Expected like 'J8'`);
        this.startCell = { col: cellMatch[1], row: parseInt(cellMatch[2]) };

        if (options.colorCol) {
            colorTypeArray.forEach(type => {
                const label = options.colorCol![type]; // 使用 ! 因为我们正在遍历合法的 key
                if (label) {
                    if (!/^[A-Z]+$/.test(label)) {
                        throw new Error(`[ShiftTable] Invalid column: ${label} for ${type}`);
                    }
                    this.colorCol[type] = label;
                }
            });
        }

        this.auth = new google.auth.JWT({
            email: authOptions.client_email,
            key: authOptions.private_key.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    /**
     * 核心逻辑：直接基于 ShiftTable 的坐标 (dayIndex, h) 计算物理行偏移
     */
    private getRowOffset(dayIndex: number, h: number): number | null {
        // 第一天在 startHour 之前的时间不在表格内
        if (dayIndex === 0 && h < this.startHour) return null;

        // 1. 计算过去的天数占用的物理行
        // 每一天占用：24小时 * (1 + 小时行间距) + 1条天间隔行
        const rowsPerFullDay = 24 * (1 + this.rowInterval) + this.dayInterval;
        const dayOffsetRows = dayIndex * rowsPerFullDay;

        // 2. 计算当天内相对于表格起始小时的偏移
        const hourOffsetRows = (h - this.startHour) * (1 + this.rowInterval);

        return dayOffsetRows + hourOffsetRows;
    }

    async pull(shiftTable: ShiftTable) {
        // 1. 确定拉取范围：需要涵盖名字区域和最右侧的颜色列
        const startColIdx = this.columnToNumber(this.startCell.col);
        const colorColIndices = colorTypeArray.map(type => this.columnToNumber(this.colorCol[type]!));
        const maxColIdx = Math.max(startColIdx + 4 * (this.colInterval + 1), ...colorColIndices);

        const totalRows = shiftTable.days * (24 * (1 + this.rowInterval) + this.dayInterval);
        const range = `${this.sheetName}!A${this.startCell.row}:${this.numberToColumn(maxColIdx)}${this.startCell.row + totalRows}`;

        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: range,
            auth: this.auth
        });

        const rows = res.data.values || [];

        for (let dayIndex = 0; dayIndex < shiftTable.days; dayIndex++) {
            for (let h = 0; h < 24; h++) {
                const rowIndex = this.getRowOffset(dayIndex, h);
                if (rowIndex === null || !rows[rowIndex]) continue;

                const currentRow = rows[rowIndex];

                // 处理名字同步
                const currentPersons: (string | null)[] = [];
                for (let pIdx = 0; pIdx < 5; pIdx++) {
                    const colIdxInRow = startColIdx + pIdx * (this.colInterval + 1);
                    currentPersons.push(currentRow[colIdxInRow] || null);
                }

                // 处理颜色检测 (优先级：black > gray > none)
                let detectedColor: HourColor = 'none';
                for (const type of colorTypeArray) {
                    const colIdx = this.columnToNumber(this.colorCol[type]!);
                    if (currentRow[colIdx] === '×') {
                        detectedColor = type;
                        break;
                    }
                }
                shiftTable.setRow(dayIndex, h, currentPersons, detectedColor);
            }
        }
        shiftTable.adjustAllDays();
    }

    public async pushDay(dayIndex: number, shiftTable: ShiftTable) {
        const updates: sheets_v4.Schema$ValueRange[] = [];

        // 1. 构造名字列的更新
        for (let pIdx = 0; pIdx < 5; pIdx++) {
            const colIdx = this.columnToNumber(this.startCell.col) + pIdx * (this.colInterval + 1);
            const colLetter = this.numberToColumn(colIdx);
            const columnValues: string[][] = [];
            let firstRowOffset: number | null = null;

            for (let h = 0; h < 24; h++) {
                const offset = this.getRowOffset(dayIndex, h);
                if (offset === null) continue;
                if (firstRowOffset === null) firstRowOffset = offset;

                // const block = shiftTable.shift_table[dayIndex][h];
                const block = shiftTable.getRow(dayIndex, h);
                const name = (block.hourColor !== 'invalid') ? (block.persons[pIdx] || "") : "";
                columnValues.push([name]);

                if (this.rowInterval > 0 && h < 23) {
                    for (let i = 0; i < this.rowInterval; i++) columnValues.push([""]);
                }
            }
            if (firstRowOffset !== null) {
                const startRow = this.startCell.row + firstRowOffset;
                updates.push({
                    range: `${this.sheetName}!${colLetter}${startRow}:${colLetter}${startRow + columnValues.length - 1}`,
                    values: columnValues
                });
            }
        }

        // 2. 构造颜色列的更新 (black 和 gray 列)
        for (const type of colorTypeArray) {
            const colLetter = this.colorCol[type]!;
            const colorValues: string[][] = [];
            let firstRowOffset: number | null = null;

            for (let h = 0; h < 24; h++) {
                const offset = this.getRowOffset(dayIndex, h);
                if (offset === null) continue;
                if (firstRowOffset === null) firstRowOffset = offset;

                // const block = shiftTable.shift_table[dayIndex][h];
                const block = shiftTable.getRow(dayIndex, h);
                // 如果当前行的颜色正好是该列对应的颜色，填 '×'，否则清空
                const mark = (block.hourColor === type) ? '×' : '';
                colorValues.push([mark]);

                if (this.rowInterval > 0 && h < 23) {
                    for (let i = 0; i < this.rowInterval; i++) colorValues.push([""]);
                }
            }

            if (firstRowOffset !== null) {
                const startRow = this.startCell.row + firstRowOffset;
                updates.push({
                    range: `${this.sheetName}!${colLetter}${startRow}:${colLetter}${startRow + colorValues.length - 1}`,
                    values: colorValues
                });
            }
        }

        if (updates.length > 0) {
            await this.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                auth: this.auth,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: updates
                }
            });
        }
    }

    public async pushAllDays(shiftTable: ShiftTable) {
        for (let d = 0; d < shiftTable.days; d++) {
            await this.pushDay(d, shiftTable);
        }
    }

    private columnToNumber(col: string): number {
        let num = 0;
        for (let i = 0; i < col.length; i++) num = num * 26 + (col.charCodeAt(i) - 64);
        return num - 1;
    }

    private numberToColumn(num: number): string {
        let col = '';
        while (num >= 0) {
            col = String.fromCharCode((num % 26) + 65) + col;
            num = Math.floor(num / 26) - 1;
        }
        return col;
    }
}
