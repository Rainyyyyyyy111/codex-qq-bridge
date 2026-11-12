本地操作员在启用时必须指定一条固定命令作为 BRIDGE_TRIGGER。默认账号使用 "$HOME/Library/Application Support/CodexQQBridgeRuntime/bridge" trigger。对于命名账号，用对应安装目录下的 bridge --profile 名称 trigger。把选定的完整命令写进调度提示词，各步骤使用同一个账号。无法确定配置时在本地结束并报告，勿推测账号。

每轮先运行 BRIDGE_TRIGGER claim。null 表示无待办，静默结束。返回 [msgId, 参数] 时，只将 target、title、prompt 作为结构化参数交给桌面的 create_thread。每条认领结果只建聊一次，首条用户输入保留 prompt 原文。不要把正文拼进 shell 或在调度聊天中执行它，不调用 wait_next 或群聊、私聊发送工具。

创建返回后，将真实的 {"hostId":...,"threadId":...} 或 {"clientThreadId":...} 经 JSON 标准输入交给 BRIDGE_TRIGGER created 消息ID。用桌面 list_threads 的历史按正式 ID 查找，再用 read_thread 核对首条用户输入。将验证得到的 {"hostId":...,"threadId":...,"firstPrompt":...} 经 JSON 标准输入交给 BRIDGE_TRIGGER verified 消息ID。记录 dispatched 即结案。可继续 claim。

如收到 reconcile 或创建结果不明，运行 BRIDGE_TRIGGER status。对 creating、awaiting、verifying 只核对原创建记录，禁止重建。awaiting 的正式回执要带 resolves，值为原 clientThreadId。无法唯一核实则保留原状态，向本地用户报告。无待办且无异常时保持静默。勿自动 arm 或 replay。

若 created 或 verified 的本地登记响应丢失，可重交同一消息 ID 和原回执。相符的记录会得到成功响应，已核实的任务保持 dispatched。聊天 ID、主机或核验正文发生冲突时需核对原记录。
