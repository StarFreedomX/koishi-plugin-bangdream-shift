# koishi-plugin-bangdream-shift

[![npm](https://img.shields.io/npm/v/koishi-plugin-bangdream-shift?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bangdream-shift)

本插件为 **Koishi** 作为框架的 **BanG Dream! 班表管理系统** 与 **车速定时推送功能**。

## 注意事项

* 本项目某些功能需要部署StarFreedomX的tsugu后端才可正常运行

---

# 📅 班表功能

## 1. 📅 班表管理（Shift System）

提供一套功能完整、可视化、可多群共享的排班系统。

### 🔨 班表基础功能

- **创建班表（create-shift）**
    - 指定开始时间与结束时间，自动按小时对齐
    - 自动生成内部 ShiftTable 数据结构
    - 自动切换到该新创建的表

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

可用于标记：

- 休息时间
- 清cp时间
- ...

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


| 版本      | 更新日志                |
|---------|---------------------|
| `0.0.1` | 加入定时查询车速功能          |
| `0.0.2` | 更新，添加回应消息           |
| `0.0.3` | 修复推送时空数组仍判断为已开启的bug |
| `0.0.4` | 完善班表逻辑，修复定时推送间隔问题   |
| `1.0.0` | 实现绝大多数基本的班表管理       |
| `1.0.1` | 本地化文本及翻译            |
| `1.0.2` | 更好的函数名，更好的班表颜色      |
| `1.0.3` | discord适配器视作开发依赖    |
| `1.0.4` | 修复discord管理权限判断问题   |
| `1.1.0` | 优化命令和数据字段名,添加Logger |
