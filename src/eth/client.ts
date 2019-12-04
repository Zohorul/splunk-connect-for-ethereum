import { EthereumTransport } from './transport';
import { createJsonRpcPayload, checkError, JsonRpcError, JsonRpcRequest } from './jsonrpc';
import { EthRequest } from './requests';
import { createModuleDebug } from '../utils/debug';
import { sleep } from '../utils/async';

const { debug, error } = createModuleDebug('eth:client');

interface BatchReq<P extends any[] = any[], R = any> {
    request: EthRequest<P, R>;
    callback: (error: Error | null, result: R) => void;
}

export async function executeBatchRequest(batch: BatchReq[], transport: EthereumTransport) {
    debug('Processing batch of %d JSON RPC requests', batch.length);
    try {
        const items = new Map<number, BatchReq>();
        const reqs: JsonRpcRequest[] = [];
        for (const batchItem of batch) {
            const req = createJsonRpcPayload(batchItem.request.method, batchItem.request.params);
            reqs.push(req);
            items.set(req.id, batchItem);
        }
        const results = await transport.sendBatch(reqs);
        for (const result of results) {
            const batchItem = items.get(result.id);
            if (batchItem == null) {
                error(`Found unassociated batch item in batch response`);
                continue;
            }
            batchItem.callback(null, result);
            items.delete(result.id);
        }
        if (items.size > 0) {
            error(`Unprocessed batch request after receiving results`);
            for (const unprocessed of items.values()) {
                unprocessed.callback(new Error('Result missing from batch response'), null);
            }
        }
    } catch (e) {
        batch.forEach(({ callback }) => callback(e, null));
    }
}

export class EthereumClient {
    constructor(protected transport: EthereumTransport) {}

    async request<P extends any[], R>(req: EthRequest<P, R>): Promise<R> {
        const payload = createJsonRpcPayload(req.method, req.params);
        const res = await this.transport.send(payload);
        if (payload.id !== res.id) {
            throw new JsonRpcError(`JSON RPC Response ID mismatch. Expected ${payload.id} but got ${res.id}`);
        }
        checkError(res);
        return req.response(res);
    }

    async requestBatch<P extends any[], R>(reqs: EthRequest<P, R>[]): Promise<R[]> {
        const batchReqs: BatchReq[] = [];
        const promises = [];
        for (const request of reqs) {
            promises.push(
                new Promise<R>((resolve, reject) => {
                    batchReqs.push({
                        request,
                        callback: (e, result) => {
                            if (e) {
                                reject(e);
                            }
                            try {
                                checkError(result);
                                resolve(request.response(result));
                            } catch (e) {
                                reject(e);
                            }
                        },
                    });
                })
            );
        }
        await sleep(0);
        await executeBatchRequest(batchReqs, this.transport);
        return await Promise.all(promises);
    }
}

export interface BatchedEthereumClientConfig {
    maxBatchTime: number;
    maxBatchSize: number;
}

export class BatchedEthereumClient extends EthereumClient {
    private config: BatchedEthereumClientConfig;
    private queue: BatchReq<any[], any>[] = [];
    private flushTimer: NodeJS.Timer | null = null;
    constructor(transport: EthereumTransport, config: BatchedEthereumClientConfig) {
        super(transport);
        this.config = config;
    }

    request<P extends any[], R>(
        req: EthRequest<P, R>,
        { immediate = false }: { immediate?: boolean } = {}
    ): Promise<R> {
        if (immediate) {
            return super.request(req);
        }

        return new Promise((resolve, reject) => {
            this.queue.push({
                request: req,
                callback: (e, result) => {
                    if (e) {
                        reject(e);
                    }
                    try {
                        checkError(result);
                        resolve(req.response(result));
                    } catch (e) {
                        reject(e);
                    }
                },
            });
            this.scheduleFlush();
        });
    }

    private processQueue = async () => {
        if (this.flushTimer != null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.queue.length === 0) {
            return;
        }
        const batch = this.queue;
        this.queue = [];
        return await executeBatchRequest(batch, this.transport);
    };

    private scheduleFlush() {
        if (this.queue.length >= this.config.maxBatchSize) {
            this.processQueue();
            return;
        }
        if (this.flushTimer == null) {
            this.flushTimer = setTimeout(this.processQueue, this.config.maxBatchTime);
        }
    }
}