#!/usr/bin/env node

/**
 * OpenSpec 变更分级自动判定工具
 *
 * 根据 proposal.md 和 design.md 的内容，自动判定变更等级（L0/L1/L2/L3）
 * 并给出建议跑的评审维度和预计耗时。
 *
 * 使用方法：
 *   node scripts/classify-change.js <change-name>
 *   或：openspec classify-change <change-name>
 */

const fs = require('fs');
const path = require('path');

// 分级规则定义
const RULES = {
  L0: [
    { pattern: /纯文案|文案修正|文案调整/i, weight: 1.0, desc: '纯文案修改' },
    { pattern: /注释|文档|README/i, weight: 1.0, desc: '注释或文档' },
    { pattern: /日志文案|日志输出/i, weight: 0.9, desc: '日志文案' },
    { pattern: /配置值|配置调整/i, weight: 0.9, desc: '配置值调整' },
    { pattern: /格式化|代码格式/i, weight: 0.8, desc: '代码格式化' },
    { pattern: /依赖.*小版本|升级.*patch/i, weight: 0.7, desc: '依赖小版本升级' },
  ],
  L3: [
    { pattern: /异步|async|await/i, weight: 0.8, desc: '异步处理' },
    { pattern: /MQ|消息队列|RabbitMQ|Kafka|RocketMQ/i, weight: 1.0, desc: 'MQ/消息队列' },
    { pattern: /并发消费|消费者/i, weight: 1.0, desc: '并发消费' },
    { pattern: /批量.*([1-9]\d{4,}|[1-9]\d万)/i, weight: 1.0, desc: '批量操作 ≥1万' },
    { pattern: /新建.*表|CREATE TABLE/i, weight: 1.0, desc: '新建表' },
    { pattern: /ALTER TABLE.*TYPE|改.*字段类型/i, weight: 1.0, desc: '改字段类型' },
    { pattern: /唯一索引|UNIQUE INDEX/i, weight: 0.9, desc: '唯一索引' },
    { pattern: /对外.*接口|公网.*接口|开放.*接口/i, weight: 1.0, desc: '对外开放接口' },
    { pattern: /用户上传|文件上传/i, weight: 0.9, desc: '用户上传' },
    { pattern: /租户隔离|多租户/i, weight: 1.0, desc: '租户隔离' },
    { pattern: /权限判定|权限校验|鉴权/i, weight: 0.9, desc: '权限判定' },
    { pattern: /敏感数据|脱敏|加密/i, weight: 0.9, desc: '敏感数据' },
    { pattern: /分布式.*一致性|分布式事务/i, weight: 1.0, desc: '分布式一致性' },
    { pattern: /状态机/i, weight: 0.9, desc: '状态机' },
    { pattern: /重试|幂等/i, weight: 0.8, desc: '重试/幂等' },
  ],
  L2: [
    { pattern: /跨模块|跨服务/i, weight: 0.9, desc: '跨模块调用' },
    { pattern: /引入.*缓存|Redis|Memcached/i, weight: 0.8, desc: '引入缓存' },
    { pattern: /批量.*\d+/i, weight: 0.6, desc: '批量操作' },
    { pattern: /新增.*业务流程|新增.*流程/i, weight: 0.8, desc: '新增业务流程' },
  ],
  L1: [
    { pattern: /单表.*CRUD|增删改查/i, weight: 0.7, desc: '单表CRUD' },
    { pattern: /新增.*字段|ADD COLUMN/i, weight: 0.6, desc: '新增字段' },
    { pattern: /既有.*扩展|功能扩展/i, weight: 0.6, desc: '既有能力扩展' },
  ],
};

// 维度配置
const DIMENSIONS = {
  L0: [],
  L1: ['database', 'security'],
  L2: ['architecture', 'database', 'security', 'performance'],
  L3: ['architecture', 'concurrency', 'performance', 'database', 'security'],
};

// 预计耗时
const ESTIMATED_TIME = {
  L0: '0 分钟（豁免门禁）',
  L1: '2-4 分钟',
  L2: '3-6 分钟',
  L3: '4-8 分钟',
};

/**
 * 提取关键词和匹配规则
 */
