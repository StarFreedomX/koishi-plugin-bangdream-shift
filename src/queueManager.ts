import { Context, Logger } from 'koishi';
import Bottleneck from "bottleneck";
import { Config } from "./index";

export interface PendingShift {
    userName: string;
    dayIndex: number;
    slot?: { start: number; end: number; action: string };
    shiftId: number;
    last: boolean;
    timestamp: number;
    rootId?: string;
    childIds?: string[];
    sourceMessageId?: string;
    targetChannelId?: string;
    rootContent?: string;
}

export class QueueManager {
    public pendingShifts = new Map<string, PendingShift>();
    public latestVersionMap = new Map<string, number>();
    private limiterGroup: Bottleneck.Group;
    private logger: Logger;
    private maxRetryCounts = 3;
    private guardTokenMap = new Map<string, number>();

    constructor(private ctx: Context, cfg: Config) {
        this.logger = ctx.logger('shift-queue');
        this.maxRetryCounts = cfg.limiter.maxRetryCounts;
        this.limiterGroup = new Bottleneck.Group({
            minTime: 400,
            maxConcurrent: 2,
            timeout: 1000 * 60 * 5,
            ...cfg.limiter,
        });
        this.initDisposeHook();
    }

    private initDisposeHook() {
        this.ctx.on('dispose', async () => {
            this.logger.info('[Limiter] 插件停用，清理队列...');
            const pairs = this.limiterGroup.limiters();
            await Promise.all(pairs.map(async ({ key, limiter }) => {
                try {
                    await limiter.stop({
                        dropWaitingJobs: true,
                        dropErrorMessage: `Plugin disposed: channel ${key}`,
                    });
                } catch {}
            }));
            this.latestVersionMap.clear();
        });
    }

    private isDisposedError(e: any): boolean {
        const msg = e?.message?.toLowerCase() || '';
        if (msg.includes('plugin disposed') || msg.includes('context disposed')) return true;
        if (e?.errors && Array.isArray(e.errors)) {
            return e.errors.some((subErr: any) => this.isDisposedError(subErr));
        }
        return false;
    }

    updateGuard(guardKey: string) {
        const current = this.guardTokenMap.get(guardKey) ?? 0;
        this.guardTokenMap.set(guardKey, current + 1);
    }

    /**
     * 入队函数：内置 429 解析与重试逻辑
     */
    async addTaskToQueue(
        queueKey: string,
        task: () => Promise<any>,
        idOrOptions?: string | {
            id?: string;
            guardKey?: string;
            onUndo?: (result: any[]) => Promise<void> | void
        }
    ) {
        const options = typeof idOrOptions === 'string' ? { id: idOrOptions } : (idOrOptions || {});
        const { id, guardKey, onUndo } = options;
        // 这里获取guardToken的快照，确保在任务执行过程中guardKey如果发生变化（如被update），可以正确识别并触发撤销逻辑
        const guardToken = guardKey ? (this.guardTokenMap.get(guardKey) ?? 0) : 0;
        const limiter = this.limiterGroup.key(queueKey);
        const myVersion = Date.now();
        if (id?.startsWith('CHECK-')) {
            this.latestVersionMap.set(id, myVersion);
        }

        return limiter.schedule({ id }, async () => {
            let retryCount = 0;

            const executeWithRetry = async (): Promise<any[]> => {
                // guardKey 变更则取消本次任务
                if (guardKey && (this.guardTokenMap.get(guardKey) ?? 0) !== guardToken) {
                    return [null];
                }
                // 版本合法性检查
                if (id?.startsWith('CHECK-')) {
                    if (this.latestVersionMap.get(id) !== myVersion) {
                        return [null];
                    }
                }

                try {
                    // 调用平台 API 发送消息
                    const rawResult = await task();
                    const result = Array.isArray(rawResult) ? rawResult : [rawResult ?? null];

                    // 后置校验
                    if (guardKey && (this.guardTokenMap.get(guardKey) ?? 0) !== guardToken) {
                        if (onUndo) {
                            // 异步执行撤销
                            this.logger.info(`[Guard] 任务 ${id} 执行期间 key 失效，触发撤销回调...`);
                            void Promise.resolve(onUndo(result)).catch((e) => {
                                this.logger.error(`[Guard] 任务 ${id} 撤销回调执行失败:`, e);
                            });
                        }
                        return [null];
                    }

                    return result;
                } catch (err: any) {
                    // 插件销毁直接退出
                    if (this.isDisposedError(err)) return [null];

                    // 检查是否重试 (针对 429)
                    if (retryCount < this.maxRetryCounts) {
                        const errorMsg = err.message || '';
                        let waitMs = 300;

                        if (errorMsg.includes('429')) {
                            try {
                                const jsonMatch = errorMsg.match(/\{.*}/);
                                if (jsonMatch) {
                                    const data = JSON.parse(jsonMatch[0]);
                                    waitMs = Math.ceil((data.retry_after || 0.3) * 1000);
                                }
                            } catch {}
                        }

                        retryCount++;
                        const finalWait = waitMs + retryCount * 200;
                        this.logger.warn(`[Retry ${retryCount}/${this.maxRetryCounts}] 任务 ${id} 失败: ${errorMsg}. ${finalWait}ms 后重试...`);

                        await new Promise(resolve => setTimeout(resolve, finalWait));
                        return executeWithRetry(); // 递归重试
                    }

                    // 失败
                    throw err;
                }
            };

            return executeWithRetry();
        });
    }
}
