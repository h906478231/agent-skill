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

输出格式：
\`\`\`json
{
    "valid": true,
    "errors": [],
    "correctedData": { ... }
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

**必须使用的标准模板**：
文件路径：skills/ddd-event-storm-visualizer/template-v1.0.0.html

**建模数据**：
${validationResult}

**生成步骤**：
1. 读取标准模板文件 \`skills/ddd-event-storm-visualizer/template-v1.0.0.html\`
2. 替换占位符：
   - \`{{DOMAIN_NAME}}\` → "${scope}"
   - \`{{MODEL_DATA}}\` → 从 validationResult 中提取的 correctedData（如果 valid 为 true）
3. 输出完整的 HTML

**关键要求**：
- 必须使用标准模板，不要自己编写 HTML
- 不要修改模板的样式和交互逻辑
- 只替换占位符中的数据
- 确保 MODEL_DATA 是有效的 JSON 对象

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
// 阶段 5: 保存文件
// ============================================
log(`💾 正在保存文件到: ${outputPath}`);

// 使用 Write 工具保存 HTML 文件
const absoluteOutputPath = outputPath;

// 直接保存 HTML 内容
// 注意：在 workflow 中无法直接调用 Write 工具，需要返回内容让调用方保存
// 或者通过 agent 来执行文件写入

const saveResult = await agent(
    `请将以下 HTML 内容保存到文件：${absoluteOutputPath}

HTML 内容：
${htmlContent}

请使用 Write 工具直接保存文件，文件路径使用绝对路径。
保存成功后返回：{"success": true, "path": "${absoluteOutputPath}"}
`,
    {
        label: '保存文件',
        phase: '可视化'
    }
);

log(`✅ 文件已保存: ${absoluteOutputPath}`);

return {
    success: true,
    outputPath: absoluteOutputPath,
    htmlContent: htmlContent,
    summary: {
        scope: scope,
        codePath: codePath,
        docPath: docPath,
        outputPath: absoluteOutputPath,
        phases: [
            '✅ 阶段 1: 业务分析完成',
            '✅ 阶段 2: DDD 建模完成',
            '✅ 阶段 3: 数据校验完成',
            '✅ 阶段 4: 流程图生成完成（使用标准模板 v1.0.0）',
            `✅ 阶段 5: 文件已保存到 ${absoluteOutputPath}`
        ]
    }
};
