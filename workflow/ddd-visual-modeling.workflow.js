export const meta = {
    name: 'ddd-visual-modeling',
    description: '从 domain-model.md 生成交互式事件风暴流程图（数据与视图分离架构）',
    phases: [
        { title: '读取模型', detail: '读取 domain-model.md' },
        { title: '转换数据', detail: 'Markdown → JSON' },
        { title: '校验修复', detail: '修复聚合字段' },
        { title: '生成输出', detail: '输出 JSON 和模板' }
    ]
};

// 获取参数
const domainModelPath = args?.domainModelPath || 'docs/ddd/domain-model.md';
const outputJsonPath = args?.outputJsonPath || 'ddd-model.json';
const outputHtmlPath = args?.outputHtmlPath || 'event-storm.html';
const scope = args?.scope || '领域模型';
const theme = args?.theme || 'vibrant';

log(`🚀 开始 DDD 可视化生成流程（v2.0.0 - 支持主题切换）`);
log(`📄 领域模型: ${domainModelPath}`);
log(`📊 输出 JSON: ${outputJsonPath}`);
log(`📄 输出 HTML: ${outputHtmlPath}`);
log(`🎨 使用主题: ${theme}`);

// ============================================
// 阶段 1: 读取 domain-model.md
// ============================================
phase('读取模型');

log('正在读取 domain-model.md...');

const readResult = await agent(
    `请使用 Read 工具读取以下文件的完整内容：

文件路径：${domainModelPath}

要求：
1. 使用 Read 工具读取文件
2. 返回文件的完整内容（原样返回，不要添加任何说明）
3. 如果文件不存在，返回 "ERROR: 文件不存在"

开始执行。`,
    {
        label: '读取文件',
        phase: '读取模型'
    }
);

if (!readResult || readResult.includes('ERROR:') || readResult.includes('不存在')) {
    log('❌ 未找到 domain-model.md');
    log('');
    log('💡 提示：');
    log('1. 请先运行 ddd-modeling-workflow 完成领域建模');
    log('2. 确保生成了 domain-model.md 文件');
    log('3. 然后再运行本 workflow 进行可视化');
    log('');
    return {
        success: false,
        error: '未找到 domain-model.md，请先运行 ddd-modeling-workflow 完成建模'
    };
}

const domainModelContent = readResult;
log(`✅ 成功读取 domain-model.md (${domainModelContent.length} 字符)`);

// ============================================
// 阶段 2: Markdown → JSON 转换
// ============================================
phase('转换数据');

log('正在将 Markdown 转换为 JSON...');

const modelDataJson = await agent(
    `你是一个 Markdown 到 JSON 的转换专家。请将以下 domain-model.md 文件转换为标准的 ddd-model.json 格式。

**输入 - domain-model.md 内容**：
${domainModelContent}

**任务**：
1. 解析 Markdown 表格，提取领域事件、领域命令、Policy 和聚合的结构化数据
2. 转换为标准 JSON 格式（对象格式，不是数组）
3. 确保所有引用一致性（命令引用的聚合必须存在、事件 ID 必须存在等）

**解析规则**：

1. **从 "## 1. 领域事件清单" 提取 events**
   - 表格列：编号 | 事件名称 | 类名 | 所属聚合 | 业务含义 | 前置事件
   - 转换为：events 对象（不是数组），键为编号（如 "E1"），值为事件对象

2. **从 "## 2. 领域命令清单" 提取 commands**
   - 表格列：编号 | 命令名称 | 类名 | 触发者 | 目标聚合 | 命令类型 | 前置条件 | 产生事件
   - 转换为：commands 对象（不是数组），键为编号（如 "C1"），值为命令对象
   - **重要**：如果"目标聚合"包含 + 号（如 "MassTask + ImUserDispatchRuntime"），只保留第一个聚合名称（如 "MassTask"）

3. **从 "## 3. Policy 清单" 提取 policies**
   - 表格列：编号 | 策略名称 | 类名 | 监听事件 | 触发命令 | 业务规则描述 | 是否有状态
   - 转换为：policies 对象（不是数组），键为编号（如 "P1"），值为 Policy 对象

4. **从 "## 4. 聚合设计" 提取 aggregates**
   - 解析每个 "### 4.X 聚合：{名称}" 小节
   - 提取：聚合根、聚合 ID、命令-事件映射、内部状态数据、领域服务、不变量
   - 转换为：aggregates 对象（不是数组），键为聚合名称，值为聚合对象

**转换规则**：
- **字符串 → 数组转换**：
  - "E1, E2" → ["E1", "E2"]
  - "E1 / E2" → ["E1", "E2"]
  - "C1" → ["C1"]
  - 监听事件 → listenEvents（复数数组）
  - 触发命令 → triggerCommands（复数数组）
  - 产生事件 → events（数组）

- **聚合字段清理**（重要）：
  - "MassTask + ImUserDispatchRuntime" → "MassTask"（只保留第一个）
  - "Order + Payment" → "Order"（只保留第一个）
  - 去除前后空格

- **字段映射**：
  - 编号 → id
  - 事件名称/命令名称 → name
  - 类名 → className
  - 业务含义 → meaning
  - 所属聚合/目标聚合 → aggregate
  - 触发者 → trigger
  - 前置条件 → precondition
  - 业务规则描述 → rule

**输出格式**（必须严格遵循）：
\`\`\`json
{
    "commands": {
        "C1": {
            "id": "C1",
            "name": "创建订单",
            "className": "CreateOrderCommand",
            "trigger": "用户",
            "input": "商品列表、收货地址",
            "precondition": "商品库存充足",
            "aggregate": "Order",
            "events": ["E1"]
        }
    },
    "events": {
        "E1": {
            "id": "E1",
            "name": "已创建订单",
            "className": "OrderCreatedEvent",
            "meaning": "用户成功下单",
            "aggregate": "Order"
        }
    },
    "aggregates": {
        "Order": {
            "id": "Order",
            "name": "订单",
            "description": "管理订单全生命周期"
        }
    },
    "policies": {
        "P1": {
            "id": "P1",
            "name": "通知发货策略",
            "className": "NotifyShipmentPolicy",
            "listenEvents": ["E2"],
            "triggerCommands": ["C3"],
            "rule": "支付成功后自动通知"
        }
    }
}
\`\`\`

**重要**：
- 直接输出 JSON，不要有任何额外说明
- 必须是对象格式（键值对），不是数组格式
- aggregate 字段如果包含 + 号，只保留第一个聚合名称
- 确保所有引用的 ID 都存在
- 必须使用复数形式：listenEvents、triggerCommands、events（数组）
- 保留所有业务描述字段（meaning、precondition、rule 等）

请开始转换：
`,
    {
        label: 'Markdown → JSON',
        phase: '转换数据'
    }
);

