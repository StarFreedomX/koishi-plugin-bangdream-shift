// googleSheetHandler.ts
import { google, sheets_v4 } from 'googleapis';
import { ShiftTable } from './shift';

export class GoogleSheetHandler {
    private sheets = google.sheets('v4');
    private auth: any;
    private spreadsheetId: string;
    private sheetName: string;

    private startCell: { col: string; row: number };
    private colInterval: number;
    private rowInterval: number;
    private dayInterval: number;
    private startHour: number; // J8 对应的小时，例如 15

    constructor(
        spreadsheetId: string,
        authOptions: { client_email: string; private_key: string },
        options: {
            sheetName?: string;
            startCell?: string;
            colInterval?: number;
            rowInterval?: number;
            dayInterval?: number;
            startHour?: number;
        } = {}
    ) {
        this.spreadsheetId = spreadsheetId;
        this.sheetName = options.sheetName || 'マーク式';
        this.colInterval = options.colInterval ?? 1;
        this.rowInterval = options.rowInterval ?? 0;
        this.dayInterval = options.dayInterval ?? 1; // 天与天之间空的一行
        this.startHour = options.startHour ?? 15;

        const match = (options.startCell || 'J8').match(/([A-Z]+)(\d+)/);
        if (!match) throw new Error("Invalid startCell format. Expected like 'J8'");
        this.startCell = { col: match[1], row: parseInt(match[2]) };

        this.auth = new google.auth.JWT({
            email: authOptions.client_email,
            key: authOptions.private_key.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    /**
     * 核心逻辑：直接基于 ShiftTable 的坐标 (d, h) 计算物理行偏移
     */
    private getRowOffset(d: number, h: number): number | null {
        // 第一天在 startHour 之前的时间不在表格内
        if (d === 0 && h < this.startHour) return null;

        // 1. 计算过去的天数占用的物理行
        // 每一天占用：24小时 * (1 + 小时行间距) + 1条天间隔行
        const rowsPerFullDay = 24 * (1 + this.rowInterval) + this.dayInterval;
        const dayOffsetRows = d * rowsPerFullDay;

        // 2. 计算当天内相对于表格起始小时的偏移
        const hourOffsetRows = (h - this.startHour) * (1 + this.rowInterval);

        return dayOffsetRows + hourOffsetRows;
    }

    async pull(shiftTable: ShiftTable) {
        const startColIdx = this.columnToNumber(this.startCell.col);
        const endColIdx = startColIdx + 4 * (this.colInterval + 1);

        // 估算需要拉取的总行数
        const totalRows = shiftTable.days * (24 * (1 + this.rowInterval) + this.dayInterval);
        const range = `${this.sheetName}!${this.startCell.col}${this.startCell.row}:${this.numberToColumn(endColIdx)}${this.startCell.row + totalRows}`;

        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: range,
            auth: this.auth
        });

        const rows = res.data.values || [];

        for (let d = 0; d < shiftTable.days; d++) {
            for (let h = 0; h < 24; h++) {
                const rowIndex = this.getRowOffset(d, h);
                if (rowIndex === null || !rows[rowIndex]) continue;

                const currentRow = rows[rowIndex];
                for (let pIdx = 0; pIdx < 5; pIdx++) {
                    const colIdx = pIdx * (this.colInterval + 1);
                    const name = currentRow[colIdx] || null;
                    // @ts-ignore 访问私有 shift_table
                    shiftTable.shift_table[d][h].persons[pIdx] = name;
                }
            }
        }
        shiftTable.adjustAllDays();
    }

    public async pushDay(dayIndex: number, shiftTable: ShiftTable) {
        const updates: sheets_v4.Schema$ValueRange[] = [];

        for (let pIdx = 0; pIdx < 5; pIdx++) {
            const colIdx = this.columnToNumber(this.startCell.col) + pIdx * (this.colInterval + 1);
            const colLetter = this.numberToColumn(colIdx);
            const columnValues: string[][] = [];
            let firstRowOffset: number | null = null;

            for (let h = 0; h < 24; h++) {
                const offset = this.getRowOffset(dayIndex, h);
                if (offset === null) continue;

                if (firstRowOffset === null) firstRowOffset = offset;

                // @ts-ignore
                const block = shiftTable.shift_table[dayIndex][h];
                const name = (block.hourColor !== 'invalid') ? (block.persons[pIdx] || "") : "";
                columnValues.push([name]);

                if (this.rowInterval > 0 && h < 23) {
                    for (let i = 0; i < this.rowInterval; i++) columnValues.push([""]);
                }
            }

            if (firstRowOffset !== null && columnValues.length > 0) {
                const startRow = this.startCell.row + firstRowOffset;
                updates.push({
                    range: `${this.sheetName}!${colLetter}${startRow}:${colLetter}${startRow + columnValues.length - 1}`,
                    values: columnValues
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