function classifyChange(proposalContent, designContent) {
  const text = (proposalContent + '\n' + designContent).toLowerCase();
  const scores = { L0: 0, L1: 0, L2: 0, L3: 0 };
  const matched = { L0: [], L1: [], L2: [], L3: [] };

  for (const [level, patterns] of Object.entries(RULES)) {
    for (const { pattern, weight, desc } of patterns) {
      if (pattern.test(text)) {
        scores[level] += weight;
        matched[level].push(desc);
      }
    }
  }

  // 判定逻辑：L3 优先（高风险），L0 其次（豁免），然后 L2/L1
  let finalLevel;
  if (scores.L3 >= 1.0) {
    finalLevel = 'L3';
  } else if (scores.L0 >= 1.0) {
    finalLevel = 'L0';
  } else if (scores.L2 >= 0.8) {
    finalLevel = 'L2';
  } else {
    finalLevel = 'L1';
  }

  return {
    level: finalLevel,
    scores,
    matched,
    dimensions: DIMENSIONS[finalLevel],
    estimatedTime: ESTIMATED_TIME[finalLevel],
  };
}

/**
 * 格式化输出
 */
function formatOutput(changeName, result) {
  const { level, scores, matched, dimensions, estimatedTime } = result;

  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log(`│  变更：${changeName.padEnd(48)} │`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  变更类型：${level}                                        │`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log('│  判定依据：                                              │');

  // 显示匹配到的规则
  for (const [lvl, items] of Object.entries(matched)) {
    if (items.length > 0) {
      const symbol = lvl === level ? '✓' : '○';
      console.log(`│    ${symbol} ${lvl}: ${items.slice(0, 2).join(', ').padEnd(45)} │`);
    }
  }

  console.log('├─────────────────────────────────────────────────────────┤');

  if (level === 'L0') {
    console.log('│  门禁要求：跳过门禁，直接 apply                          │');
    console.log('│                                                         │');
    console.log('│  ⚠️  注意：需在 review-summary.md 记录豁免理由并签字     │');
  } else {
    console.log('│  建议跑的维度：                                          │');
    const dimText = dimensions.join(' + ');
    console.log(`│    ${dimText.padEnd(53)} │`);
    console.log('│                                                         │');
    console.log(`│  预计耗时：${estimatedTime.padEnd(44)} │`);
  }

  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('\n💡 提示：拿不准就升一级。漏评审的代价远高于多跑一个维度。\n');

  // 如果分数接近边界，给出提示
  if (level === 'L2' && scores.L3 >= 0.7) {
    console.log('⚠️  警告：接近 L3 阈值，建议人工复核是否需要升级到 L3。\n');
  }
  if (level === 'L1' && scores.L2 >= 0.6) {
    console.log('⚠️  警告：接近 L2 阈值，建议人工复核是否需要升级到 L2。\n');
  }
}

/**
 * 主函数
 */
function main() {
  const changeName = process.argv[2];

  if (!changeName) {
    console.error('用法: node classify-change.js <change-name>');
    console.error('示例: node classify-change.js add-user-nickname');
    process.exit(1);
  }

  // 查找 openspec 根目录
  let openspecRoot = path.join(process.cwd(), 'openspec');
  if (!fs.existsSync(openspecRoot)) {
    console.error('错误：当前目录下未找到 openspec/ 目录');
    console.error('请在项目根目录运行此命令');
    process.exit(1);
  }

  // 读取 proposal.md 和 design.md
  const changeDir = path.join(openspecRoot, 'changes', changeName);
  const proposalPath = path.join(changeDir, 'proposal.md');
  const designPath = path.join(changeDir, 'design.md');

  if (!fs.existsSync(changeDir)) {
    console.error(`错误：变更目录不存在: ${changeDir}`);
    console.error('请先运行 /opsx:explore 创建变更');
    process.exit(1);
  }

  let proposalContent = '';
  let designContent = '';

  if (fs.existsSync(proposalPath)) {
    proposalContent = fs.readFileSync(proposalPath, 'utf-8');
  } else {
    console.warn('⚠️  警告：未找到 proposal.md，分级准确度可能降低');
  }

  if (fs.existsSync(designPath)) {
    designContent = fs.readFileSync(designPath, 'utf-8');
  } else {
    console.warn('⚠️  警告：未找到 design.md，分级准确度可能降低');
  }

  if (!proposalContent && !designContent) {
    console.error('错误：proposal.md 和 design.md 均不存在');
    console.error('请先运行 /opsx:explore 完成需求澄清和方案设计');
    process.exit(1);
  }

  // 执行分类
  const result = classifyChange(proposalContent, designContent);

  // 输出结果
  formatOutput(changeName, result);

  // 保存结果到文件（供其他脚本使用）
  const resultPath = path.join(changeDir, '.classification.json');
  fs.writeFileSync(
    resultPath,
    JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2)
  );
  console.log(`📄 分级结果已保存到: ${resultPath}\n`);
}

// 运行
if (require.main === module) {
  main();
}

module.exports = { classifyChange, RULES, DIMENSIONS };