if (!modelDataJson) {
    log('❌ 数据转换失败');
    return { success: false, error: '数据转换失败' };
}

log('✅ 数据转换完成');

// 清理可能的 Markdown 代码块标记
let cleanedJson = modelDataJson.trim();
if (cleanedJson.startsWith('```json')) {
    cleanedJson = cleanedJson.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
} else if (cleanedJson.startsWith('```')) {
    cleanedJson = cleanedJson.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
}

// 解析 JSON 并校验
let modelData;
try {
    modelData = JSON.parse(cleanedJson);

    // 检查是否有错误
    if (modelData.error) {
        log(`❌ 转换错误: ${modelData.error}`);
        return { success: false, error: modelData.error };
    }

    // 校验顶层键
    if (!modelData.commands || !modelData.events || !modelData.aggregates || !modelData.policies) {
        log('❌ JSON 格式错误：缺少顶层键（commands/events/aggregates/policies）');
        return { success: false, error: 'JSON 格式错误' };
    }

    // 校验是否为对象格式
    if (Array.isArray(modelData.commands) || Array.isArray(modelData.events)) {
        log('❌ JSON 格式错误：commands/events 必须是对象格式，不能是数组');
        return { success: false, error: 'JSON 格式错误：使用了数组而非对象' };
    }

    log('✅ JSON 格式校验通过');

} catch (e) {
    log(`❌ JSON 解析失败: ${e.message}`);
    return { success: false, error: 'JSON 解析失败' };
}

// ============================================
// 阶段 3: 校验并修复聚合字段
// ============================================
phase('校验修复');

log('正在校验并修复数据...');

// 检查是否有包含 + 的聚合字段
let needsFix = false;
for (const [id, cmd] of Object.entries(modelData.commands)) {
    if (cmd.aggregate && cmd.aggregate.includes('+')) {
        needsFix = true;
        const firstAggregate = cmd.aggregate.split('+')[0].trim();
        log(`ℹ️  修复 ${id}: "${cmd.aggregate}" → "${firstAggregate}"`);
        cmd.aggregate = firstAggregate;
    }
}

if (needsFix) {
    log('✅ 聚合字段修复完成');
} else {
    log('✅ 聚合字段无需修复');
}

// ============================================
// 阶段 4: 生成输出文件
// ============================================
phase('生成输出');

log('正在生成输出文件...');

// 4.1 格式化 JSON（使用固定时间戳避免不确定性）
const timestamp = args?.timestamp || '2026-08-31T00:00:00.000Z';
const formattedJson = JSON.stringify({
    _meta: {
        generated: timestamp,
        source: domainModelPath,
        version: '2.0.0'
    },
    commands: modelData.commands,
    events: modelData.events,
    aggregates: modelData.aggregates,
    policies: modelData.policies
}, null, 2) + '\n';  // 添加末尾换行符

