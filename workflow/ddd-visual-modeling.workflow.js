export const meta = {
    name: 'ddd-visual-modeling',
    description: '从代码和文档生成交互式事件风暴流程图（使用标准模板 v1.0.0）',
    phases: [
        { title: '分析', detail: '提取业务信息' },
        { title: '建模', detail: 'DDD 领域建模' },
        { title: '校验', detail: '数据校验与转换' },
        { title: '可视化', detail: '生成交互式流程图' }
    ]
};

// 获取参数
const codePath = args?.codePath || '.';
const docPath = args?.docPath;
const scope = args?.scope || '业务领域';
const outputPath = args?.outputPath || `event-storm-${scope}.html`;

log(`🚀 开始 DDD 可视化建模流程`);
log(`📂 代码路径: ${codePath}`);
log(`📄 文档路径: ${docPath || '未提供'}`);
log(`🎯 分析范围: ${scope}`);

// ============================================
// 阶段 1: 代码与文档分析
// ============================================
phase('分析');

log('正在分析代码和文档...');

const businessDesc = await agent(
    `你是一个业务分析专家。请分析以下代码和文档，提取业务信息。

代码路径: ${codePath}
文档路径: ${docPath || '无'}
分析范围: ${scope}

请执行以下任务：

1. 扫描代码结构，识别主要的类、方法、依赖关系
2. ${docPath ? '阅读需求文档，提取业务流程和规则' : '从代码中推测业务流程'}
3. 生成统一的业务描述

输出格式：
# 业务需求描述

## 业务背景
[描述业务背景和目标]

## 核心场景
[列出主要的业务场景]

## 业务术语
[提取的业务术语和定义]

## 参与者与外部系统
[识别的参与者和外部系统]

## 业务流程与规则
[详细的业务流程描述]

## 待确认问题
[需要确认的问题]
`,
    {
        label: '业务分析',
        phase: '分析'
    }
);

if (!businessDesc) {
    log('❌ 业务分析失败');
    return { success: false, error: '业务分析失败' };
}

log('✅ 业务分析完成');

// ============================================
// 阶段 2: DDD 建模
// ============================================
phase('建模');

log('正在进行 DDD 建模...');

const modelDataJson = await agent(
    `你是一个 DDD 建模专家。请基于以下业务描述进行 DDD 建模，并输出标准 JSON 格式。

业务描述：
${businessDesc}

请按照 DDD 事件风暴方法进行建模，然后输出为标准 JSON 格式。

**重要：数据结构必须严格遵循以下规范**：

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
            "description": "管理订单全生命周期",
            "entities": ["OrderItem"],
            "valueObjects": ["Address"]
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

**关键规范（必须遵守）**：
1. Policy 必须使用 \`listenEvents\` 和 \`triggerCommands\`（复数，数组形式）
2. Command 的 \`events\` 必须是数组
3. 所有 ID 必须唯一且连续（C1, C2, ... 和 E1, E2, ...）
4. 所有引用的 ID 必须存在（如 Command 引用的 aggregate 必须在 aggregates 中）

请直接输出 JSON，不要有任何额外说明。
`,
    {
        label: 'DDD 建模',
        phase: '建模'
    }
);

if (!modelDataJson) {
    log('❌ DDD 建模失败');
    return { success: false, error: 'DDD 建模失败' };
}

log('✅ DDD 建模完成');

// ============================================
// 阶段 3: 数据校验与转换
// ============================================
phase('校验');

log('正在校验建模数据...');

const validationResult = await agent(
    `你是一个数据校验专家。请校验以下 DDD 建模数据是否符合标准。

建模数据：
${modelDataJson}

校验规则：
1. 完整性：commands/events/aggregates/policies 都存在且不为空
2. 引用一致性：所有引用的 ID 都存在
3. 必填字段：关键字段都已填写
4. **数据格式**：
   - Policy 必须使用 \`listenEvents\` 和 \`triggerCommands\`（复数数组）
   - 不能使用 \`listenEvent\` 或 \`triggerCommand\`（单数）
   - Command 的 \`events\` 必须是数组

如果发现问题，请修正数据并返回修正后的 JSON。

**如果发现以下错误，请自动修正**：
- \`listenEvent: "E1"\` → \`listenEvents: ["E1"]\`
- \`triggerCommand: "C1"\` → \`triggerCommands: ["C1"]\`
- \`events: "E1"\` → \`events: ["E1"]\`

**重要：无论数据是否有错，都必须在 correctedData 字段返回完整的修正后数据（或原数据）。**

输出格式：
\`\`\`json
{
    "valid": true,
    "errors": [],
    "correctedData": {
        "commands": { ... },
        "events": { ... },
        "aggregates": { ... },
        "policies": { ... }
    }
}
\`\`\`

请直接输出 JSON，不要有任何额外说明。
`,
    {
        label: '数据校验',
        phase: '校验'
    }
);

if (!validationResult) {
    log('❌ 数据校验失败');
    return { success: false, error: '数据校验失败' };
}

log('✅ 数据校验完成');

// ============================================
// 阶段 4: 生成交互式流程图（使用标准模板）
// ============================================
phase('可视化');

log('正在生成交互式流程图（使用标准模板 v1.0.0）...');

const htmlContent = await agent(
    `你是一个 HTML 生成专家。请使用标准模板生成交互式事件风暴流程图。

**任务**：
1. 按优先级顺序查找模板文件：
   - 优先：~/.claude/skills/ddd-event-storm-visualizer/template-v1.0.0.html（系统全局）
   - 备选：.claude/skills/ddd-event-storm-visualizer/template-v1.0.0.html（项目本地）
   - 备选：templates/ddd-event-storm-visualizer/template-v1.0.0.html（项目模板目录）
2. 从验证结果中提取 correctedData
3. 替换模板中的占位符并生成完整 HTML

**验证结果**：
${validationResult}

**替换规则**：
1. \`{{DOMAIN_NAME}}\` → "${scope}"
2. \`{{MODEL_DATA}}\` → correctedData 对象（必须是有效的 JSON 对象，不是字符串）

**示例替换**：
\`{{MODEL_DATA}}\` 应该替换为：
\`\`\`javascript
{
    "commands": { "C1": {...}, "C2": {...} },
    "events": { "E1": {...}, "E2": {...} },
    "aggregates": { "Agg1": {...} },
    "policies": { "P1": {...} }
}
\`\`\`

**重要**：
- 按优先级顺序尝试读取模板文件，使用第一个存在的文件
- 只替换占位符，不要修改模板的 HTML/CSS/JavaScript 结构
- {{MODEL_DATA}} 替换为纯 JSON 对象，不要加引号包裹
- 确保生成的 HTML 是完整可运行的
- 如果所有路径都不存在，返回错误信息

请直接输出完整的 HTML 代码，不要有任何额外说明。
`,
    {
        label: '生成 HTML',
        phase: '可视化'
    }
);

if (!htmlContent) {
    log('❌ 流程图生成失败');
    return { success: false, error: '流程图生成失败' };
}

log('✅ 流程图生成完成');

// ============================================
// 保存文件
// ============================================
log(`💾 HTML 内容已生成，建议保存到: ${outputPath}`);

return {
    success: true,
    outputPath: outputPath,
    htmlContent: htmlContent,
    summary: {
        scope: scope,
        codePath: codePath,
        docPath: docPath,
        phases: [
            '✅ 阶段 1: 业务分析完成',
            '✅ 阶段 2: DDD 建模完成',
            '✅ 阶段 3: 数据校验完成',
            '✅ 阶段 4: 流程图生成完成（使用标准模板 v1.0.0）'
        ]
    }
};
