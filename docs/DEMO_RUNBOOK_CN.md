# COMP6452 Task 3 展示 Runbook

## 1. 推荐展示入口

在演示前 10 分钟执行：

```bash
cd /Users/jason/comp6452-proj2/application
./showcase.sh --fast --no-open --exit
```

该命令用于彩排和健康检查：检查 Fabric 容器、读取当前区块高度、启动全新的事件索引、跑完整业务故事、验证 HTTP read model，然后自动清理 indexer。

正式展示执行：

```bash
cd /Users/jason/comp6452-proj2/application
./showcase.sh
```

它会自动打开 `docs/animation.html` 全屏动画，随后在终端运行 7 个 Act。动画右上角 **Data view** 进入实时数据页；展示结束按 `Ctrl-C`。

## 2. 屏幕布局

- 左侧或主屏：浏览器打开 `docs/animation.html`；空格暂停，左右键切换场景，`F` 全屏。
- 右侧或副屏：终端，字号至少 18pt，执行 `./showcase.sh`。
- 终端高度尽量拉满；不要现场输入逐条 Fabric 命令。
- Demo 结束后点动画右上角 **Data view**，点击 **Refresh**，再打开本次批次 history。

## 3. 五分钟 Demo 节奏与英文讲稿

### 0:00–0:25 — 团队分工 + 一句话架构

动画从 Scene 01 的四人协作开场；需要快速总览时按右方向键跳到 Scene 06 **Integration**：

> Yan owned the registry, Hu compliance, Lin the off-chain services, and Huang client and network integration. Together, two smart contracts enforce shared policy while large and private data stays off chain.

### 0:25–1:05 — Act 1：注册、私有数据、链下存储

切到终端，让脚本展示 `producer1` 注册批次。

> The producer signs with a Fabric CA identity. Public provenance goes to the ledger, commercial fields enter a private data collection through the transient map, and the inspection report stays off chain with only its SHA-256 anchor on chain.

指出两行证据：

- `status CREATED / held by Org1MSP`
- `fetched ... and re-hashed it: MATCHES the anchor`

### 1:05–1:40 — Act 2–3：权限与跨组织交接

> This rejection is expected. The transporter cannot forge the producer role because the role is signed into its enrolment certificate. Custody is then transferred from Org1MSP to Org2MSP, and the former holder is rejected if it tries to move the batch again.

指出 `REJECTED BY THE NETWORK`，不要把它解释成错误。

### 1:40–2:15 — Act 4：完整正常状态机

> A second batch demonstrates the happy path: CREATED, IN_TRANSIT, AT_WAREHOUSE and DELIVERED. MarkDelivered is holder-gated and legal only from AT_WAREHOUSE.

指出最终 `status DELIVERED`。

### 2:15–3:10 — Act 5：Oracle 与跨链码自动标记

> The oracle performs the heavy aggregation off chain. The first window is within the zero-to-four-degree range; the next three breach it. At the third consecutive breach, coldchain-compliance invokes batch-registry atomically and flags the batch without a human transaction.

必须指出三项评分证据：

1. `raw series stored ...`：链下存储；
2. `submitted 4 window summaries`：链下计算 + Oracle；
3. `status FLAGGED`：`coldchain-compliance -> batch-registry:FlagBatch`。

### 3:10–4:00 — Act 6：不可篡改溯源与召回

> The regulator reads every committed version oldest first, together with the sensor evidence and breach counter. The regulator then recalls the flagged batch; RECALLED is terminal in the on-chain state machine.

指出状态序列和最终 `RECALLED`。

### 4:00–4:35 — Act 7：两层召回级联

> Real inventory is split and repacked. We record that derivation graph. Recalling only the pallet causes the compliance contract to traverse the graph and recall the case and the pack two levels downstream.

指出 `recalled 3 batch(es)`，这是第二个合约的核心业务逻辑，不只是数据存储。

### 4:35–5:00 — Live indexer 收尾

回到 Dashboard，点击 **Refresh** 和本次批次 history：

> Finally, chaincode events are projected into an off-chain read model. This query does not scan the ledger; the response includes X-Query-Time-Ms and is served from the in-memory index backed by an append-only JSONL store.

收尾一句：

> The blockchain is used only for shared truth and policy enforcement; large data and read optimisation remain off chain.

## 4. 三分钟 Code Walkthrough

只打开以下四处，不要遍历整个仓库：

1. `chaincode/batch-registry/src/batchRegistry.ts`
   - `RegisterBatch`：FR1、ABAC、transient private data、状态初始化。
   - `TransferCustody` / `MarkDelivered`：holder 权限与状态机。
   - `FlagBatch`：接收人工或 Oracle 自动路径。
2. `chaincode/coldchain-compliance/src/compliance.ts`
   - `SubmitTemperatureReading`：Oracle 身份、连续三次超限、跨链码调用。
   - `RecallBatch`：派生批次级联。
3. `offchain/oracle-service/src/`
   - 原始温度聚合、raw series 存储、SHA-256 anchor、提交摘要。
4. `offchain/indexer/src/listen.ts` 与 `server.ts`
   - 两个 chaincode event stream、独立 checkpoint、去重、`X-Query-Time-Ms`。

建议讲解分配：每人 35–45 秒，只讲自己负责的组件和一个测试。

## 5. 展示前检查表

- [ ] 电源接入，关闭系统通知与自动锁屏。
- [ ] Docker 的五个关键容器处于 Running。
- [ ] `./showcase.sh --fast --no-open --exit` 当天至少成功一次。
- [ ] 浏览器缩放 90%–100%，终端字号至少 18pt。
- [ ] 不运行 `network.sh down/up`，不在进场后重新部署 chaincode。
- [ ] 确认端口 3001 没有被其他程序占用。
- [ ] 记住预期拒绝是安全控制证据，不是 Demo 失败。

## 6. 现场故障回退

每次 launcher 都会输出 runtime 目录，包含：

- `demo.log`：完整成功/失败步骤；
- `indexer.log`：event stream 与 API 日志；
- `history.json`：本次批次的链下 read model。

网络问题时可先展示静态 Dashboard 的架构、状态机和 336 个单元测试结果，再打开最近一次成功的 `demo.log`。不要在 5 分钟展示窗口内重建 Fabric 网络。