// 4.2 写入 JSON 文件
const writeJsonResult = await agent(
    `将以下 JSON 内容写入文件 ${outputJsonPath}（覆盖写入）：

${formattedJson}

写入完成后返回 "SUCCESS"。`,
    {
        label: '写入 JSON',
        phase: '生成输出'
    }
);

if (!writeJsonResult || !writeJsonResult.includes('SUCCESS')) {
    log('❌ JSON 文件写入失败');
    return { success: false, error: 'JSON 写入失败' };
}

log(`✅ 已生成 ddd-model.json: ${outputJsonPath}`);

// 4.3 复制主题配置文件
const themesSourcePath = 'skills/ddd-event-storm-visualizer/themes.json';
const themesOutputPath = outputJsonPath.replace(/[^/]+$/, 'themes.json'); // 与 JSON 同目录
const copyThemesResult = await agent(
    `将文件 ${themesSourcePath} 复制到 ${themesOutputPath}。如果目标文件已存在，覆盖它。完成后返回 "SUCCESS"。`,
    {
        label: '复制主题配置',
        phase: '生成输出'
    }
);

if (copyThemesResult && copyThemesResult.includes('SUCCESS')) {
    log(`✅ 已复制主题配置: ${themesOutputPath}`);
} else {
    log(`⚠️  主题配置复制可能失败，将使用内置默认主题`);
}

// 4.4 复制 HTML 模板
const templateSourcePath = 'skills/ddd-event-storm-visualizer/template-v2.0.0.html';
const copyHtmlResult = await agent(
    `将文件 ${templateSourcePath} 复制到 ${outputHtmlPath}。如果目标文件已存在，跳过复制。完成后返回 "SUCCESS" 或 "SKIPPED"（如果已存在）。`,
    {
        label: '复制 HTML',
        phase: '生成输出'
    }
);

if (copyHtmlResult && copyHtmlResult.includes('SKIPPED')) {
    log(`ℹ️  HTML 文件已存在，跳过复制: ${outputHtmlPath}`);
} else if (copyHtmlResult && copyHtmlResult.includes('SUCCESS')) {
    log(`✅ 已复制 HTML 模板: ${outputHtmlPath}`);
} else {
    log(`⚠️  HTML 模板复制可能失败，但不影响主流程`);
}

// ============================================
// 完成
// ============================================
log('');
log('🎉 可视化文件生成完成！');
log('');
log('📊 输出文件：');
log(`  - JSON 数据: ${outputJsonPath}`);
log(`  - 主题配置: ${themesOutputPath}`);
log(`  - HTML 模板: ${outputHtmlPath}`);
log('');
log('📖 使用指引：');
log('1. 确保 JSON、themes.json 和 HTML 在同一目录');
log('2. 使用 HTTP 服务器打开 HTML 文件（不支持 file:// 协议）：');
log('   - VS Code Live Server: 右键点击 HTML → "Open with Live Server"');
log('   - Python: python3 -m http.server');
log('   - Node.js: npx serve');
log('3. HTML 会自动加载同目录下的 ddd-model.json 和 themes.json');
log('4. 修改 domain-model.md → 重新运行本 workflow → 刷新浏览器即可看到更新');
log('');
log('🎨 主题切换：');
log(`  - 当前主题: ${theme}`);
log('  - 可用主题: bootstrap (柔和商务), vibrant (鲜艳展示)');
log('  - 通过 URL 参数切换: ?theme=bootstrap 或 ?theme=vibrant');
log('  - 通过 workflow 参数指定: --args \'{"theme": "vibrant"}\'');
log('');
log('⚡ 性能提升：');
log('  - 旧版本：4 个 agent 调用，30s-2min');
log('  - 新版本：4 个 agent 调用，预计 < 30s');
log('  - 后续迭代：只需刷新浏览器，< 1s');
log('');

return {
    success: true,
    outputJsonPath: outputJsonPath,
    outputHtmlPath: outputHtmlPath,
    stats: {
        commands: Object.keys(modelData.commands).length,
        events: Object.keys(modelData.events).length,
        aggregates: Object.keys(modelData.aggregates).length,
        policies: Object.keys(modelData.policies).length
    },
    summary: {
        scope: scope,
        domainModelPath: domainModelPath,
        phases: [
            '✅ 阶段 1: 读取 domain-model.md 完成',
            '✅ 阶段 2: 数据转换完成',
            '✅ 阶段 3: 聚合字段修复完成',
            '✅ 阶段 4: 输出文件生成完成'
        ]
    }
};
