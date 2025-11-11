/*
排班表相关类
大致结构为: shiftTables -> shiftTable -> rows -> player

排班表交互逻辑设计：
shiftTables初始化时提供sheetNum张表，
其中第一张表的firstStartHour是我在构造方法里写的firstStartHour，
最后一张表的lastStartHour是我在构造方法里写的lastStartHour，
除了这两个特殊情况外都是0-23这样子填入
shiftTables提供addPlayer(day: number, time: number, player: {name: string,atInfo: string})
shiftTable提供addPlayer(time: number, player:{name: string, atInfo: string})
填班时尽可能让名字放在同一列，如果没找到位置可以拆散放
填班时尽可能最大化利用空间，例如2h的班有一个3空位和2空位可选，优先填进2空位的
注意一行只能放5人，不能多，少的可以用undefined补位确保对齐
删除方法delPlayer(day: number, time: number, player: {name: string, atInfo: string})注意这里的player只需要一个属性匹配就可以删除
 */
class shiftTables{
  eventId: number;
  startTime: Date;
  endTime: Date;
  sheets: Map<number, shiftTable>;
  constructor(eventId: number, startTime: Date, endTime: Date) {
    this.eventId = eventId;
    this.startTime = startTime;
    this.endTime = endTime;
    const lasting = getDaysCount(startTime,endTime);
    for (let i = 1; i <= lasting; i++) {
      const sheet = new shiftTable(i === 1 ? startTime.getHours():0,i == lasting ? endTime.getHours():23);
    }
  }
}
class shiftTable {
  date: Date;
  firstStartHour: number;
  lastStartHour: number;
  rows: Map<number, shiftRow>;
  constructor(firstStartHour: number, lastStartHour: number) {
    for (let i = firstStartHour; i <= lastStartHour; i++) {

    }
  }
  addPlayer(player: player, firstStartHour: number, lastStartHour: number) {

  }
  delPlayer(player: player, firstStartHour: number, lastStartHour: number) {

  }
  delRows(firstStartHour: number, lastStartHour: number) {

  }
}
class shiftRow {
  startHour: number;
  positionLeft: number;
  block: boolean;
  shiftPlayers: (player | undefined)[];
  constructor(startHour: number) {
    this.startHour = startHour;
    this.positionLeft = 5;
    this.block = false;
    this.shiftPlayers = [];
  }
}

interface player {
  playerName: string;
  atInfo: string;
}

function getDaysCount(startAt: Date, endAt: Date): number {
  const startDate = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate());
  const endDate = new Date(endAt.getFullYear(), endAt.getMonth(), endAt.getDate());
  const msPerDay = 1000 * 60 * 60 * 24;
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);
  return diffDays + 1;
}

















