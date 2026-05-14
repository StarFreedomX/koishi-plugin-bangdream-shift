# koishi-plugin-bangdream-shift

[![npm](https://img.shields.io/npm/v/koishi-plugin-bangdream-shift?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bangdream-shift) [![npm](https://img.shields.io/npm/l/koishi-plugin-bangdream-shift?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bangdream-shift) [![npm](https://img.shields.io/npm/dt/koishi-plugin-bangdream-shift?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bangdream-shift)

本插件为 **Koishi** 作为框架的 **BanG Dream! 班表管理系统** 与 **车速定时推送功能**。

## 🌟 核心特性

- **可视化班表**：自动生成 HTML 渲染图，支持状态颜色标记。
- **Google Sheets 同步**：支持将本地班表实时推送至谷歌表格，实现跨平台协作。
- **智能填班**：指令填班和自动识别填班，通过简写或自然语言快速占坑。
- **多群共享**：支持多个群聊绑定同一份班表，数据实时同步。
- **车速推送**：对接 Tsugu 后端，定时监控活动时速与各顺位分数线。

## 注意事项

* 本项目某些功能需要部署
  [StarFreedomX的tsugu后端](https://github.com/StarFreedomX/tsugu-bangdream-bot/tree/starfx-main)
  才可正常运行

### TODO LIST

* 根据活动时间自动初始化(spawn-shift \<event\> \[server\])

---

# 📅 班表功能

---

## 📊 Google Sheets 同步配置

插件支持通过 Google Sheets API 将排班数据同步到云端表格，方便手机端或 Web 端协同查看。

### 1. 准备工作
1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 进入`API和服务`。
2. 启用 **Google Sheets API**。
3. 创建 **服务账号 (Service Account)**，生成并下载 **JSON 密钥文件**。
4. 打开你的 Google Sheet 表格，点击“共享”，将服务账号的 `client_email` 添加为“编辑者”。

### 2. 配置参数
在 Koishi 控制台中配置以下内容：

| 配置项            | 说明                                     |
|:---------------|:---------------------------------------|
| `client_email` | 服务账号 JSON 中的 `client_email`。           |
| `private_key`  | 服务账号 JSON 中的 `private_key`（需包含完整证书内容）。 |

---

## 🤖 自动填班流水线 (Auto Recognize & Shift)

这是本插件的核心自动化功能。它允许runner在指定的“班表频道”直接发送自然语言或简单时间段，由机器人自动抓取并推送到“管理频道”进行审核。

### 1. 运行流程
1. **监听 (Listen)**：机器人持续监听已绑定的 `shift-channel`（班表频道）。
2. **拆解 (Split)**：当runner发送如 “1-3 5-7” 时，机器人会根据正则自动拆分成多个独立的时间段消息。
3. **推送 (Forward)**：这些时间段会伴随原始消息的引用，被发送到 `manager-channel`（管理频道）。
4. **审核与修正 (Audit & Edit)**：
    - **快捷修正**：管理员可以直接 **回复** 机器人发出的某条子消息来修改其 **用户名、天数或时间段**。
    - **批量修正**：回复“根消息”（引用原话的那条）可以批量修改该组内所有时段的用户名或天数。
    > 若输入数字，则默认修改天数；若输入hh-hh的格式，则默认修改时间段；否则视为用户名。
5. **确认 (Confirm)**：
    - 管理员点击消息下方的表情：👍 (新增)、👎 (删除)、🙌 (跳过)。
    - 只有当一组内所有消息都已标记状态后，点击 ✅ 才会统一写入数据库并同步至 Google Sheets(若有配置)。

### 2. 相关指令
- `ls-channels`：列出当前班表绑定的所有班表频道（按天数排序）及管理频道。
- `set-shift-channel <day> <channel>`：绑定一个频道为第 N 天的报班专用频道。
- `set-manager-channel <channel>`：设置审核消息推送的目标频道。

---

## 1. 📅 班表管理（Shift System）

提供一套功能完整、可视化、可多群共享的排班系统。

### 🔨 班表基础功能

- **创建班表（create-shift）**
    - 指定开始时间与结束时间，自动按小时对齐
    - 自动生成内部 ShiftTable 数据结构
    - 自动切换到该新创建的表
    - 创建班表时Google Sheet相关独立参数 (数据库持久化)
      > 以下参数在创建班表实例（`create-shift`）时指定，并存储于数据库中，**每个班表可拥有不同的表格配置**：
      > - **spreadsheetId**: 目标谷歌表格的唯一 ID。
      > - **startCell**: 班表在 Sheets 中起始的单元格位置（如 `A1`）。
      > - **colInterval**: 渲染时每一列数据之间的间隔列数（用于留白）。
      > - **rowInterval**: 每一行（小时）之间的间隔行数。

- **切换班表（switch-shift）**
    - 每个群可以绑定多个班表
    - 通过切换来决定当前群使用哪一张班表

- **删除班表（remove-shift）**
    - 仅班表拥有者（owner）可执行
    - 删除班表并清除所有关联记录

- **列出班表（ls-shift）**
    - 显示该群已绑定的所有班表
    - 正在使用的班表会标注 `*`

---

## 2. 👥 排班操作

### ➕ 添加排班（add-shift）

- 为指定玩家在某天的某一时间段添加排班
- 自动检查冲突
- 自动持久化保存

### ➕ 一句话添加排班（add-shift-once）

示例: `add-shift-once 1 Alice 15-19 20-23 Bob 17-20 Ohashi Ayaka 15-24`

格式要求:
- 第一个参数为day
- 第二个参数为text文本，时间段格式**必须**为` hh-hh `格式，前后有空格（边界除外）
- 支持空格人名，某些包含`hh-hh`的人名
- **不支持**玩家名字内包含` hh-hh `（即合法小时时段前后都带空格/在边界）

- 为指定玩家在某天的某一时间段添加排班
- 自动检查冲突
- 自动持久化保存

### ➖ 删除排班（del-shift）

- 删除玩家在某天特定时段的班次

### 🔁 替换排班（exchange-shift）

- 将某一玩家的排班整体替换为另一名玩家

### ✏️ 改名（rename-person）

- 修改所有相关排班中的名字

---

## 3. 🎨 班表查询

### 🖼️ show-shift

- 返回指定天的班表
- 使用 puppeteer 截图
- 返回为表格图片

### 🖼️ show-shift-exchange

- 返回指定天的交换表
- 使用 puppeteer 截图
- 返回为表格图片

### 🖼️ show-shift-left

- 显示 **每个小时缺多少人**
- 自动将结果汇总为连续范围（如 `0-5 @2`）

---

## 4. 🎨 颜色标记

提供多个时段颜色：

- `none`（无色）
- `gray`（灰色）
- `black`（黑色）
- `invalid`（不可用）

---

## 5. 👑 目标顺位管理

### ✔ 设置排名（set-runner）

可设置玩家为：

- main
- 10↑
- 50↑
- 100↑
- 1000↑

### ❌ 删除排名（del-runner）

---

## 6. 🔗 班表多群共享

### 📤 share-shift

- 将班表授权给其他群使用
- 可以跨群共享同一张班表

### 📑 shift-group-ls

- 查看所有拥有权限的群及其是否正在使用该班表

### 🗑 revoke-shift

- 取消某个群对班表的管理权限

> 【注意】只有班表 owner 才能进行共享和撤销。

---

## 7. ⚙ 班表结构管理

### ⏱ 调整班表结束时间（set-shift-ending）

- 调整班表天数
- 自动扩展 / 收缩天数
- 自动维护 invalid 区域

---

# 🚗 车速定时推送功能

## 📡 interval-speed-on

- 开启自动车速查询
- 支持跟踪服务器
- 支持比对指定玩家
- 自动定时推送结果到当前频道

## 📴 interval-speed-off

- 关闭定时推送

---

# 📁 数据存储

本插件使用 Koishi 原生数据库存储：

- 班表主体（bangdream_shift）
- 群绑定信息（bangdream_shift_group）
- 车速推送配置（bangdream_speed_tracker）

所有信息会自动持久化，无需额外操作。

# 鸣谢

- 感谢[Kanade](https://github.com/KanadeVgc)提供的繁中本地化翻译

| 版本               | 更新日志                     |
|------------------|--------------------------|
| `0.0.1`          | 加入定时查询车速功能               |
| `0.0.2`          | 更新，添加回应消息                |
| `0.0.3`          | 修复推送时空数组仍判断为已开启的bug      |
| `0.0.4`          | 完善班表逻辑，修复定时推送间隔问题        |
| `1.0.0`          | 实现绝大多数基本的班表管理            |
| `1.0.1`          | 本地化文本及翻译                 |
| `1.0.2`          | 更好的函数名，更好的班表颜色           |
| `1.0.3`          | discord适配器视作开发依赖         |
| `1.0.4`          | 修复discord管理权限判断问题        |
| `1.1.0`          | 优化命令和数据字段名,添加Logger      |
| `1.1.1`          | 修复着色逻辑中跳过非none导致无法恢复的bug |
| `1.1.1`          | 涂色指令添加day提示              |
| `1.2.0`          | 优化管理判断，新增繁中翻译            |
| `1.2.1`          | 重构代码,discord权限码使用BigInt  |
| `1.2.2`          | normalizeHour裁切          |
| `1.2.3`          | set-shift-color返回实际操作时间  |
| `1.3.0`          | 添加add-shift-once         |
| `1.3.1`          | 对齐返回文本                   |
| `1.4.0`          | 接入谷歌表格，实现自动识别填班          |
| `2.0.0-alpha.0`  | 优化传参格式，支持识别黑/灰           |
| `2.0.0-alpha.1`  | 优化填班识别和表示，支持编辑识别结果       |
| `2.0.0-alpha.2`  | 引用消息在时间确认外部              |
| `2.0.0-alpha.3`  | 支持统一编辑关联确认消息             |
| `2.0.0-alpha.4`  | list频道排序，适配dc消息          |
| `2.0.0-alpha.5`  | 通过回复直接编辑                 |
| `2.0.0-alpha.6`  | 引入队列控制                   |
| `2.0.0-alpha.7`  | 旧数据结构恢复                  |
| `2.0.0-alpha.8`  | 修复无法回复根消息进行编辑的bug        |
| `2.0.0-alpha.9`  | 修复队列异常重试逻辑&重构代码          |
| `2.0.0-alpha.10` | 3次强制提交逻辑                 |
| `2.0.0-alpha.11` | 单元格颜色bug修复，新增换班播报        |
| `2.0.0-alpha.12` | 修复班表人员名字识别(nick)         |