/*

class shiftTables {
  eventId: number;
  startTime: Date;
  endTime: Date;
  sheets: Map<number, shiftTable>;

  constructor({ eventId, startTime, endTime }: { eventId: number; startTime: Date; endTime: Date; }) {
    this.eventId = eventId;
    this.startTime = startTime;
    this.endTime = endTime;
    this.sheets = new Map();

    const sheetNum = getDaysCount(startTime, endTime);
    const firstStartHour = startTime.getHours();
    const lastStartHour = endTime.getHours();

    for (let i = 1; i <= sheetNum; i++) {
      const currentDate = new Date(startTime);
      currentDate.setDate(currentDate.getDate() + i);

      const startHour = i === 1 ? firstStartHour : 0;
      const endHour = i === sheetNum ? lastStartHour : 23;

      this.sheets.set(i, new shiftTable(currentDate, startHour, endHour));
    }
  }

  addPlayer(day: number, startHour: number, endHour: number, player: player) {
    const table = this.sheets.get(day);
    if (table) {
      table.addPlayer(player, startHour, endHour);
    }
  }

  delPlayer(day: number, startHour: number, endHour: number, player: { playerName?: string, atInfo?: string }): void {
    const table = this.sheets.get(day);
    if (!table) return;

    for (let hour = startHour; hour < endHour; hour++) {
      const row = table.rows.get(hour);
      if (!row) continue;

      for (let i = 0; i < row.shiftPlayers.length; i++) {
        const p = row.shiftPlayers[i];
        if (!p) continue;

        const matchName = player.playerName && p.playerName === player.playerName;
        const matchAtInfo = player.atInfo && p.atInfo === player.atInfo;

        if (matchName || matchAtInfo) {
          row.shiftPlayers[i] = undefined;
        }
      }

      row.positionLeft = 5 - row.shiftPlayers.filter(p => p !== undefined && p !== null).length;
    }
  }
}

class shiftTable {
  date: Date;
  firstStartHour: number;
  lastStartHour: number;
  rows: Map<number, shiftRow>;

  constructor(date: Date, firstStartHour: number = 0, lastStartHour: number = 23) {
    this.date = date;
    this.firstStartHour = firstStartHour;
    this.lastStartHour = lastStartHour;
    this.rows = new Map();

    for (let i = firstStartHour; i <= lastStartHour; i++) {
      const nowHourRow: shiftRow = {
        startHour: i,
        positionLeft: 5,
        block: false,
        shiftPlayers: [].fill(null,0,5),
      };
      this.rows.set(i, nowHourRow);
    }
  }

  addPlayer(player: player, startHour: number, endHour: number): boolean {
    for (let i = startHour; i < endHour; i++) {
      if(!this.rows.get(i)?.positionLeft){
        return false;
      }
    }

    // 查找可以完全容纳的列
    //转化成二维数组
    const columns: (player | undefined)[][] = Array.from({ length: 5 }, () => Array(this.lastStartHour + 1).fill(undefined));

    for (const [hour, row] of this.rows.entries()) {
      row.shiftPlayers.forEach((p, idx) => {
        columns[idx][hour] = p;
      });
    }

    // 尝试在某一列完整插入
    for (let col = 0; col < 5; col++) {
      let canInsert = true;
      for (let h = startHour; h < endHour; h++) {
        if (columns[col][h]) {
          canInsert = false;
          break;
        }
      }
      if (canInsert) {
        for (let h = startHour; h < endHour; h++) {
          const row = this.rows.get(h);
          if (row) {
            row.shiftPlayers[col] = player;
            row.positionLeft = 5 - row.shiftPlayers.filter(p => p !== undefined && p !== null).length;
          }
        }
        return;
      }
    }

    // 无法整列插入，逐行插入
    for (let h = startHour; h < endHour; h++) {
      const row = this.rows.get(h);
      if (row && row.positionLeft > 0) {
        for (let i = 0; i < 5; i++) {
          if (!row.shiftPlayers[i]) {
            row.shiftPlayers[i] = player;
            row.positionLeft--;
            break;
          }
        }
      }
    }
  }

  // 输出二维数组：每行 [小时, 姓名1, 姓名2, 姓名3, 姓名4, 姓名5]
  toNameArray(): (string | number)[][] {
    const result: (string | number)[][] = [];
    const sortedHours = Array.from(this.rows.keys()).sort((a, b) => a - b);
    for (const hour of sortedHours) {
      const row = this.rows.get(hour);
      if (row) {
        const line: (string | number)[] = [hour];
        for (const p of row.shiftPlayers) {
          line.push(p?.playerName ?? '');
        }
        result.push(line);
      }
    }
    return result;
  }
}

interface shiftRow {
  startHour: number;
  positionLeft: number;
  block: boolean;
  shiftPlayers: (player | undefined)[];
}

interface player {
  playerName: string;
  atInfo: string;
}

function getDaysCount(startAt: Date, endAt: Date): number {
  const startDate = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate());
  const endDate = new Date(endAt.getFullYear(), endAt.getMonth(), endAt.getDate());
  const msPerDay = 1000 * 60 * 60 * 24;
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);
  return diffDays + 1;
}


const sfts = new shiftTables({eventId:299, startTime:new Date(Date.now()), endTime:new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)})
console.log(sfts);
sfts.addPlayer(2,10,15,{playerName: 'a', atInfo: 'ata'});
sfts.addPlayer(2,11,16,{playerName: 'b', atInfo: 'atb'});
sfts.addPlayer(2,10,15,{playerName: 'c', atInfo: 'atc'});
sfts.addPlayer(2,15,16,{playerName: 'd', atInfo: 'atd'});
sfts.delPlayer(1,12, 15, {playerName:'b'})
console.log(sfts.sheets.get(2).toNameArray());
*/
